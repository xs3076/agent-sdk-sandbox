FROM node:20-slim

# debian-slim 用 apt;git 是 agent 工具(git 子命令)、ca-certificates 是 https 必备、
# gosu 用于 entrypoint 在 root 下修正挂载点属主后降权到 node 跑业务进程
# (claude CLI 拒绝在 root 下用 --dangerously-skip-permissions)。
# slim 自带 bash,RUN/healthcheck/docker exec 调试无需额外装。
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates gosu \
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

# 预创建 /workspace 与 /home/node/.claude/skills 作为挂载点,
# 免得 compose 首次起容器时点目录不存在。镜像层属主先设成 node:node,
# bind mount 覆盖后再由 entrypoint 按运行时实际情况修正。
RUN mkdir -p /workspace /home/node/.claude/skills \
  && chown -R node:node /workspace /app /home/node/.claude

# 容器以 root 启动 → entrypoint 修挂载点属主 → gosu 降权到 node 跑业务进程。
# 不再用 USER node:PID 1 必须是 root 才有权 chown bind mount 进来的 /workspace。
# claude CLI 仍然只在 node 用户下跑(业务进程经 gosu 切过去),--dangerously-skip-permissions 通过。
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
