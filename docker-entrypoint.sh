#!/bin/sh
# 容器入口:以 root 启动属主守护循环,再 gosu 降权到 node 启动业务进程。
#
# 为啥需要这一层:
#  - claude CLI 在 root 下会拒绝 --dangerously-skip-permissions,且被 SDK 翻译成
#    误导性的 "native binary not found"——业务进程必须以非 root 跑。
#  - bind mount 进来的 /workspace 属主跟宿主机走,跟容器内 node(uid=1000) 错位,
#    业务进程写文件 EACCES。
#  - 关键:宿主机会持续往 /workspace 写(host-side git clone/pull 新仓库),
#    "启动时一次性 chown" 修不掉容器启动之后才进来的文件。必须把属主纪律做成
#    容器的常驻能力,部署机才能真正零配置——宿主机随便折腾,容器自动收敛。

set -eu

# 只 chown 属主不是 1000 的项,而不是无脑递归整个 /workspace——后者可能很大
# (含多个仓库 + node_modules),全量遍历浪费时间且会反复改时间戳之类。
# -xdev 防止 find 跨设备爬到挂载点之外(/proc /sys 等不该碰)。
# 用 find -exec ... + 批量调用 chown,比 \; 单调高效一个量级。
# 2>/dev/null + || true 兜底:极少数路径不可读或属于不可 chown 的特殊文件系统,
# 不让单点失败让整个容器起不来或守护循环挂掉。
chown_fix() {
  find /workspace -xdev \! -uid 1000 -exec chown -h node:node {} + 2>/dev/null || true
}

if [ -d /workspace ]; then
  # 启动时立即跑一次,清掉本次启动前堆积的错属主项。
  chown_fix
  # 后台常驻守护:每 5s 收敛一次,cover 容器跑起来之后宿主机新写入的文件
  # (典型场景:运维在宿主机 git clone 新仓库到 /workspace/<name>)。
  # 5s 间隔对 SSE 长任务无感,正常工作流是 host clone 完才发请求,这点延迟看不见。
  # fork 时机在 exec gosu 之前,子进程从 root 继承 chown 权限;exec 之后 PID 1
  # 变成 node,但已 fork 的 sh 子进程不受影响,继续在后台跑。
  # 容器销毁时 namespace 内进程被 docker 统一清,守护循环跟着退,无需额外清理。
  (while sleep 5; do chown_fix; done) &
fi

# exec 替换当前进程,PID 1 仍然是这个,docker stop 的 SIGTERM 才能被业务进程收到。
exec gosu node "$@"
