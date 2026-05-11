import express, { type Request, type Response } from "express";
import { runReview } from "./agent";
import type { ReviewRequest } from "./types";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * 健康检查——Spring Boot 启动 sandbox 后会轮询此接口确认 Node Agent ready。
 */
app.get("/agent/health", (_req: Request, res: Response) => {
  res.status(200).type("text/plain").send("ok");
});

/**
 * 代码评审入口(SSE)。
 *
 * 关键响应头:
 *  - Content-Type: text/event-stream
 *  - Cache-Control: no-cache(禁缓存)
 *  - Connection: keep-alive(保持长连接)
 *  - X-Accel-Buffering: no(禁用任何中间代理的 buffer——nginx 等)
 */
app.post("/agent/review", async (req: Request, res: Response) => {
  const body = req.body as Partial<ReviewRequest>;

  // 入参基础校验
  if (!body.workDir || !body.prompt || !body.baseUrl || !body.authToken || !body.model) {
    res.status(400).json({
      error: "missing_required_field",
      message: "workDir / prompt / baseUrl / authToken / model 必填",
    });
    return;
  }

  // 设置 SSE 响应头
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // 客户端断连时,尽力收尾(SDK 的子进程清理由 SDK 自身负责)。
  req.on("close", () => {
    if (!res.writableEnded) {
      res.end();
    }
  });

  await runReview(body as ReviewRequest, res);
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[code-review-agent] listening on :${port}`);
});
