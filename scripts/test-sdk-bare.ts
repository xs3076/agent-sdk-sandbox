/**
 * 终极方案:通过 SDK 的 extraArgs 传 --bare 给底层 claude 二进制。
 *
 * 关键证据(claude --help):
 *   --bare    Minimal mode: skip ... keychain reads ...
 *             Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper
 *             (OAuth and keychain are never read).
 *
 * 配合:
 *   - ANTHROPIC_BASE_URL → BigModel
 *   - ANTHROPIC_API_KEY  → BigModel token(BigModel 已验证接受 x-api-key 头)
 *
 * 用法:
 *   npx tsx scripts/test-sdk-bare.ts <token> [baseUrl] [model] [smallModel]
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const [, , token, baseUrl, model, smallModel] = process.argv;

if (!token) {
  console.error("用法: npx tsx scripts/test-sdk-bare.ts <token> [baseUrl] [model] [smallModel]");
  process.exit(1);
}

const BASE_URL = baseUrl || "https://open.bigmodel.cn/api/anthropic";
const MODEL = model || "glm-5.1";
const SMALL = smallModel || MODEL;
const cwd = mkdtempSync(join(tmpdir(), "claude-sdk-test-"));

console.log("→ --bare 模式(跳过 keychain)");
console.log("→ baseUrl =", BASE_URL);
console.log("→ model =", MODEL, "/ small =", SMALL);
console.log("→ token prefix =", token.slice(0, 8) + "...");
console.log("---");

async function main() {
  const startedAt = Date.now();
  const result = query({
    prompt: "用一句中文回复:你好,你是什么模型?直接回答,不要调用任何工具。",
    options: {
      cwd,
      // 关键:通过 extraArgs 把 --bare 透传给底层 claude 二进制
      extraArgs: { bare: null },
      permissionMode: "bypassPermissions",
      allowedTools: [],
      maxTurns: 3,
      env: {
        ANTHROPIC_BASE_URL: BASE_URL,
        ANTHROPIC_API_KEY: token,
        ANTHROPIC_MODEL: MODEL,
        ANTHROPIC_SMALL_FAST_MODEL: SMALL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: SMALL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: MODEL,
      },
    },
  });

  let textOut = "";
  let cost: number | undefined;
  let modelReported: string | undefined;

  try {
    for await (const message of result) {
      const m = message as Record<string, unknown>;
      const type = String(m.type);
      if (type === "system" && (m as any).subtype === "init") {
        modelReported = (m as any).model;
        console.log(`[system/init] session=${(m as any).session_id} model=${modelReported}`);
      } else if (type === "assistant") {
        for (const block of (m as any).message?.content || []) {
          if (block.type === "text") {
            textOut += block.text;
            process.stdout.write(block.text);
          }
        }
      } else if (type === "result") {
        cost = (m as any).total_cost_usd;
        console.log(`\n[result] subtype=${(m as any).subtype} cost=$${cost}`);
      }
    }
    console.log("\n=================");
    console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log(`回复: ${textOut.slice(0, 120)}${textOut.length > 120 ? "..." : ""}`);
    const isGlm = /GLM|Z\.ai|智谱/i.test(textOut);
    const isClaude = /Claude|Anthropic/i.test(textOut);
    if (isGlm && !isClaude) {
      console.log("\n✓ SDK 走通 BigModel(GLM 回复) —— --bare 成功绕开 keychain");
    } else if (isClaude) {
      console.log("\n✗ 仍是 Anthropic");
    } else {
      console.log("\n? 无法识别归属。modelReported:", modelReported);
    }
  } catch (e) {
    console.error("\n✗ 调用失败:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exitCode = 2;
  }
}

main();
