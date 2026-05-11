import express, { type Request, type Response } from "express";
import { runReview } from "./agent";
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

  console.log(`[req ${reqId}] POST /agent/review workDir=${body.workDir} model=${body.model} sessionId=${body.sessionId ?? "-"}`);

  if (!body.workDir || !body.prompt || !body.baseUrl || !body.authToken || !body.model) {
    console.warn(`[req ${reqId}] 400 missing_required_field`);
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

  res.on("finish", () => console.log(`[req ${reqId}] response finished`));
  res.on("close", () => console.log(`[req ${reqId}] response closed (writableEnded=${res.writableEnded})`));
  req.on("close", () => {
    if (!res.writableEnded) {
      console.warn(`[req ${reqId}] client disconnected before response end`);
      res.end();
    }
  });

  try {
    await runReview(body as ReviewRequest, res, reqId);
  } catch (err) {
    // 防御:runReview 内部已 catch,这里兜底极端场景(如 SSE 写入失败)
    console.error(`[req ${reqId}] runReview threw out:`, err);
    if (!res.writableEnded) {
      res.end();
    }
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[code-review-agent] listening on :${port}`);
});
