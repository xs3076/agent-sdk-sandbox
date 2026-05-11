import type { Response } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getBinaryPath } from "./binary";
import type { ReviewRequest } from "./types";

// 只读工具白名单。任何能写 / 能执行任意代码的命令(awk/sed/xargs/python/node/
// curl/tar/cp/mv/mkdir/rm 等)一律不放,从源头杜绝对仓库的修改与外发。
// 网络读取只通过 WebFetch/WebSearch,不开 Bash(curl/wget)。
const ALLOWED_TOOLS = [
  // SDK 内置只读
  "Read",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  // git 只读子命令
  "Bash(git log:*)",
  "Bash(git diff:*)",
  "Bash(git show:*)",
  "Bash(git blame:*)",
  "Bash(git status:*)",
  // POSIX 只读
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(find:*)",
  "Bash(diff:*)",
  "Bash(file:*)",
  "Bash(stat:*)",
  "Bash(tree:*)",
  "Bash(jq:*)",
  // 环境信息
  "Bash(pwd:*)",
  "Bash(env:*)",
  "Bash(date:*)",
  "Bash(which:*)",
  "Bash(type:*)",
  "Bash(whoami:*)",
];

function writeSse(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

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

export async function runReview(
  req: ReviewRequest,
  res: Response,
  reqId: string,
  abortController: AbortController,
): Promise<void> {
  const tag = `[req ${reqId}]`;
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
        pathToClaudeCodeExecutable: getBinaryPath(),
        stderr: (data: string) => console.error(`${tag} [sdk-stderr] ${data.trimEnd()}`),
      },
    });

    for await (const message of result) {
      count++;
      if (!res.writableEnded) writeSse(res, message);
    }

    console.log(`${tag} stream ended, total=${count}`);
    if (!res.writableEnded) {
      res.write(`event: done\ndata: ok\n\n`);
      res.end();
    }
  } catch (err) {
    console.error(`${tag} error after ${count} msgs:`, err);
    if (!res.writableEnded) {
      const payload = { message: err instanceof Error ? err.message : String(err) };
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    }
  }
}
