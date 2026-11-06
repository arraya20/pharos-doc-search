// MCP client and answer pipeline. No network: fetch and the two upstream
// callers are injected, so these tests describe behaviour, not connectivity.
import test from "node:test";
import assert from "node:assert/strict";

import { parseMcpBody, parseMcpAnswer, absolutizeDocLinks, callMcpTool, askMcp, MCP_ENDPOINT } from "../src/mcp.mjs";
import { answerQuestion } from "../src/answer.mjs";
import { DocsSourceError } from "../src/docs-source.mjs";

const ANSWER_TEXT = [
  "Build with `forge build`, then broadcast the script. See [Write Your First Token](/developer-guide/foundry/write-your-first-token).",
  "",
  "# Sources",
  "",
  "- [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)",
  "- [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token)",
  "- [Rust](https://docs.pharos.xyz/developer-guide/rust)"
].join("\n");

function sse(result) {
  return `event: message\r\ndata: ${JSON.stringify({ result, jsonrpc: "2.0", id: 1 })}\r\n\r\n`;
}

function fakeFetch({ status = 200, body }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

test("parseMcpBody reads an SSE data line and a plain JSON body", () => {
  assert.deepEqual(parseMcpBody('event: message\r\ndata: {"result":{"ok":1}}\r\n\r\n'), { result: { ok: 1 } });
  assert.deepEqual(parseMcpBody('{"result":{"ok":2}}'), { result: { ok: 2 } });
});

test("parseMcpBody rejects empty and non-JSON bodies", () => {
  assert.throws(() => parseMcpBody(""), (e) => e instanceof DocsSourceError && e.code === "unparseable");
  assert.throws(() => parseMcpBody("<html>nope</html>"), (e) => e instanceof DocsSourceError && e.code === "unparseable");
});

test("relative doc links become absolute, and .md twins are dropped", () => {
  assert.equal(
    absolutizeDocLinks("see [a](/x/y) and [b](/z.md) and [c](https://e.com/q)"),
    "see [a](https://docs.pharos.xyz/x/y) and [b](https://docs.pharos.xyz/z) and [c](https://e.com/q)"
  );
});

test("parseMcpAnswer splits the answer from its de-duplicated sources", () => {
  const parsed = parseMcpAnswer(ANSWER_TEXT, { question: "q" });
  assert.match(parsed.answer, /forge build/);
  assert.doesNotMatch(parsed.answer, /# Sources/);
  assert.match(parsed.answer, /\(https:\/\/docs\.pharos\.xyz\/developer-guide\/foundry\/write-your-first-token\)/);
  assert.deepEqual(parsed.sources.map((s) => s.url), [
    "https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token",
    "https://docs.pharos.xyz/developer-guide/rust"
  ]);
});

test("parseMcpAnswer keeps an answer that has no sources block", () => {
  const parsed = parseMcpAnswer("I could not find that in the docs.");
  assert.equal(parsed.sources.length, 0);
  assert.match(parsed.answer, /could not find/);
});

test("callMcpTool posts a JSON-RPC tools/call to the docs MCP endpoint", async () => {
  const fetchImpl = fakeFetch({ body: sse({ content: [{ type: "text", text: "hello" }] }) });
  const { text, status } = await callMcpTool("askQuestion", { question: "hi" }, { fetchImpl });
  assert.equal(text, "hello");
  assert.equal(status, 200);

  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, MCP_ENDPOINT);
  assert.equal(init.method, "POST");
  assert.match(init.headers.accept, /text\/event-stream/);
  const rpc = JSON.parse(init.body);
  assert.equal(rpc.method, "tools/call");
  assert.deepEqual(rpc.params, { name: "askQuestion", arguments: { question: "hi" } });
});

test("callMcpTool fails closed on HTTP errors, JSON-RPC errors, tool errors and empty content", async () => {
  await assert.rejects(
    callMcpTool("x", {}, { fetchImpl: fakeFetch({ status: 503, body: "down" }) }),
    (e) => e.code === "upstream_error" && e.status === 503
  );
  await assert.rejects(
    callMcpTool("x", {}, { fetchImpl: fakeFetch({ body: `data: ${JSON.stringify({ error: { code: -32601, message: "no such tool" } })}` }) }),
    (e) => e.code === "upstream_error" && /no such tool/.test(e.message)
  );
  await assert.rejects(
    callMcpTool("x", {}, { fetchImpl: fakeFetch({ body: sse({ isError: true, content: [{ type: "text", text: "boom" }] }) }) }),
    (e) => e.code === "upstream_error" && /boom/.test(e.message)
  );
  await assert.rejects(
    callMcpTool("x", {}, { fetchImpl: fakeFetch({ body: sse({ content: [] }) }) }),
    (e) => e.code === "unparseable"
  );
});

test("callMcpTool reports a hung upstream as a timeout, not an empty result", async () => {
  const hang = (url, { signal }) =>
    new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await assert.rejects(callMcpTool("x", {}, { timeoutMs: 5, fetchImpl: hang }), (e) => e.code === "timeout");
});

test("askMcp returns the same payload shape the CLI prints, tagged via=mcp", async () => {
  const fetchImpl = fakeFetch({ body: sse({ content: [{ type: "text", text: ANSWER_TEXT }] }) });
  const payload = await askMcp("how do I deploy?", { goal: "ship a token", fetchImpl });
  assert.equal(payload.success, true);
  assert.equal(payload.via, "mcp");
  assert.equal(payload.goal, "ship a token");
  assert.equal(payload.sources.length, 2);
  assert.equal(payload.upstream.tool, "askQuestion");
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body).params.arguments, { question: "how do I deploy?", goal: "ship a token" });
});

test("askMcp refuses an empty question without calling upstream", async () => {
  const fetchImpl = fakeFetch({ body: "" });
  await assert.rejects(askMcp("   ", { fetchImpl }), (e) => e.code === "bad_request");
  assert.equal(fetchImpl.calls.length, 0);
});

test("answerQuestion prefers MCP and does not call the fallback endpoint", async () => {
  let askCalled = false;
  const payload = await answerQuestion("q", {
    mcp: async () => ({ success: true, via: "mcp", answer: "a", sources: [] }),
    ask: async () => ((askCalled = true), {})
  });
  assert.equal(payload.via, "mcp");
  assert.equal(askCalled, false);
});

test("answerQuestion falls back to the GitBook ask endpoint when MCP errors, and records why", async () => {
  const payload = await answerQuestion("q", {
    mcp: async () => {
      throw new DocsSourceError("docs MCP returned HTTP 502", { code: "upstream_error", status: 502 });
    },
    ask: async () => ({ success: true, answer: "from ask", sources: [], followups: [] })
  });
  assert.equal(payload.via, "gitbook-ask");
  assert.equal(payload.mcpError.code, "upstream_error");
});

test("answerQuestion does not retry a timeout against a second endpoint", async () => {
  let askCalled = false;
  await assert.rejects(
    answerQuestion("q", {
      mcp: async () => {
        throw new DocsSourceError("slow", { code: "timeout" });
      },
      ask: async () => ((askCalled = true), {})
    }),
    (e) => e.code === "timeout"
  );
  assert.equal(askCalled, false);
});

test("answerQuestion reports both failures when neither endpoint works", async () => {
  await assert.rejects(
    answerQuestion("q", {
      mcp: async () => {
        throw new DocsSourceError("mcp down", { code: "network_error" });
      },
      ask: async () => {
        throw new DocsSourceError("ask down", { code: "upstream_error", status: 500 });
      }
    }),
    (e) => /mcp down/.test(e.message) && /ask down/.test(e.message)
  );
});
