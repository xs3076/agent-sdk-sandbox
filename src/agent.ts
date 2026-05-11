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
 *  - 必须把 process.env 透传进去:SDK 会把这个对象直接作为 spawn 的 env,
 *    Node 语义是"传了 env 就完全替换",不传 PATH/HOME 子进程会立刻退出
 *    (现象是 SDK 报 "Claude Code native binary not found",误导)。
 *  - ANTHROPIC_API_KEY 显式置空,覆盖宿主可能存在的同名变量,避免 SDK 走错 provider。
 *  - 同时设置 ANTHROPIC_DEFAULT_*_MODEL,覆盖 SDK 内部按 tier 路由时可能出现的 fallback。
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
        // 显式指定 Claude Code CLI 路径,绕开 SDK 的 native binary 自动探测
        // (node:20-slim 上探测会错误地找 musl 版本)。
        // 由 Dockerfile `npm install -g @anthropic-ai/claude-code` 安装。
        pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_BIN || "/usr/local/bin/claude",
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
    // 把所有 own enumerable 字段(SDK 常带 code/exitCode/signal/stderr)都打出来
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
