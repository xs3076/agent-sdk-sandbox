FROM node:20-slim

# debian-slim 用 apt;git 是 agent 工具(git 子命令)、ca-certificates 是 https 必备。
# slim 自带 bash,RUN/healthcheck/docker exec 调试无需额外装。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖文件,利用 Docker 缓存
COPY package*.json ./
# debian 是 glibc,SDK 的 optionalDependencies 选 linux-${arch}(无 -musl 后缀)子包。
RUN npm install

# 源码;skills 不再 COPY 进镜像,改由 docker-compose 挂载到 /home/node/.claude/skills。
# 原因:SDK / claude binary 只扫 ~/.claude/skills 与 <cwd>/.claude/skills 两条路径,
#       原本 COPY 到 /app/skills 的位置根本不会被加载。
COPY tsconfig.json ./
COPY src/ ./src/

# 编译
RUN npm run build

# 构建期烟测:复用运行期同一份 verifyBinary 逻辑,镜像里跑得起 claude 才算合格。
# 多架构构建(amd64/arm64)下 optionalDependencies 选错 arch、子包未装、权限缺失、
# 动态链接器找不到都会让此步失败,阻止有问题的镜像被 push 出去。
RUN node -e "require('./dist/binary').verifyBinary().then(c=>console.log('[image-smoke] '+c.path+' '+c.version+' '+c.package)).catch(e=>{console.error(e);process.exit(1)})"

# 切非 root:claude CLI 拒绝以 root 用 --dangerously-skip-permissions,
# bypassPermissions 会立刻 exit 非零被 SDK 翻译成 "native binary not found"。
# node:20-slim 已自带 uid=1000 的 node 用户,直接复用。
# 预创建 /home/node/.claude/skills 作为挂载点,免得 compose 首次起容器时点目录不存在。
RUN mkdir -p /workspace /home/node/.claude/skills \
  && chown -R node:node /workspace /app /home/node/.claude
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
