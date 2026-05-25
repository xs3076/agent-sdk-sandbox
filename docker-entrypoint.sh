#!/bin/sh
# 容器入口:以 root 启动,先把 bind mount 进来的 /workspace 属主修成 node(uid=1000),
# 再 gosu 降权到 node 启动业务进程。
#
# 为啥需要这一层:
#  - claude CLI 在 root 下会拒绝 --dangerously-skip-permissions,且被 SDK 翻译成
#    误导性的 "native binary not found"——业务进程必须以非 root 跑。
#  - 但 bind mount 进来的 /workspace 属主取决于宿主机,常见是 root 或宿主当前用户,
#    跟容器内 node(uid=1000) 对不上,写文件会 EACCES。
#  - 让运维每次部署都 chown 一遍治标不治本(后续被别的进程写入又会带错属主),
#    把这步搬到容器里,部署机彻底零配置。

set -eu

# 只 chown 属主不是 1000 的项,而不是无脑递归整个 /workspace——后者可能很大
# (含多个仓库 + node_modules),首次没问题,但每次 restart 都全量遍历浪费时间。
# 用 find -exec ... + 批量调用 chown,比 \; 单调高效一个量级。
# 2>/dev/null + || true 兜底:极少数情况下某些路径不可读,不让 chown 警告把容器启动整挂。
if [ -d /workspace ]; then
  find /workspace \! -uid 1000 -exec chown -h node:node {} + 2>/dev/null || true
fi

# exec 替换当前进程,PID 1 仍然是这个,docker stop 的 SIGTERM 才能被业务进程收到。
exec gosu node "$@"
