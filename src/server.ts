import express, { type Request, type Response } from "express";
import { runReview } from "./agent";
import { verifyBinary, setCachedBinary } from "./binary";
import type { ReviewRequest } from "./types";

const app = express();
app.use(express.json({ limit: "1mb" }));

// 进程级兜底:任何未被 try/catch 接住的异常都打到 stderr,避免静默崩溃
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});

/**
 * 健康检查——Spring Boot 启动 sandbox 后会轮询此接口确认 Node Agent ready。
 */
app.get("/agent/health", (_req: Request, res: Response) => {
  res.status(200).type("text/plain").send("ok");
});

/**
 * 代码评审入口(SSE)。
 */
app.post("/agent/review", async (req: Request, res: Response) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const body = req.body as Partial<ReviewRequest>;
  const t0 = Date.now();
  const dt = (): string => `+${Date.now() - t0}ms`;
  // 把对端 socket 信息打出来,方便区分"容器内 curl / 宿主机 curl / 上游网关"。
  const peer = `${req.socket.remoteAddress ?? "?"}:${req.socket.remotePort ?? "?"}`;
  const ua = req.headers["user-agent"] ?? "-";

  console.log(`[req ${reqId}] ${dt()} POST /agent/review peer=${peer} ua=${ua} workDir=${body.workDir} model=${body.model} sessionId=${body.sessionId ?? "-"}`);

  if (!body.workDir || !body.prompt || !body.baseUrl || !body.authToken || !body.model) {
    console.warn(`[req ${reqId}] ${dt()} 400 missing_required_field`);
    res.status(400).json({
      error: "missing_required_field",
      message: "workDir / prompt / baseUrl / authToken / model 必填",
    });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  console.log(`[req ${reqId}] ${dt()} headers flushed`);

  // 立即写一个 SSE comment 帧"破冰",让客户端马上收到字节,
  // 避免 SDK 冷启动几秒内空等导致 curl/Apifox/中间 NAT 主动关连接。
  // write() 同步返回 false 表示内核写缓冲已满,需要等 drain——一般 SSE 不会撞到,
  // 但打出来便于反推"首字节根本没发出去"这种诡异场景。
  const wroteIce = res.write(`: connected\n\n`);
  console.log(`[req ${reqId}] ${dt()} : connected frame written (drained=${wroteIce})`);

  // 心跳:每 15 秒一个 comment 帧,防 idle 超时;writable 关闭后自动停。
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`: keepalive\n\n`);
  }, 15000);

  // SDK 文档(sdk.d.ts L1158)推荐的中止方式:客户端断连时 abort,
  // SDK 会停止迭代并清理子进程,不再烧 token。
  const abortController = new AbortController();

  res.on("finish", () => console.log(`[req ${reqId}] ${dt()} response finished`));
  res.on("close", () => {
    clearInterval(heartbeat);
    console.log(`[req ${reqId}] ${dt()} response closed (writableEnded=${res.writableEnded})`);
  });
  req.on("close", () => {
    // 把 socket 是否已 destroyed、是否 aborted 一并打出来——能区分客户端 FIN/RST
    // 主动关 vs Node 内部把 req 关掉,定位时区别巨大。
    const sock = req.socket;
    console.warn(
      `[req ${reqId}] ${dt()} req close fired ` +
        `writableEnded=${res.writableEnded} ` +
        `aborted=${(req as { aborted?: boolean }).aborted ?? "?"} ` +
        `socket.destroyed=${sock?.destroyed ?? "?"} ` +
        `bytesWritten=${sock?.bytesWritten ?? "?"} ` +
        `bytesRead=${sock?.bytesRead ?? "?"}`,
    );
    if (!res.writableEnded) {
      console.warn(`[req ${reqId}] ${dt()} client disconnected before response end -> abort SDK`);
      abortController.abort();
      res.end();
    }
  });

  try {
    await runReview(body as ReviewRequest, res, reqId, abortController);
  } catch (err) {
    // 防御:runReview 内部已 catch,这里兜底极端场景(如 SSE 写入失败)
    console.error(`[req ${reqId}] ${dt()} runReview threw out:`, err);
    if (!res.writableEnded) {
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
});

const port = Number(process.env.PORT) || 3000;

// 启动期烟测 claude 原生二进制:不让任何请求在二进制不可用的状态下到达 SDK。
// 校验失败立刻 exit 1,让容器编排层重启或健康检查捕获,而不是把"native binary
// not found"错误吐回客户端。
async function main(): Promise<void> {
  const check = await verifyBinary();
  setCachedBinary(check);
  console.log(`[boot] claude binary ok: ${check.path} (${check.version}) via ${check.package}`);
  app.listen(port, () => {
    console.log(`[code-review-agent] listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("[boot] FATAL native binary check failed:", err);
  process.exit(1);
});
