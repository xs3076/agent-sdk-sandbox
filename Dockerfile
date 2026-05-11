FROM node:20-alpine

# alpine 用 apk;git 与 ca-certificates 是 SDK 工具白名单与 https 必备
# bash 给我们的 RUN/healthcheck 与 docker exec 调试用(alpine 默认 ash)
RUN apk add --no-cache git ca-certificates bash

WORKDIR /app

# 先复制依赖文件,利用 Docker 缓存
COPY package*.json ./
# alpine 是 musl,SDK 的 optionalDependencies(8 个 platform 子包)中
# detect-libc 会自动选 *-musl 子包并装上;不需要任何 --libc 强制。
RUN npm install \
    && ls -la /app/node_modules/@anthropic-ai/ \
    && CLAUDE_BIN=$(find /app/node_modules/@anthropic-ai/ -name claude -type f -executable | head -1) \
    && test -n "${CLAUDE_BIN}" \
    && echo "✓ SDK native binary: ${CLAUDE_BIN}" \
    && "${CLAUDE_BIN}" --version

# 复制全部源码(包含 scripts/ 测试用)
COPY tsconfig.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY skills/ ./skills/

# 编译
RUN npm run build

# 切非 root 运行。
# claude CLI 拒绝以 root 使用 --dangerously-skip-permissions,SDK 的
# permissionMode: "bypassPermissions" 会立刻 exit 非零,被 SDK 误报为
# "Claude Code native binary not found"。必须切非 root。
# node:20-alpine 已内置 uid=1000 的 `node` 用户,直接复用,无需 adduser。
RUN mkdir -p /workspace \
    && chown -R node:node /workspace /app
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
