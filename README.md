# agent-sdk-sandbox

基于 Claude Agent SDK 的通用 Agent 沙箱 Node 服务。对外暴露一个 SSE 接口,由上游(Spring Boot 等)调用,在沙箱内的工作目录上跑一轮 Agent 并把 SDK 输出原样流式推回。

- **通用**:不绑定任何特定任务(评审 / 重构 / 问答都行)。要做什么完全由请求体的 `prompt` 决定;具体行为可由 `skills/` 与 `allowedTools` 进一步约束。
- **Provider 无关**:`baseUrl` / `authToken` / `model` 全部由请求体传入,支持智谱 BigModel、OpenRouter、Anthropic 官方等任意 Anthropic-skin 网关。
- **流式**:SDK 的 `SDKMessage` 原样逐条以 SSE 推到上游,Node 层不做任何聚合。
- **沙箱边界在部署侧**:服务以 `bypassPermissions` 启动 SDK,所有工具调用都不弹权限确认,**应用层不做工具白名单**;隔离完全依赖容器/VM(见 [§5](#5-权限与安全模型))。
- **启动期烟测**:容器启动时显式解析当前平台的原生 binary、跑 `claude --version` 通过才 `listen`(见 `src/binary.ts`),避免任何 "native binary not found" 在运行期才暴露。

---

## 1. 目录结构

```
.
├── Dockerfile              # node:20-slim + git,编译 TS,运行 dist/server.js
├── docker-compose.yaml     # 单服务部署,挂 ./workspace 到 /workspace
├── .env.example            # 所有可调环境变量样板
├── src/
│   ├── server.ts           # Express 入口,2 个路由(/agent/health、/agent/run)
│   ├── agent.ts            # 调 SDK query(),组装 env,流式推 SSE
│   ├── binary.ts           # 启动期解析 + 烟测 claude 原生 binary
│   └── types.ts            # AgentRunRequest 类型
└── skills/                 # SDK 通过 settingSources:["project"] 加载(目前为空,放 <name>/SKILL.md 即生效)
```

---

## 2. 部署

### 2.1 准备

```bash
cp .env.example .env       # 默认值即可,按需调整端口/资源/时区
mkdir -p workspace         # 宿主机上的工作目录挂载点
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
| `IMAGE` / `IMAGE_TAG` | 见 `.env.example` | 镜像地址与 tag |
| `CPU_LIMIT` | 2.0 | 容器 CPU 上限 |
| `MEMORY_LIMIT` | 2g | 容器内存上限 |
| `MEMORY_RESERVATION` | 512m | 内存软保留 |
| `LOG_MAX_SIZE` / `LOG_MAX_FILE` | 20m / 5 | 容器日志滚动策略 |
| `TZ` | `Asia/Shanghai` | 时区 |

> **不要** 在 `.env` 里放 `ANTHROPIC_*`:`src/agent.ts` 的 `buildSdkEnv` 显式把 `ANTHROPIC_API_KEY` 置空,阻断容器层 env 污染 SDK 的 provider 选择。Provider 只走请求体。

---

## 3. 接口

Base URL:宿主机调用 `http://localhost:${HOST_PORT}`,同 compose 网络其它容器调用 `http://agent:${PORT}`。

### 3.1 GET `/agent/health`

健康检查。上游拉起沙箱后轮询此接口确认就绪。

| 项 | 值 |
|---|---|
| Method | GET |
| Response | `200 text/plain`,body = `ok` |

```bash
curl -i http://localhost:3000/agent/health
```

### 3.2 POST `/agent/run`

Agent 执行入口,**SSE 长连接**。

#### 请求

| 项 | 值 |
|---|---|
| Method | POST |
| Content-Type | `application/json` |
| Body 限制 | 1 MB |

请求体(`src/types.ts` 的 `AgentRunRequest`):

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `workDir` | string | ✅ | — | **容器内**路径,通常 `/workspace/xxx`,作为 SDK 的 cwd。必须已存在且是目录,否则 `400`。路径合法性由部署边界(容器/VM)负责 |
| `prompt` | string | ✅ | — | 本轮 prompt,首轮为指令,后续为追问 |
| `baseUrl` | string | ✅ | — | LLM 网关 base URL |
| `authToken` | string | ✅ | — | 网关 key 本体,**不要加 `Bearer` 前缀** |
| `model` | string | ✅ | — | 主模型 ID |
| `smallModel` | string | ❌ | 同 `model` | 小模型 ID(SDK 用于快速操作) |
| `sessionId` | string | ❌ | — | 多轮对话时填上一轮返回的 `session_id`(SDK `resume`) |
| `allowedTools` | string[] | ❌ | SDK 默认 | 透传给 SDK 的 `allowedTools`。**注意:这不是安全边界**,见 [§5](#5-权限与安全模型) |
| `maxTurns` | number | ❌ | `50` | 最大轮数,防 agent 失控烧钱 |

`baseUrl` 示例:

| Provider | baseUrl |
|---|---|
| 智谱 BigModel | `https://open.bigmodel.cn/api/anthropic` |
| OpenRouter | `https://openrouter.ai/api`(**不带 `/v1`**) |
| Anthropic 官方 | `https://api.anthropic.com` |

校验失败(非 SSE,一次性 JSON):

```json
{ "error": "missing_required_field", "message": "workDir / prompt / baseUrl / authToken / model 必填" }
{ "error": "workdir_not_found",      "message": "/workspace/xxx does not exist or is not a directory" }
```

> `workDir` 预检是有意为之:不挡这层时,SDK 会把 cwd 不存在的 spawn 失败统一翻译成误导性的 "Claude Code native binary not found"。

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
curl -N -X POST http://localhost:3000/agent/run \
  -H "Content-Type: application/json" \
  -d '{
    "workDir": "/workspace/express",
    "prompt": "用中文,基于 git log 最近 5 个提交,挑出最值得关注的一个并指出潜在问题。",
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
curl -N -X POST http://localhost:3000/agent/run \
  -H "Content-Type: application/json" \
  -d '{
    "workDir": "/workspace/express",
    "sessionId": "上一轮拿到的 session_id",
    "prompt": "针对刚才那个 commit,再看下被改文件的历史。",
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "authToken": "你的智谱key",
    "model": "glm-4.6"
  }'
```

#### 客户端断连

`res.on('close')` 触发且 `!res.writableEnded` 时认定为客户端提前断开,服务端调用 `abortController.abort()` 让 SDK 立刻停止迭代并清理子进程(`src/server.ts`),不再烧 token。

> 不要用 `req.on('close')` 做这件事:Node 16+ 把它语义化成"可读流关闭",body 一读完就触发,和"客户端断连"无关,用它做 abort 会让每个请求一进来就把自己 SDK 进程 abort 掉。

---

## 4. (已删除)

> 旧版这里是「工具白名单」。当前实现不再做应用层白名单,见下一节。

---

## 5. 权限与安全模型

`src/agent.ts` 的 `runAgent` 以 **`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`** 启动 SDK:

- 所有工具调用都**不会**触发权限提示,SDK 可读可写可执行。
- 请求体的 `allowedTools` 只是**原样透传**给 SDK,**不构成安全边界**——没传时用 SDK 默认全集。它用来"按需收窄能力"(比如只想让它读),不能用来"兜底防越权"。
- `workDir` 也不做内容性约束,只校验目录存在。

**真正的隔离边界是部署侧的容器 / VM**,不是这段 Node 代码。把不该被 agent 碰的东西挡在容器外,而不是指望 `allowedTools`。

若要在应用层强制收紧,应改代码:换成 `disallowedTools`,或把 `permissionMode` 下调到会真正拦截的级别(见 `src/agent.ts` 顶部与 `src/types.ts` 中 `allowedTools` 的注释)。

`maxTurns`(默认 `50`)是唯一的应用层硬约束,防 agent 失控烧钱。

容器以非 root 的 `node` 用户运行:claude CLI 在 root 下会拒绝 `--dangerously-skip-permissions` 并非零退出,被 SDK 翻译成 "native binary not found"。Dockerfile 已处理(`USER node`)。

---

## 6. 原生 binary 解析(多架构镜像关键)

Claude Agent SDK 的原生 binary 通过 `optionalDependencies` 按平台子包发布:`@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude`(部署镜像为 debian-slim/glibc,无 `-musl` 子包)。SDK 内部的 `require.resolve` 按顺序探测多个平台子包且仅验文件存在,不验 ELF 是否可在本机执行——多架构构建(amd64/arm64)里一旦装错 arch,它会解析出另一架构的二进制,spawn 后 kernel 回 ENOENT 被 SDK 翻译成 "native binary not found",和"包没装"完全混在一起。

`src/binary.ts` 做两件事:

1. 按 `platform/arch` **只**解析当前平台对应那一个子包,不走 SDK 的兜底探测链,任何 fallback 都视作错误。
2. 启动时 `statSync` + 真实 spawn `claude --version` 烟测,失败立刻 `exit 1` 并打印 `platform/arch/@anthropic-ai 目录` 诊断。`getBinaryPath()` 在未通过烟测前抛错,防止任何请求在未校验状态下到达 SDK。

Dockerfile 在 `npm run build` 之后跑**同一份** `verifyBinary()`,binary 不可用的镜像构建期就被拦下,push 不出去。

---

## 7. 准备工作目录

服务本身**不负责拉代码**(已无 `/agent/clone`)。调用方自行把要处理的目录放到宿主机的 `WORKSPACE_DIR`,容器内对应 `/workspace`:

```bash
# 例:在宿主机浅克隆一个仓库
git clone --depth=50 https://github.com/expressjs/express.git ./workspace/express
# 容器内对应路径: /workspace/express  → 作为请求体的 workDir
```

`workDir` 不必是 git 仓库——任何已存在的目录都行,具体取决于 `prompt` 让 agent 做什么。跨容器/跨主机使用时,`WORKSPACE_DIR` 可指向任意宿主机目录,但容器内挂载点固定为 `/workspace`(与 Dockerfile 一致)。

---

## 8. 排错

| 现象 | 原因 |
|---|---|
| `curl` 一直没输出 | 忘了 `-N`,被 curl 缓冲 |
| `400 missing_required_field` | `workDir/prompt/baseUrl/authToken/model` 有缺 |
| `400 workdir_not_found` | `workDir` 写了宿主机路径或目录不存在;应是已挂载的 `/workspace/xxx` |
| 启动后 healthcheck 一直 starting | 二进制烟测或 npm install 失败,看 `docker compose logs agent` |
| 启动日志报 `native pkg ... not installed` / `--version failed` | `src/binary.ts` 烟测失败,带 `platform=`、`libc=`、`@anthropic-ai=...` 诊断 |
| `event: error` 401 / invalid_api_key | `authToken` 写成了 `"Bearer xxx"`,只填 key 本体 |
| `event: error` 找不到 model | `model` 拼错;智谱常见 `glm-4.6` / `glm-4.5` / `glm-4.5-air`,**不是** `claude-*` |
| 跑很久没动静 | 模型冷启动 / 大目录 grep;看日志确认是否在工具调用循环里 |
| SSE 经过 nginx 被聚合输出 | 服务端已设 `X-Accel-Buffering: no`;nginx 端再加 `proxy_buffering off; proxy_cache off;` |

---

## 9. 本地开发(不走容器)

```bash
npm install
npm run dev          # tsx watch src/server.ts
# 或
npm run build && npm start
npm run typecheck    # tsc --noEmit(无测试/lint 框架)
```

`PORT` 默认 3000;`workDir` 改成本机真实目录的绝对路径即可。
