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

# 创建非 root 用户运行。
# claude CLI 拒绝以 root 使用 --dangerously-skip-permissions,SDK 的
# permissionMode: "bypassPermissions" 会立刻 exit 非零,被 SDK 误报为
# "Claude Code native binary not found"。必须切非 root。
# uid 1000 与常见宿主机首个普通用户对齐,bind mount 时权限更顺。
RUN useradd -m -u 1000 -s /bin/bash app \
    && mkdir -p /workspace \
    && chown -R app:app /workspace /app
USER app

EXPOSE 3000
CMD ["node", "dist/server.js"]
