# code-review-agent

基于 Claude Agent SDK 的代码评审 Node 服务。对外暴露一个 SSE 接口,由上游(Spring Boot 等)调用,对沙箱内的 git 仓库做只读评审。

- **Provider 无关**:`baseUrl` / `authToken` / `model` 全部由请求体传入,支持智谱 BigModel、OpenRouter、Bedrock 等任意 Anthropic-skin 网关。
- **只读**:工具白名单只放行 `Read / Grep / Glob` + `git log/diff/show/blame/status` 等 bash 子命令,从源头杜绝写操作(见 `src/agent.ts`)。
- **流式**:SDK 输出原样以 SSE 推到上游,不在 Node 层做任何聚合。
- **启动期烟测**:容器启动时显式解析当前平台的原生 binary、跑 `claude --version` 通过才 `listen`(见 `src/binary.ts`),避免任何"native binary not found"在运行期才暴露。

---

## 1. 目录结构

```
.
├── Dockerfile              # node:20-alpine + git,编译 TS,运行 dist/server.js
├── docker-compose.yaml     # 单服务部署,挂 ./workspace 到 /workspace
├── .env.example            # 所有可调环境变量样板
├── src/
│   ├── server.ts           # Express 入口,2 个路由
│   ├── agent.ts            # 调 SDK,组装 env,流式推 SSE
│   ├── binary.ts           # 启动期解析 + 烟测 claude 原生 binary
│   └── types.ts            # ReviewRequest 类型
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
docker compose pull
docker compose up -d
docker compose ps              # 等到 STATUS = healthy
docker compose logs -f agent
```

固定到某次 commit:

```bash
IMAGE_TAG=<git-sha> docker compose up -d
```

本地开发现场构建:

```bash
cp docker-compose.override.yaml.example docker-compose.override.yaml
docker compose up -d --build
```

`docker-compose.override.yaml` 在 `.gitignore` 中,不污染部署。

### 2.3 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `PORT` | 3000 | 容器内监听端口(同时被 healthcheck 探测) |
| `HOST_PORT` | 3000 | 宿主机映射端口 |
| `WORKSPACE_DIR` | `./workspace` | 宿主机挂载到 `/workspace` 的目录 |
| `CPU_LIMIT` | 2.0 | 容器 CPU 上限 |
| `MEMORY_LIMIT` | 2g | 容器内存上限 |
| `MEMORY_RESERVATION` | 512m | 内存软保留 |
| `LOG_MAX_SIZE` / `LOG_MAX_FILE` | 20m / 5 | 容器日志滚动策略 |
| `TZ` | `Asia/Shanghai` | 时区 |

> **不要** 在 `.env` 里放 `ANTHROPIC_*`:`src/agent.ts` 显式把 `ANTHROPIC_API_KEY` 置空,阻断容器层 env 污染 SDK 的 provider 选择。Provider 只走请求体。

---

## 3. 接口

Base URL:宿主机调用 `http://localhost:${HOST_PORT}`,同 compose 网络其它容器调用 `http://agent:${PORT}`。

### 3.1 GET `/agent/health`

健康检查。Spring Boot 拉起沙箱后轮询此接口确认就绪。

| 项 | 值 |
|---|---|
| Method | GET |
| Response | `200 text/plain`,body = `ok` |

```bash
curl -i http://localhost:3000/agent/health
```

### 3.2 POST `/agent/review`

代码评审入口,**SSE 长连接**。

#### 请求

| 项 | 值 |
|---|---|
| Method | POST |
| Content-Type | `application/json` |
| Body 限制 | 1 MB |

请求体(`src/types.ts`):

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `workDir` | string | ✅ | **容器内**路径,通常 `/workspace/xxx`,需是 git 仓库 |
| `prompt` | string | ✅ | 本轮 prompt,首轮为评审指令,后续为追问 |
| `baseUrl` | string | ✅ | LLM 网关 base URL |
| `authToken` | string | ✅ | 网关 key 本体,**不要加 `Bearer` 前缀** |
| `model` | string | ✅ | 主模型 ID |
| `smallModel` | string | ❌ | 小模型 ID,省略时与 `model` 相同 |
| `sessionId` | string | ❌ | 多轮对话时填上一轮返回的 session_id |

`baseUrl` 示例:

| Provider | baseUrl |
|---|---|
| 智谱 BigModel | `https://open.bigmodel.cn/api/anthropic` |
| OpenRouter | `https://openrouter.ai/api`(**不带 `/v1`**) |
| Anthropic 官方 | `https://api.anthropic.com` |

#### 响应

