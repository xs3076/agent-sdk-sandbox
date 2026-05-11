import type { Response } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ReviewRequest } from "./types";

/**
 * 代码评审场景的工具白名单——严格只读 + git 子命令。
 * 不给 Edit / Write / MultiEdit / NotebookEdit,从源头杜绝危险操作。
 */
const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git status:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(wc:*)",
  "Bash(find:*)",
];

/**
 * 把单条 SDKMessage 序列化为一行 SSE data 帧。
 */
function writeSse(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * 组装 SDK 子进程使用的环境变量。Provider 无关——base URL 与 token 由调用方传入。
 *
 * SDK 文档(sdk.d.ts L1244):env "Defaults to process.env",一旦传 env 即完全
 * 替换。本函数 spread process.env 后再覆盖 ANTHROPIC_*,既保证子进程拿得到
 * PATH/HOME 等基础变量,又能强制走指定 provider。
 */
export function buildSdkEnv(req: ReviewRequest): Record<string, string> {
  const model = req.model;
  const small = req.smallModel || req.model;
  return {
    ...(process.env as Record<string, string>),
    ANTHROPIC_BASE_URL: req.baseUrl,
    ANTHROPIC_AUTH_TOKEN: req.authToken,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
  };
}

/**
 * 调用 Claude Agent SDK 进行代码评审,流式把 SDKMessage 推到 SSE 响应。
 *
 * 关键 options(均按官方 sdk.d.ts 0.2.138 文档):
 *  - 不传 pathToClaudeCodeExecutable:让 SDK 用 optionalDeps 装的 built-in
 *    binary(L1492 "Uses the built-in executable if not specified")。
 *  - allowDangerouslySkipPermissions: true:bypassPermissions 的官方
 *    强制配套(L1512 "Must be set to true when using bypassPermissions")。
 *  - abortController:客户端断连时由调用方 abort,SDK 立刻停止并清理子进程
 *    (L1158 "When aborted, the query will stop and clean up resources")。
 *  - stderr 回调:把 SDK 子进程 stderr 直通本进程 console.error,故障定位更精准。
 */
export async function runReview(
  req: ReviewRequest,
  res: Response,
  reqId: string,
  abortController: AbortController,
): Promise<void> {
  const tag = `[req ${reqId}]`;
  console.log(`${tag} runReview start cwd=${req.workDir} baseUrl=${req.baseUrl}`);
  let count = 0;
  try {
    const result = query({
      prompt: req.prompt,
      options: {
        cwd: req.workDir,
        resume: req.sessionId,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        allowedTools: ALLOWED_TOOLS,
        maxTurns: 50,
        settingSources: ["project"],
        env: buildSdkEnv(req),
        abortController,
        stderr: (data: string) => console.error(`${tag} [sdk-stderr] ${data.trimEnd()}`),
      },
    });
    console.log(`${tag} sdk query() returned, awaiting first message...`);

    for await (const message of result) {
      count++;
      const m = message as { type?: string; subtype?: string };
      console.log(`${tag} msg #${count} type=${m.type ?? "?"} subtype=${m.subtype ?? "-"}`);
      if (res.writableEnded) {
        // 客户端早断了,不再写入(避免 EPIPE),但循环跑完让 SDK 自然清理
        continue;
      }
      writeSse(res, message);
    }

    console.log(`${tag} sdk stream ended normally, total=${count}`);
    if (!res.writableEnded) {
      res.write(`event: done\ndata: ok\n\n`);
      res.end();
    }
  } catch (err) {
    const extra = err && typeof err === "object" ? Object.fromEntries(Object.entries(err as object)) : undefined;
    console.error(`${tag} runReview caught error after ${count} msgs:`, err, extra ? `extra=${JSON.stringify(extra)}` : "");
    const errPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      extra,
    };
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify(errPayload)}\n\n`);
      res.end();
    }
  }
}
