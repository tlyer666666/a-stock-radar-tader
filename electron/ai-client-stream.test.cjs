"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createAiClient } = require("./ai-client.cjs");

test("long reasoning SSE streams (>2MB wire framing) succeed through the real HTTP policy ceiling while bounded above 16MB", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  const makeStreamResponse = (chunkCount) => {
    const line = `data: ${JSON.stringify({
      id: "chatcmpl-9f3b2c1a-7d4e-4f5a-8b6c-1d2e3f4a5b6c",
      object: "chat.completion.chunk",
      created: 1789000000,
      model: "deepseek-reasoner",
      system_fingerprint: "fp_1a2b3c4d5e_prod0820",
      choices: [{ index: 0, delta: { content: null, reasoning_content: "推演" }, finish_reason: null }]
    })}\n\n`;
    const lineBytes = Buffer.from(line, "utf8");
    const finalBytes = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: "{\"ok\":true}" } }] })}\n\ndata: [DONE]\n\n`, "utf8");
    let sent = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (sent < chunkCount) {
          const batch = Math.min(200, chunkCount - sent);
          sent += batch;
          controller.enqueue(Buffer.concat(Array.from({ length: batch }, () => lineBytes)));
          return;
        }
        controller.enqueue(finalBytes);
        controller.close();
      }
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  let targetChunks = 9000;
  global.fetch = async () => makeStreamResponse(targetChunks);

  const client = createAiClient({
    getConfig: () => ({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", apiKey: "sk-test" })
  });
  let streamed = "";
  const ok = await client.chat({ system: "s", user: "u", json: true, onToken: (_delta, full) => { streamed = full; } });
  assert.deepEqual(ok, { ok: true });
  assert.equal(streamed, "{\"ok\":true}");

  targetChunks = 60000;
  await assert.rejects(
    client.chat({ system: "s", user: "u", json: true, onToken: () => {} }),
    /上限|AI_HTTP/
  );
});
