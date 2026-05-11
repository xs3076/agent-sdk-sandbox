import express, { type Request, type Response } from "express";
import { runReview } from "./agent";
import { verifyBinary, setCachedBinary } from "./binary";
import { runClone, CloneError, type CloneRequest } from "./clone";
import type { ReviewRequest } from "./types";

const app = express();
app.use(express.json({ limit: "1mb" }));

process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});

app.get("/agent/health", (_req: Request, res: Response) => {
  res.status(200).type("text/plain").send("ok");
});

/**
 * 把仓库拉到 /workspace/<name>。一次性 JSON,clone 失败不会污染评审 SSE 流。
 * 路径越界、非 https URL、--开头的 ref 等都在 runClone 里被拒。
 */
app.post("/agent/clone", async (req: Request, res: Response) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const body = req.body as Partial<CloneRequest>;
  console.log(`[req ${reqId}] POST /agent/clone url=${body.repoUrl} workDir=${body.workDir}`);

  if (!body.repoUrl || !body.workDir) {
    res.status(400).json({
      error: "missing_required_field",
      message: "repoUrl / workDir 必填",
    });
    return;
  }

  try {
    const result = await runClone(body as CloneRequest, reqId);
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof CloneError) {
      console.warn(`[req ${reqId}] clone failed: ${err.message}`);
      res.status(400).json({ error: "clone_failed", message: err.message, stderr: err.stderr });
    } else {
      console.error(`[req ${reqId}] clone unexpected error:`, err);
      res.status(500).json({
        error: "internal",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
});

app.post("/agent/review", async (req: Request, res: Response) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const body = req.body as Partial<ReviewRequest>;

  console.log(`[req ${reqId}] POST /agent/review model=${body.model} sessionId=${body.sessionId ?? "-"}`);

  if (!body.workDir || !body.prompt || !body.baseUrl || !body.authToken || !body.model) {
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
  // 破冰帧:让客户端 / 中间 NAT 立刻收到字节,避免冷启动期被当成 idle 关连接。
  res.write(`: connected\n\n`);

  // SSE 心跳,防 idle 超时;res 关闭后停。
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(`: keepalive\n\n`);
  }, 15000);

  const abortController = new AbortController();

  // 客户端断连的唯一可靠信号:res.on('close') 触发且 writableEnded=false。
  //   - 正常 res.end() 后也会触发,但 writableEnded=true,落不到 abort 分支。
  //   - 不要用 req.on('close'):Node 16+ 把它语义成"可读流关闭",body 读完就触发,
  //     和"客户端断连"无关,用它做 abort 会让每个请求一进来就把自己 SDK 进程
  //     abort 掉。
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) {
      console.warn(`[req ${reqId}] client disconnected -> abort SDK`);
      abortController.abort();
    }
  });

  try {
    await runReview(body as ReviewRequest, res, reqId, abortController);
  } catch (err) {
    console.error(`[req ${reqId}] runReview threw:`, err);
    if (!res.writableEnded) res.end();
  }
});

const port = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  const check = await verifyBinary();
  setCachedBinary(check);
  console.log(`[boot] claude binary ok: ${check.path} (${check.version})`);
  app.listen(port, () => {
    console.log(`[code-review-agent] listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("[boot] FATAL native binary check failed:", err);
  process.exit(1);
});