`200 text/event-stream`,关键响应头:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no    ← 禁用任何中间代理的 buffer
```

**消息流**:第一帧是 `: connected` SSE comment 破冰帧;后续每一条 SDK 输出原样作为一行 `data:` 推出。事件 schema 与 `@anthropic-ai/claude-agent-sdk` 的 `SDKMessage` 一致:

| `type` | 含义 | 关键字段 |
|---|---|---|
| `system` (`subtype: init`) | 会话初始化 | `session_id`、`tools`、`model` |
| `assistant` | 模型输出(文本 + 工具调用) | `message.content[]` |
| `user` | 工具执行结果回填 | `message.content[]` |
| `result` | 整轮结束的统计 | `total_cost_usd`、`num_turns`、`duration_ms` |

中间每 15 秒一帧 `: keepalive` SSE comment 防 idle 超时。

**结束帧**:

```
event: done
data: ok
```

**错误帧**(任意时刻可能出现,出现后流即结束):

```
event: error
data: {"message":"..."}
```

#### 调用示例(智谱)

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

> `-N` 必须加,否则 curl 会缓冲整个流。

#### 多轮对话

第一轮响应里 `system/init` 帧带 `session_id`。第二轮把它放进 `sessionId` 字段即可续聊,不需要在调用方拼历史:

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

`res.on('close')` 触发且 `!res.writableEnded` 时认定为客户端提前断开,服务端调用 `abortController.abort()` 让 SDK 立刻停止迭代并清理子进程(`src/server.ts`),不再烧 token。

> 不要用 `req.on('close')` 做这件事:Node 16+ 把它语义化成"可读流关闭",body 一读完就触发,和"客户端断连"无关,用它做 abort 会让每个请求一进来就把自己 SDK 进程 abort 掉。

---

## 4. 工具白名单

只放行下列工具,其余一律拒绝(`src/agent.ts`):

```
Read, Grep, Glob,
Bash(git log:*), Bash(git diff:*), Bash(git show:*),
Bash(git blame:*), Bash(git status:*),
Bash(ls:*), Bash(cat:*), Bash(wc:*), Bash(find:*)
```

**显式不给** `Edit / Write / MultiEdit / NotebookEdit`,从源头杜绝对仓库的任何写入。`maxTurns: 50` 防 agent 失控烧钱。

---

## 5. 原生 binary 解析(Alpine 关键)

Claude Agent SDK 的原生 binary 通过 `optionalDependencies` 按平台子包发布:`@anthropic-ai/claude-agent-sdk-{platform}-{arch}[-musl]/claude`。SDK 内部的 `require.resolve` 仅验文件存在,不验 ELF 动态链接器是否可用——musl 路径解析成功后 spawn 一个 glibc 二进制(或反之),kernel 回 ENOENT 被 SDK 翻译成 "native binary not found",和"包没装"完全混在一起。

`src/binary.ts` 做两件事:

1. 用 `process.report.header.glibcVersionRuntime` 判定 musl/glibc,**只**解析当前平台对应那一个子包,任何 fallback 都视作错误。
2. 在启动时 `statSync` + `claude --version` 烟测,失败立刻 `exit 1` 并打印 `platform/libc/@anthropic-ai 目录` 诊断。

Dockerfile 在 `npm run build` 之后跑同一份 `verifyBinary()`,镜像 push 前就拦截掉所有 binary 不可用的情况。

---

## 6. 准备一个待评审仓库

`workDir` 必须是容器内能访问的 git 仓库路径,通常宿主机克隆到 `./workspace/`:

```bash
git clone --depth=50 https://github.com/expressjs/express.git ./workspace/express
# 容器内对应路径: /workspace/express
```

跨容器/跨主机使用时,`WORKSPACE_DIR` 可指向任意宿主机目录,但容器内挂载点固定为 `/workspace`(与 Dockerfile 一致)。

---

## 7. 排错

| 现象 | 原因 |
|---|---|
| `curl` 一直没输出 | 忘了 `-N`,被 curl 缓冲 |
| 启动后 healthcheck 一直 starting | 二进制烟测或 npm install 失败,看 `docker compose logs agent` |
| 启动日志报 `native pkg ... not installed` / `--version failed` | `src/binary.ts` 烟测失败,带 `platform=`、`libc=`、`@anthropic-ai=...` 诊断 |
| `event: error` 401 / invalid_api_key | `authToken` 写成了 `"Bearer xxx"`,只填 key 本体 |
| `event: error` 找不到 model | `model` 拼错;智谱常见 `glm-4.6` / `glm-4.5` / `glm-4.5-air` / `glm-5.1`,**不是** `claude-*` |
| `event: error` cwd / .git 不存在 | `workDir` 写了宿主机路径,应是 `/workspace/xxx` |
| 工具调用全被拒 | 越界使用了白名单外的命令,这是设计 |
| 跑很久没动静 | 模型冷启动 / 大仓 grep;看日志确认是否在工具调用循环里 |
| SSE 经过 nginx 被聚合输出 | 服务端已设 `X-Accel-Buffering: no`;nginx 端再加 `proxy_buffering off; proxy_cache off;` |

---

## 8. 本地开发(不走容器)

```bash
npm install
npm run dev          # tsx watch src/server.ts
# 或
npm run build && npm start
```

`PORT` 默认 3000;`workDir` 改成本机真实 git 仓库的绝对路径即可。
