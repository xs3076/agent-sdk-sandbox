/**
 * 最小验证脚本:跳过 Express,直接用 Claude Agent SDK 调一次,
 * 用于排查 SDK + 第三方网关(BigModel / OpenRouter 等 Anthropic-skin)的接通性。
 *
 * 用法:
 *   cd agent
 *   export ANTHROPIC_AUTH_TOKEN=xxxxx
 *   export ANTHROPIC_BASE_URL=https://open.bigmodel.cn/api/anthropic
 *   export ANTHROPIC_MODEL=glm-4.5
 *   export ANTHROPIC_SMALL_FAST_MODEL=glm-4.5-air
 *   npx tsx scripts/test-sdk.ts
 *
 * 若想换 prompt:
 *   export PROMPT="评审 src/agent.ts 的代码风格"
 *   npx tsx scripts/test-sdk.ts
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ 缺少环境变量 ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const baseUrl = requireEnv("ANTHROPIC_BASE_URL");
  const authToken = requireEnv("ANTHROPIC_AUTH_TOKEN");
  const model = requireEnv("ANTHROPIC_MODEL");

  // 默认 prompt:一个不需要工具调用的简单问候,纯验证连通性
  const prompt = process.env.PROMPT || "用一句中文回复:hello,你叫什么模型?直接回答,不要调用任何工具。";

  // 用一个临时目录当 cwd,SDK 需要(就算不读文件也要)
  const cwd = mkdtempSync(join(tmpdir(), "claude-sdk-test-"));

  // 透传所有相关环境变量给 SDK 子进程。
  // 必须显式设 ANTHROPIC_API_KEY="" —— 踩坑:不能不设、不能 null。
  const envForSdk: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: authToken,
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_MODEL: model,
  };
  for (const k of [
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) {
    const v = process.env[k];
    if (v) envForSdk[k] = v;
  }

  console.log("→ cwd =", cwd);
  console.log("→ baseUrl =", baseUrl);
  console.log("→ env =", Object.fromEntries(
    Object.entries(envForSdk).map(([k, v]) => [k, k === "ANTHROPIC_AUTH_TOKEN" ? "***" : v])
  ));
  console.log("→ prompt =", prompt);
  console.log("---");

  const startedAt = Date.now();

  const result = query({
    prompt,
    options: {
      cwd,
      permissionMode: "bypassPermissions",
      // 不给任何工具——纯文本对话即可验证 LLM 通路
      allowedTools: [],
      // 限制为 3 轮,出错时不会无限循环
      maxTurns: 3,
      env: envForSdk,
    },
  });

  let textOut = "";
  let sessionId: string | undefined;
  let cost: number | undefined;

  try {
    for await (const message of result) {
      // 简化打印:按 type 区分,主要看 system/init、assistant.text、result
      const m = message as Record<string, unknown>;
      const type = String(m.type);

      if (type === "system" && (m as any).subtype === "init") {
        sessionId = (m as any).session_id;
        console.log(`[system/init] session_id=${sessionId} tools=${((m as any).tools || []).length}`);
      } else if (type === "assistant") {
        const content = (m as any).message?.content || [];
        for (const block of content) {
          if (block.type === "text") {
            textOut += block.text;
            process.stdout.write(block.text);
          } else if (block.type === "tool_use") {
            console.log(`\n[tool_use] ${block.name} ${JSON.stringify(block.input)}`);
          }
        }
      } else if (type === "user") {
        const content = (m as any).message?.content || [];
        for (const block of content) {
          if (block.type === "tool_result") {
            const preview = typeof block.content === "string"
              ? block.content.slice(0, 200)
              : JSON.stringify(block.content).slice(0, 200);
            console.log(`\n[tool_result] ${preview}${preview.length >= 200 ? "..." : ""}`);
          }
        }
      } else if (type === "result") {
        cost = (m as any).total_cost_usd;
        console.log(`\n---\n[result] subtype=${(m as any).subtype} cost=$${cost ?? "?"} session_id=${(m as any).session_id}`);
      } else {
        console.log(`[${type}] (其他事件)`);
      }
    }

    console.log("\n=================");
    console.log(`✓ 通路验证成功,耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    if (textOut) {
      console.log("文本回复长度:", textOut.length);
    }
    if (cost !== undefined) {
      console.log("成本:$", cost);
    }
  } catch (e) {
    console.error("\n=================");
    console.error("✗ 通路验证失败:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) {
      console.error(e.stack);
    }
    process.exit(2);
  }
}

main();
