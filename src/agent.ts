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
 * 关键(踩坑):
 *  - ANTHROPIC_API_KEY 必须显式设为空字符串,不能不设也不能 null;否则 SDK
 *    可能从其他来源(如本机 ~/.claude 配置)拿到一个 key 去走 Anthropic 官方。
 *  - 同时设置 ANTHROPIC_DEFAULT_HAIKU_MODEL / _SONNET_MODEL / _OPUS_MODEL,
 *    覆盖 SDK 内部按 tier 路由时可能出现的 fallback。
 */
export function buildSdkEnv(req: ReviewRequest): Record<string, string> {
  const model = req.model;
  const small = req.smallModel || req.model;
  return {
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
 */
export async function runReview(req: ReviewRequest, res: Response, reqId: string): Promise<void> {
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
        allowedTools: ALLOWED_TOOLS,
        maxTurns: 50,
        settingSources: ["project"],
        env: buildSdkEnv(req),
      },
    });
    console.log(`${tag} sdk query() returned, awaiting first message...`);

    for await (const message of result) {
      count++;
      const m = message as { type?: string; subtype?: string };
      console.log(`${tag} msg #${count} type=${m.type ?? "?"} subtype=${m.subtype ?? "-"}`);
      writeSse(res, message);
    }

    console.log(`${tag} sdk stream ended normally, total=${count}`);
    res.write(`event: done\ndata: ok\n\n`);
    res.end();
  } catch (err) {
    console.error(`${tag} runReview caught error after ${count} msgs:`, err);
    const errPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    if (!res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify(errPayload)}\n\n`);
      res.end();
    }
  }
}
