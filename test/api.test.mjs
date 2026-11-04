// API tests: call the Pages Functions handlers directly with a fake context.
// No network is used — /api/ask is only exercised for its validation paths.
import test from "node:test";
import assert from "node:assert/strict";

import { onRequest as searchHandler } from "../functions/api/search.js";
import { onRequest as metaHandler } from "../functions/api/meta.js";
import { onRequest as docHandler } from "../functions/api/doc.js";
import { onRequest as askHandler } from "../functions/api/ask.js";
import { INDEX_META } from "../src/kb.mjs";

const ORIGIN = "https://doc-search.example";

function ctx(path, init = {}) {
  return { request: new Request(`${ORIGIN}${path}`, init), env: {}, params: {}, waitUntil() {} };
}

async function call(handler, path, init) {
  const response = await handler(ctx(path, init));
  const body = await response.json().catch(() => null);
  return { status: response.status, headers: response.headers, body };
}

test("GET /api/search returns ranked results", async () => {
  const { status, body, headers } = await call(searchHandler, "/api/search?q=chain+id+and+rpc+for+pacific+mainnet&limit=3");
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.results[0].id, "getting-started/network/pacific-mainnet");
  assert.ok(body.results.length <= 3);
  assert.equal(body.runtime, "cloudflare-pages-function");
  assert.equal(headers.get("access-control-allow-origin"), "*");
  assert.match(headers.get("cache-control"), /max-age=300/);
});

test("POST /api/search accepts a JSON body", async () => {
  const { status, body } = await call(searchHandler, "/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "gas model refund", limit: 2 })
  });
  assert.equal(status, 200);
  assert.equal(body.results[0].id, "getting-started/gas-model");
});

test("POST /api/search rejects malformed JSON", async () => {
  const { status, body } = await call(searchHandler, "/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json"
  });
  assert.equal(status, 400);
  assert.equal(body.success, false);
});

test("missing query is a 400 that explains itself", async () => {
  const { status, body } = await call(searchHandler, "/api/search");
  assert.equal(status, 400);
  assert.equal(body.error.code, "missing_query");
  assert.ok(body.pages > 60, "the error should still tell the caller what is available");
  assert.ok(Array.isArray(body.sections));
});

test("unsupported methods are rejected", async () => {
  const { status, body } = await call(searchHandler, "/api/search?q=gas", { method: "DELETE" });
  assert.equal(status, 405);
  assert.equal(body.error.code, "method_not_allowed");
});

