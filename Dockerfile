FROM node:20-slim

# 装 git + tsx 运行依赖
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件,利用 Docker 缓存
COPY package*.json ./
RUN npm install

# SDK 主包通过 optionalDependencies 提供 8 个 platform-specific 子包(每个自带
# claude binary),npm install 时按当前 OS/arch/libc 自动选一个。
# 实测 SDK 在 debian-slim(glibc) 上会错误地选 *-musl 子包并报
# "native binary not found"。这里用 ARG TARGETARCH 强制安装无 musl 后缀的
# 正确平台包,绕开 SDK 的 libc 误探测;buildx 多架构构建时按目标架构走。
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) NATIVE_PKG=@anthropic-ai/claude-agent-sdk-linux-x64 ;; \
        arm64) NATIVE_PKG=@anthropic-ai/claude-agent-sdk-linux-arm64 ;; \
        *) echo "unsupported TARGETARCH=$TARGETARCH" && exit 1 ;; \
    esac \
    && npm install --no-save "$NATIVE_PKG" \
    && ls /app/node_modules/@anthropic-ai/ \
    && test -x "/app/node_modules/$NATIVE_PKG/claude" \
    && echo "✓ SDK native binary in place: $NATIVE_PKG"

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
