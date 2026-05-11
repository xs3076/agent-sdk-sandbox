/**
 * 显式 HTTP 调用 BigModel 的 Anthropic-skin 接口,完全绕开 Claude Agent SDK
 * 与 macOS keychain 的优先级问题,直接验证:endpoint / token / model 三者是否正确。
 *
 * 用法:
 *   npx tsx scripts/test-direct.ts <baseUrl> <authToken> <model>
 *
 * 示例:
 *   npx tsx scripts/test-direct.ts \
 *     https://open.bigmodel.cn/api/anthropic \
 *     671c36b28e... \
 *     glm-5.1
 */

const [, , baseUrl, authToken, model] = process.argv;

if (!baseUrl || !authToken || !model) {
  console.error("用法: npx tsx scripts/test-direct.ts <baseUrl> <authToken> <model>");
  process.exit(1);
}

const url = baseUrl.replace(/\/$/, "") + "/v1/messages";

console.log("→ POST", url);
console.log("→ model =", model);
console.log("→ token prefix =", authToken.slice(0, 8) + "...");
console.log("---");

async function main() {
  const startedAt = Date.now();
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${authToken}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: "用一句中文回复:你好,你是什么模型?请直接回答。",
          },
        ],
      }),
    });
  } catch (e) {
    console.error("✗ 网络错误:", e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  const ctype = resp.headers.get("content-type") || "";
  const bodyText = await resp.text();

  console.log("← HTTP", resp.status, resp.statusText, `(${elapsed}s)`);
  console.log("← content-type:", ctype);
  console.log("← body:");
  // 漂亮打印 JSON
  try {
    const parsed = JSON.parse(bodyText);
    console.log(JSON.stringify(parsed, null, 2));
  } catch {
    console.log(bodyText);
  }

  if (resp.status !== 200) {
    console.error(`\n✗ HTTP ${resp.status} — 调用失败`);
    process.exit(3);
  }
  console.log("\n✓ BigModel 接口直连成功");
}

main();
