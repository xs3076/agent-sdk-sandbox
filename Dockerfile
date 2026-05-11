FROM node:20-alpine

# alpine 用 apk;git 与 ca-certificates 是 SDK 工具白名单与 https 必备
# bash 给我们的 RUN/healthcheck 与 docker exec 调试用(alpine 默认 ash)
RUN apk add --no-cache git ca-certificates bash

WORKDIR /app

# 先复制依赖文件,利用 Docker 缓存
COPY package*.json ./
# alpine 是 musl,SDK 的 optionalDependencies 通过 detect-libc 自动选 *-musl 子包。
RUN npm install

# 源码 + skills(SDK 通过 settingSources:["project"] 加载)
COPY tsconfig.json ./
COPY src/ ./src/
COPY skills/ ./skills/

# 编译
RUN npm run build

# 构建期烟测:复用运行期同一份 verifyBinary 逻辑,镜像里跑得起 claude 才算合格。
# 路径解析 / libc 不匹配 / 权限缺失 / 动态链接器找不到都会让此步失败,阻止
# 有问题的镜像被 push 出去。
RUN node -e "require('./dist/binary').verifyBinary().then(c=>console.log('[image-smoke] '+c.path+' '+c.version+' '+c.package)).catch(e=>{console.error(e);process.exit(1)})"

# 切非 root:claude CLI 拒绝以 root 用 --dangerously-skip-permissions,
# bypassPermissions 会立刻 exit 非零被 SDK 翻译成 "native binary not found"。
# node:20-alpine 已自带 uid=1000 的 node 用户,直接复用。
RUN mkdir -p /workspace && chown -R node:node /workspace /app
USER node

EXPOSE 3000
CMD ["node", "dist/server.js"]
