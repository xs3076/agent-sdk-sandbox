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
 *
 * 设计要点:
 * 1. Provider 通过环境变量接入,Key 来自请求 body(避免镜像层泄漏)。
 * 2. 多轮对话靠 SDK 的 resume 参数,不在调用方拼历史。
 * 3. settingSources: ["project"] 让 SDK 读取仓库内的 .claude/skills。
 * 4. maxTurns 50 防止 agent 失控烧钱。
 */
export async function runReview(req: ReviewRequest, res: Response): Promise<void> {
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

    // 流式消费 SDK 输出,每条消息原样转成一行 SSE 推送。
    for await (const message of result) {
      writeSse(res, message);
    }

    // 正常结束时发送 done 事件(供上游识别流末尾)。
    res.write(`event: done\ndata: ok\n\n`);
    res.end();
  } catch (err) {
    // 异常通过 SSE 的 event: error 推到上游(设计文档要求 #8)。
    const errPayload = {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    };
    res.write(`event: error\ndata: ${JSON.stringify(errPayload)}\n\n`);
    res.end();
  }
}
