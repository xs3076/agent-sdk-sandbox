import * as fs from "node:fs";
import express, { type Request, type Response } from "express";
import { runAgent } from "./agent";
import { verifyBinary, setCachedBinary } from "./binary";
import type { AgentRunRequest } from "./types";

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

app.post("/agent/run", async (req: Request, res: Response) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  const body = req.body as Partial<AgentRunRequest>;

  console.log(`[req ${reqId}] POST /agent/run model=${body.model} sessionId=${body.sessionId ?? "-"}`);

  if (!body.workDir || !body.prompt || !body.baseUrl || !body.authToken || !body.model) {
    res.status(400).json({
      error: "missing_required_field",
      message: "workDir / prompt / baseUrl / authToken / model 必填",
    });
    return;
  }

  // workDir 必须存在且是目录。不挡这层时,SDK 把 cwd 不存在的 spawn 失败统一翻译成
  // 误导性的 "Claude Code native binary not found",排错要兜好几圈。
  if (!fs.existsSync(body.workDir) || !fs.statSync(body.workDir).isDirectory()) {
    res.status(400).json({
      error: "workdir_not_found",
      message: `${body.workDir} does not exist or is not a directory`,
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
    await runAgent(body as AgentRunRequest, res, reqId, abortController);
  } catch (err) {
    console.error(`[req ${reqId}] runAgent threw:`, err);
    if (!res.writableEnded) res.end();
  }
});

const port = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  const check = await verifyBinary();
  setCachedBinary(check);
  console.log(`[boot] claude binary ok: ${check.path} (${check.version})`);
  app.listen(port, () => {
    console.log(`[agent-sdk-sandbox] listening on :${port}`);
  });
}

main().catch((err) => {
  console.error("[boot] FATAL native binary check failed:", err);
  process.exit(1);
});
