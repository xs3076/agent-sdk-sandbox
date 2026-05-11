# code-review-agent

基于 Claude Agent SDK 的代码评审 Node 服务。对外暴露一个 SSE 接口，由上游（Spring Boot 等）调用，对沙箱内的 git 仓库做只读评审。

- **Provider 无关**：`baseUrl` / `authToken` / `model` 全部由请求体传入，支持 OpenRouter、智谱、Bedrock 等任意 Anthropic-skin 网关。
- **只读**：工具白名单只放行 `Read / Grep / Glob` + `git log/diff/show/blame/status` 等 bash 子命令，从源头杜绝写操作（见 `src/agent.ts:9`）。
- **流式**：SDK 输出原样以 SSE 推到上游，不在 Node 层做任何聚合。

---

## 1. 目录结构

```
.
├── Dockerfile              # node:20-slim + git,编译 TS,运行 dist/server.js
├── docker-compose.yaml     # 单服务部署,挂 ./workspace 到 /workspace
├── .env.example            # 所有可调环境变量样板
├── src/
│   ├── server.ts           # Express 入口,2 个路由
│   ├── agent.ts            # 调 SDK,组装 env,流式推 SSE
│   └── types.ts            # ReviewRequest 类型
├── scripts/                # 调试脚本
└── skills/                 # SDK 通过 settingSources:["project"] 加载
```

---

## 2. 部署

### 2.1 准备

```bash
cp .env.example .env       # 默认值即可,按需调整端口/资源/时区
mkdir -p workspace         # 宿主机上的仓库挂载目录
```

### 2.2 启动

镜像由 GitHub Actions 自动推送到阿里云 ACR(`.github/workflows/deploy.yml`),部署机直接拉:

```bash
docker compose pull        # 拉最新镜像
docker compose up -d
docker compose ps          # 等到 STATUS = healthy
docker compose logs -f agent
```

固定到某次 commit:

```bash
IMAGE_TAG=<git-sha> docker compose up -d
```

本地开发需要现场构建:

```bash
cp docker-compose.override.yaml.example docker-compose.override.yaml
docker compose up -d --build
```

`docker-compose.override.yaml` 已加入 `.gitignore`,不会污染部署。

### 2.3 关键环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | 3000 | 容器内监听端口（同时被 healthcheck 探测） |
| `HOST_PORT` | 3000 | 宿主机映射端口 |
| `WORKSPACE_DIR` | `./workspace` | 宿主机挂载到 `/workspace` 的目录 |
| `CPU_LIMIT` | 2.0 | 容器 CPU 上限 |
| `MEMORY_LIMIT` | 2g | 容器内存上限 |
| `MEMORY_RESERVATION` | 512m | 内存软保留 |
| `LOG_MAX_SIZE` / `LOG_MAX_FILE` | 20m / 5 | 容器日志滚动策略 |
| `TZ` | `Asia/Shanghai` | 时区 |

> **不要** 在 `.env` 里放 `ANTHROPIC_*`：`src/agent.ts` 显式把 `ANTHROPIC_API_KEY` 置空，目的是阻断容器层 env 污染 SDK 的 provider 选择。Provider 只走请求体。

---

## 3. 接口

Base URL：宿主机调用 `http://localhost:${HOST_PORT}`，同 compose 网络其它容器调用 `http://agent:${PORT}`。

### 3.1 GET `/agent/health`

健康检查。Spring Boot 拉起沙箱后轮询此接口确认服务就绪。

| 项 | 值 |
|---|---|
| Method | GET |
| Body | 无 |
| Response | `200 text/plain`，body = `ok` |

```bash
curl -i http://localhost:3000/agent/health
```

### 3.2 POST `/agent/review`

代码评审入口，**SSE 长连接**。

#### 请求

| 项 | 值 |
|---|---|
| Method | POST |
| Content-Type | `application/json` |
| Body 限制 | 1 MB（`express.json({ limit: "1mb" })`） |

请求体（`src/types.ts`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `workDir` | string | ✅ | **容器内**路径，必须是 `/workspace/xxx` 且为 git 仓库 |
| `prompt` | string | ✅ | 本轮 prompt，首轮为评审指令，后续为追问 |
| `baseUrl` | string | ✅ | LLM 网关 base URL |
| `authToken` | string | ✅ | 网关 key 本体，**不要加 `Bearer` 前缀** |
| `model` | string | ✅ | 主模型 ID |
| `smallModel` | string | ❌ | 小模型 ID，省略时与 `model` 相同 |
| `sessionId` | string | ❌ | 多轮对话时填上一轮返回的 session_id |

`baseUrl` 取值示例：

| Provider | baseUrl |
|---|---|
| 智谱 BigModel | `https://open.bigmodel.cn/api/anthropic` |
| OpenRouter | `https://openrouter.ai/api`（**不带 `/v1`**） |
| Anthropic 官方 | `https://api.anthropic.com` |

