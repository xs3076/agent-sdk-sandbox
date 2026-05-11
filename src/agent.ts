import type { Response } from "express";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getBinaryPath } from "./binary";
import type { ReviewRequest } from "./types";

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
