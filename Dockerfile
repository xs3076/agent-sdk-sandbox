FROM node:20-slim

# 装 git + tsx 运行依赖
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件,利用 Docker 缓存
COPY package*.json ./
RUN npm install

# Claude Agent SDK 在运行时 spawn `claude` CLI 子进程,
# 必须显式安装,否则报 "Claude Code native binary not found"
RUN npm install -g @anthropic-ai/claude-code \
    && which claude && claude --version

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
# node:20-slim 已内置 uid=1000 的 `node` 用户,直接复用,无需 useradd。
RUN mkdir -p /workspace \
    && chown -R node:node /workspace /app
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
