# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库代码与注释均为中文,后续改动请沿用中文注释风格。

## 这是什么

一个极小的 Express 服务(`src/` 共约 340 行 TS),把 `@anthropic-ai/claude-agent-sdk` 的 `query()` 包成一个 SSE 接口。Provider 无关:`baseUrl` / `authToken` / `model` 全部由请求体传入,Node 层不做聚合,SDK 的 `SDKMessage` 原样逐条 `data:` 推出。

## 常用命令

```bash
npm install
npm run dev          # tsx watch src/server.ts(本地开发)
npm run build        # tsc -> dist/
npm start            # node dist/server.js
npm run typecheck    # tsc --noEmit

docker compose pull && docker compose up -d        # 部署机:拉 CI 推的镜像
cp docker-compose.override.yaml.example docker-compose.override.yaml
docker compose up -d --build                       # 本地现场构建
```

无测试框架、无 lint 配置——不要假设存在 `npm test` / `npm run lint`。改动后用 `npm run typecheck` 验证。

## 历史包袱:曾是 code-review 专用服务

本服务最早是 `/agent/clone` + `/agent/review` + 只读工具白名单 + `src/clone.ts` 的代码评审专用服务,后重构为通用 `/agent/run` + `bypassPermissions`,并统一更名为 `agent-sdk-sandbox`(`package.json` / `docker-compose` / `.env.example` / CI 镜像名均已对齐),旧的 `skills/code-review/` 占位骨架已删除。改动时以 `src/` 为准;接口/安全模型有变需同步修订 `README.md`。

## 架构(需跨文件理解的部分)

请求生命周期贯穿 4 个文件:

- **`src/server.ts`** — Express 入口,仅两个路由:`GET /agent/health`(返回 `ok`)、`POST /agent/run`(SSE)。负责必填校验、`workDir` 预检、SSE 头与破冰/心跳帧、客户端断连 → abort、启动编排。
- **`src/agent.ts`** — `runAgent()` 调 `query()` 并把每条 message 写成 SSE;`buildSdkEnv()` 由请求体拼 `ANTHROPIC_*` 环境变量。
- **`src/binary.ts`** — 解析当前平台的原生 claude binary + 启动/构建期烟测。
- **`src/types.ts`** — `AgentRunRequest` 请求体类型(唯一的接口契约)。

### 安全模型(已变更,务必注意)

`runAgent` 以 `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` 启动 SDK。**`allowedTools` 只是从请求体透传,不构成安全边界**——它不再是"只读白名单"。真正的隔离完全依赖部署侧沙箱(容器/VM)。若要在应用层收紧,应改用 `disallowedTools` 或下调 `permissionMode`(见 `src/agent.ts` 顶部注释与 `types.ts` 的 `allowedTools` 文档)。

### Provider 只走请求体,绝不进镜像

`buildSdkEnv` 先 spread `process.env`,再覆盖 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`,并显式把 `ANTHROPIC_API_KEY` 置空——阻断容器层 env 污染 SDK 的 provider 选择。**不要**往 `.env` 放任何 `ANTHROPIC_*`。

### 几个"踩过坑才有"的设计点

- **原生 binary 解析(多架构镜像关键)**:不走 SDK 的 `require.resolve` 兜底探测链——多架构构建(amd64/arm64)里一旦 optionalDependencies 装错 arch,它会解析出另一架构的二进制,spawn 后 kernel ENOENT,被 SDK 误报成 "native binary not found"。`binary.ts` 按 `platform/arch` **只**解析当前平台子包,任何回落即抛错(部署镜像已是 debian-slim/glibc,不再有 musl 分支)。启动时 `verifyBinary()` 必须先于 `app.listen()`;`getBinaryPath()` 在未缓存时抛错,防止请求在未校验态到达 SDK。Dockerfile 在 `npm run build` 后跑**同一份** `verifyBinary()`,binary 不可用的镜像构建期就被拦下。
- **`workDir` 预检**:`server.ts` 在进 SDK 前显式 `existsSync`/`isDirectory`——否则 SDK 把"cwd 不存在的 spawn 失败"也翻译成那条误导性的 "native binary not found"。
- **SSE 客户端断连**:用 `res.on('close')` 且 `!res.writableEnded` 触发 `abortController.abort()`,**不要**用 `req.on('close')`(Node 16+ 语义是"可读流关闭",body 读完就触发,会让每个请求一进来就 abort 自己)。
- **`settingSources: ["project"]`**:SDK 从项目目录加载 `skills/`;Dockerfile 已 `COPY skills/`。目前 `skills/` 为空,仅 `.gitkeep` 占位(让空目录进 git,否则 CI 全新 checkout 时 `skills/` 不存在会让 `COPY skills/` 构建失败)。新增 skill 放 `skills/<name>/SKILL.md`。

## 部署链路上的坑

CI(`.github/workflows/deploy.yml`,push 到 `main` 触发)构建多架构镜像并推到 `registry.cn-shanghai.aliyuncs.com/vagent/agent-sdk-sandbox`,`docker-compose.yaml` / `.env.example` 默认拉同名镜像(已对齐)。容器内工作目录固定 `/workspace`(Dockerfile 与 compose 挂载点必须一致),容器以非 root `node` 用户运行(root 下 `bypassPermissions` 会被 claude CLI 拒绝并误报 binary not found)。