test("OPTIONS preflight returns 204 with CORS headers", async () => {
  const response = await searchHandler(ctx("/api/search", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("/api/search?id= returns one page", async () => {
  const { status, body } = await call(searchHandler, "/api/search?id=getting-started/gas-model");
  assert.equal(status, 200);
  assert.equal(body.doc.id, "getting-started/gas-model");
  assert.ok(body.doc.plain.length > 100);
});

test("/api/search?id= with an unknown id is a 404", async () => {
  const { status, body } = await call(searchHandler, "/api/search?id=nope/nothing");
  assert.equal(status, 404);
  assert.equal(body.error.code, "doc_not_found");
});

test("/api/meta reports the same index the code ships", async () => {
  const { status, body } = await call(metaHandler, "/api/meta");
  assert.equal(status, 200);
  assert.equal(body.index.pageCount, INDEX_META.pageCount);
  assert.equal(body.index.contentHash, INDEX_META.contentHash);
  assert.equal(body.index.source, INDEX_META.source);
  assert.ok(body.index.sections.length >= 5);
  const summed = Object.values(body.index.pagesBySection).reduce((a, b) => a + b, 0);
  assert.equal(summed, INDEX_META.pageCount);
  for (const endpoint of ["search", "ask", "doc", "meta"]) assert.ok(body.endpoints[endpoint]);
});

test("/api/doc returns the indexed copy by default", async () => {
  const { status, body } = await call(docHandler, "/api/doc?id=getting-started/gas-model");
  assert.equal(status, 200);
  assert.equal(body.source, "index");
  assert.equal(body.doc.id, "getting-started/gas-model");
  assert.equal(body.index.contentHash, INDEX_META.contentHash);
});

test("/api/doc without an id is a 404, not a crash", async () => {
  const { status, body } = await call(docHandler, "/api/doc");
  assert.equal(status, 404);
  assert.equal(body.error.code, "doc_not_found");
});

test("/api/ask validates input before touching the network", async () => {
  const { status, body } = await call(askHandler, "/api/ask");
  assert.equal(status, 400);
  assert.equal(body.error.code, "missing_question");
});

test("/api/ask rejects an over-long question", async () => {
  const { status, body } = await call(askHandler, `/api/ask?q=${"a".repeat(501)}`);
  assert.equal(status, 400);
  assert.equal(body.error.code, "question_too_long");
});

test("a POST body larger than 8 KB is refused, not buffered", async () => {
  const { status, body } = await call(searchHandler, "/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "x".repeat(9000) })
  });
  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.match(body.error.message, /too large/);
});

test("a JSON array or scalar body is refused", async () => {
  for (const payload of ["[1,2,3]", "\"just a string\"", "42"]) {
    const { status, body } = await call(searchHandler, "/api/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload
    });
    assert.equal(status, 400, `body ${payload} should be refused`);
    assert.match(body.error.message, /JSON object/);
  }
});

test("an empty POST body falls through to the missing-query error", async () => {
  const { status, body } = await call(searchHandler, "/api/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: ""
  });
  assert.equal(status, 400);
  assert.equal(body.error.code, "missing_query");
});

test("unsupported methods are 405 with an allow-style message", async () => {
  const { status, body } = await call(searchHandler, "/api/search", { method: "PUT" });
  assert.equal(status, 405);
  assert.equal(body.error.code, "method_not_allowed");
});

test("OPTIONS is a CORS preflight with no body", async () => {
  const response = await searchHandler(ctx("/api/search", { method: "OPTIONS" }));
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("access-control-allow-methods"), /GET/);
  assert.equal(await response.text(), "");
});

test("/api/doc accepts live=1 as a live switch and reports source=live", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("# Gas Model\n\nRefunds are computed per transaction.\n", {
      status: 200,
      headers: { "content-type": "text/markdown" }
    });
  try {
    const { status, body } = await call(docHandler, "/api/doc?id=getting-started/gas-model&live=1");
    assert.equal(status, 200);
    assert.equal(body.source, "live");
    assert.match(body.markdown, /Refunds are computed/);
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/doc refuses an unknown source instead of defaulting", async () => {
  const { status, body } = await call(docHandler, "/api/doc?id=getting-started/gas-model&source=whatever");
  assert.equal(status, 400);
  assert.equal(body.error.code, "bad_request");
});

test("/api/doc surfaces a soft-404 upstream as 502, and says the index copy survives", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("# Page Not Found\n\nThe page you are looking for does not exist.\n", {
      status: 200,
      headers: { "content-type": "text/markdown" }
    });
  try {
    const { status, body } = await call(docHandler, "/api/doc?id=getting-started/gas-model&source=live");
    assert.equal(status, 502);
    assert.equal(body.error.code, "not_found");
    assert.match(body.error.message, /index copy is still available/);
  } finally {
    globalThis.fetch = original;
  }
});

test("/api/search refuses an unknown section with the valid list attached", async () => {
  const { status, body } = await call(searchHandler, "/api/search?q=gas&section=Nope");
  assert.equal(status, 400);
  assert.equal(body.error.code, "unknown_section");
  assert.ok(body.sections.includes("Getting Started"));
});

test("HEAD is allowed so crawlers and uptime checks do not see 405", async () => {
  const { status } = await call(searchHandler, "/api/search?q=gas", { method: "HEAD" });
  assert.equal(status, 200);
});