#### 响应

`200 text/event-stream`，关键响应头：

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no    ← 禁用任何中间代理(nginx/网关)的 buffer
```

**消息流**：每一条 SDK 输出原样作为一行 `data:` 推出。事件类型与 `@anthropic-ai/claude-agent-sdk` 的 `SDKMessage` 一致，常见 `type` 取值：

| `type` | 含义 | 关键字段 |
|---|---|---|
| `system` (`subtype: init`) | 会话初始化 | `session_id`、`tools`、`model` |
| `assistant` | 模型输出（文本 + 工具调用） | `message.content[]` |
| `user` | 工具执行结果回填 | `message.content[]` |
| `result` | 整轮结束的统计 | `total_cost_usd`、`num_turns`、`duration_ms` |

**结束帧**：

```
event: done
data: ok
```

**错误帧**（任意时刻可能出现，出现后流即结束）：

```
event: error
data: {"message":"...","stack":"..."}
```

#### 调用示例（智谱）

```bash
curl -N -X POST http://localhost:3000/agent/review \
  -H "Content-Type: application/json" \
  -d '{
    "workDir": "/workspace/express",
    "prompt": "用中文,基于 git log 最近 5 个提交,挑出最值得 review 的一个,概述其改动并指出潜在问题。",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "authToken": "你的智谱key",
    "model": "glm-4.6",
    "smallModel": "glm-4.5-air"
  }'
```

> `-N` 必须加，否则 curl 会缓冲整个流。

#### 多轮对话

第一轮响应里 `system/init` 帧带有 `session_id`。第二轮把它放进 `sessionId` 字段即可续聊，不需要在调用方拼历史：

```bash
curl -N -X POST http://localhost:3000/agent/review \
  -H "Content-Type: application/json" \
  -d '{
    "workDir": "/workspace/express",
    "sessionId": "上一轮拿到的 session_id",
    "prompt": "针对刚才那个 commit,再用 git blame 看下被改文件的历史。",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "authToken": "你的智谱key",
    "model": "glm-4.6"
  }'
```

#### 客户端断连

`req.on("close")` 已挂载兜底：上游断开后服务端立即 `res.end()`，SDK 子进程清理由 SDK 自身负责（见 `src/server.ts:44`）。

---

## 4. 工具白名单（重要）

只放行下列工具，其它一律拒绝（`src/agent.ts:9`）：

```
Read, Grep, Glob,
Bash(git log:*), Bash(git diff:*), Bash(git show:*),
Bash(git blame:*), Bash(git status:*),
Bash(ls:*), Bash(cat:*), Bash(wc:*), Bash(find:*)
```

**显式不给** `Edit / Write / MultiEdit / NotebookEdit`，从源头杜绝模型对仓库的任何写入。

`maxTurns: 50` 防止 agent 失控烧钱。

---

## 5. 准备一个待评审仓库

`workDir` 必须是容器内能访问的 git 仓库路径。最简单的做法是宿主机克隆到 `./workspace/`：

```bash
git clone --depth=50 https://github.com/expressjs/express.git ./workspace/express
# 容器内对应路径: /workspace/express
```

跨容器/跨主机使用时，`WORKSPACE_DIR` 可指向任意宿主机目录，但容器内挂载点固定为 `/workspace`（与 Dockerfile 一致）。

---

## 6. 排错

| 现象 | 原因 |
|---|---|
| `curl` 一直没输出 | 忘了 `-N`，被 curl 缓冲 |
| 启动后 healthcheck 一直 starting | 容器内 `npm install` 慢/网络问题，看 `docker compose logs agent` |
| `event: error` 401 / invalid_api_key | `authToken` 写成了 `"Bearer xxx"`，只填 key 本体 |
| `event: error` 找不到 model | `model` 名拼错；智谱常见是 `glm-4.6` / `glm-4.5` / `glm-4.5-air`，**不是** `claude-*` |
| `event: error` cwd / .git 不存在 | `workDir` 写了宿主机路径，应是 `/workspace/xxx` |
| 工具调用全被拒 | 越界使用了白名单外的命令，这是设计 |
| 跑很久没动静 | 模型冷启动 / 大仓 grep；看日志确认是否在工具调用循环里 |
| SSE 经过 nginx 被聚合输出 | 服务端已设 `X-Accel-Buffering: no`；nginx 端再加 `proxy_buffering off; proxy_cache off;` |

---

## 7. 本地开发（不走容器）

```bash
npm install
npm run dev          # tsx watch src/server.ts
# 或
npm run build && npm start
```

`PORT` 默认 3000；`workDir` 改成本机真实 git 仓库的绝对路径即可。
