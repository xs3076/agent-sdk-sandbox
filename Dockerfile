FROM node:20-slim

# 装 git + tsx 运行依赖
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件,利用 Docker 缓存
COPY package*.json ./
RUN npm install

# SDK 主包内部硬编码查找 *-musl 子包路径(实测,与 detect-libc 无关)。
# 但 musl 子包声明了 "libc": ["musl"],debian glibc 容器默认会跳过;且该包
# latest 是 0.0.0 占位空包,必须 pin 到与 SDK 主包同步的版本。
# 解法:用 grep 取主包 version,--libc=musl --force 绕过 libc 约束强装。
# musl binary 是静态链接,glibc 系统可直接执行。
ARG TARGETARCH
RUN set -eux \
    && SDK_VERSION=$(grep -m1 '"version"' /app/node_modules/@anthropic-ai/claude-agent-sdk/package.json | cut -d'"' -f4) \
    && echo "SDK_VERSION=${SDK_VERSION}" \
    && case "${TARGETARCH}" in \
        amd64) NATIVE_PKG=@anthropic-ai/claude-agent-sdk-linux-x64-musl ;; \
        arm64) NATIVE_PKG=@anthropic-ai/claude-agent-sdk-linux-arm64-musl ;; \
        *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2 && exit 1 ;; \
    esac \
    && echo "installing ${NATIVE_PKG}@${SDK_VERSION}" \
    && npm install --no-save --libc=musl --force "${NATIVE_PKG}@${SDK_VERSION}" \
    && ls -la "/app/node_modules/${NATIVE_PKG}/" \
    && test -x "/app/node_modules/${NATIVE_PKG}/claude"

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
