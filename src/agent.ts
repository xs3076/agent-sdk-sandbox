import type { Response } from "express";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { getBinaryPath } from "./binary";
import type { AgentRunRequest } from "./types";

// 安全模型:本服务以 bypassPermissions 启动 SDK,Edit/Write 与绝大多数 Bash 都直通,
// 沙箱边界主要靠部署侧(容器/VM)。在此之上,denyGitWriteHook 用 PreToolUse 钩子
// 强制拦截会"提交/推送/改写仓库历史"的 git 子命令——SDK 类型注释明确:
// "PreToolUse hook denies bypass canUseTool",hook 的 deny 决策能覆盖 bypassPermissions,
// 比 disallowedTools 更硬,且能把 reason 反馈给 LLM 阻止它换种写法反复重试。
//
// 仅拦改写仓库历史/远端的子命令;只动工作区/index 的 add/checkout/reset/stash 不拦——
// agent 干活经常要用,且不会让代码"提交出去"。

// `git` 后允许跟若干 `-x` / `--xxx[=...]` 全局选项(如 `git -c user.name=x commit`),
// 再匹配被禁子命令。\b 保证 `commit` 不会误中 `committed` 之类。
const BANNED_GIT_SUBCMD =
  /\bgit(?:\s+-{1,2}[^\s]+)*\s+(commit|commit-tree|push|tag|update-ref|fast-import|replace|notes)\b/;

const denyGitWriteHook: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (input.tool_name !== "Bash") return {};
  const cmd = String((input.tool_input as { command?: unknown })?.command ?? "");
  if (!BANNED_GIT_SUBCMD.test(cmd)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "本沙箱禁止改写仓库历史/远端的 git 子命令(commit/commit-tree/push/tag/update-ref/fast-import/replace/notes);" +
        "允许 status/diff/log/show/add/checkout/reset/stash 等本地操作,文件写入(Edit/Write)不受限。",
    },
  };
};

function writeSse(res: Response, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function buildSdkEnv(req: AgentRunRequest): Record<string, string> {
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

export async function runAgent(
  req: AgentRunRequest,
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
        allowedTools: req.allowedTools,
        // 服务侧硬性边界:禁 git 提交/推送/改历史。文件写入与其它工具不受影响。
        hooks: {
          PreToolUse: [{ hooks: [denyGitWriteHook] }],
        },
        maxTurns: req.maxTurns ?? 50,
        // user: 加载 ~/.claude/skills(全局 skill,挂载点);project: 加载 cwd/.claude/(CLAUDE.md + 项目 skill)
        settingSources: ["user", "project"],
        // 显式开启所有 skill,避免依赖 CLI 隐式默认
        skills: "all",
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
