/**
 * 用 SDK 的 apiKeyHelper 选项显式注入 token,尝试绕开 macOS keychain
 * 的"Claude Code-credentials"自动认证,把 SDK 切到 BigModel。
 *
 * 思路:
 *  - apiKeyHelper 接收"输出 API key 的脚本路径",SDK 调它取 key 注入到请求头
 *  - 比 env 变量优先级高(SDK 显式 option 通常压过自动凭证查找)
 *  - 临时写一个 echo token 的 .sh 到 /tmp,运行完丢弃
 *
 * 用法:
 *   npx tsx scripts/test-sdk-helper.ts <token> [baseUrl] [model] [smallModel]
 *
 * 示例:
 *   npx tsx scripts/test-sdk-helper.ts 671c36b... https://open.bigmodel.cn/api/anthropic glm-5.1 glm-4.5-air
 */

import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

const [, , token, baseUrl, model, smallModel] = process.argv;

if (!token) {
  console.error("用法: npx tsx scripts/test-sdk-helper.ts <token> [baseUrl] [model] [smallModel]");
  process.exit(1);
}

const BASE_URL = baseUrl || "https://open.bigmodel.cn/api/anthropic";
const MODEL = model || "glm-5.1";
const SMALL = smallModel || MODEL;

// 写临时 helper 脚本(只能当前用户执行,避免泄漏)
const helperDir = mkdtempSync(join(tmpdir(), "bigmodel-helper-"));
const helperPath = join(helperDir, "get-key.sh");
writeFileSync(helperPath, `#!/bin/sh\nprintf '%s' '${token.replace(/'/g, "'\\''")}'\n`);
chmodSync(helperPath, 0o700);

const cwd = mkdtempSync(join(tmpdir(), "claude-sdk-test-"));

console.log("→ apiKeyHelper =", helperPath);
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
      apiKeyHelper: helperPath,
      permissionMode: "bypassPermissions",
      allowedTools: [],
      maxTurns: 3,
      // settingSources 不传——避免读取用户级 settings 引入更多干扰
      env: {
        ANTHROPIC_BASE_URL: BASE_URL,
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
        console.log(`[system/init] session=${(m as any).session_id} model=${(m as any).model}`);
        modelReported = (m as any).model;
      } else if (type === "assistant") {
        const content = (m as any).message?.content || [];
        for (const block of content) {
          if (block.type === "text") {
            textOut += block.text;
            process.stdout.write(block.text);
          }
        }
      } else if (type === "result") {
        cost = (m as any).total_cost_usd;
        console.log(`\n[result] subtype=${(m as any).subtype} cost=$${cost} model=${(m as any).model || modelReported}`);
      }
    }

    console.log("\n=================");
    console.log(`耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    console.log(`回复文本: ${textOut.slice(0, 100)}${textOut.length > 100 ? "..." : ""}`);

    // 判断是 BigModel 还是 Anthropic
    const looksLikeGlm = /GLM|Z\.ai|智谱/i.test(textOut);
    const looksLikeClaude = /Claude|Anthropic/i.test(textOut);
    if (looksLikeGlm && !looksLikeClaude) {
      console.log("\n✓ SDK 走通 BigModel(GLM 回复)");
    } else if (looksLikeClaude) {
      console.log("\n✗ SDK 仍走 Anthropic,apiKeyHelper 未覆盖 keychain");
    } else {
      console.log("\n? 回复无法识别归属,看模型字段:", modelReported);
    }
  } catch (e) {
    console.error("\n✗ 调用失败:", e instanceof Error ? e.message : String(e));
    if (e instanceof Error && e.stack) console.error(e.stack);
    process.exitCode = 2;
  } finally {
    // 清理临时 helper
    try { rmSync(helperDir, { recursive: true, force: true }); } catch {}
  }
}

main();
