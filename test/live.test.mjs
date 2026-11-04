// Live tests. Skipped unless RUN_LIVE_TESTS=1, so `npm test` stays offline and
// deterministic. Run with: RUN_LIVE_TESTS=1 npm test
//
// What they prove: every page in the committed index still resolves, and the
// ask endpoint still returns something the parser understands.
import test from "node:test";
import assert from "node:assert/strict";

import { DOCS, INDEX_META } from "../src/kb.mjs";
import { askDocs, fetchDocMarkdown, isSoftNotFound, DocsSourceError } from "../src/docs-source.mjs";

const enabled = process.env.RUN_LIVE_TESTS === "1";
const skip = enabled ? false : "set RUN_LIVE_TESTS=1 to hit the network";

test("every indexed page url is still live", { skip }, async () => {
  const CONCURRENCY = 6;
  const queue = [...DOCS];
  const failures = [];

  async function worker() {
    while (queue.length) {
      const doc = queue.shift();
      try {
        const response = await fetch(doc.mdUrl, { method: "GET", signal: AbortSignal.timeout(20_000) });
        const body = await response.text();
        if (!response.ok) failures.push(`${doc.id} → HTTP ${response.status}`);
        // HTTP 200 with a "Page Not Found" body is the failure this test exists to catch.
        else if (isSoftNotFound(body)) failures.push(`${doc.id} → soft 404 (HTTP 200, Page Not Found body)`);
      } catch (err) {
        failures.push(`${doc.id} → ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  assert.deepEqual(failures, [], `${failures.length}/${DOCS.length} pages failed`);
});

test("the live docs still list every page we indexed", { skip }, async () => {
  const response = await fetch(INDEX_META.source, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200);
  const body = await response.text();
  const missing = DOCS.filter((doc) => !body.includes(doc.id.replace(/^\/+/, ""))).map((doc) => doc.id);
  assert.deepEqual(missing, [], "pages indexed but no longer listed in llms.txt");
});

test("ask returns a grounded answer with sources", { skip }, async () => {
  const payload = await askDocs("How do I get PROS gas?", { goal: "fund a test wallet", timeoutMs: 60_000 });
  assert.equal(payload.success, true);
  assert.ok(payload.answer.length > 100);
  assert.ok(payload.sources.length >= 1);
  assert.equal(payload.upstream.httpStatus, 200);
  for (const source of payload.sources) assert.ok(source.url.startsWith("https://docs.pharos.xyz/"));
});

test("a live page fetch matches the indexed copy closely enough", { skip }, async () => {
  const doc = DOCS.find((item) => item.id === "getting-started/network/pacific-mainnet");
  assert.ok(doc, "expected the pacific mainnet page in the index");
  const live = await fetchDocMarkdown(doc, { timeoutMs: 20_000 });
  assert.equal(live.httpStatus, 200);
  assert.match(live.markdown, /1672/, "the live mainnet page should still carry chain id 1672");
  assert.ok(!/For the complete documentation index/.test(live.markdown), "boilerplate should be stripped from live fetches too");
});

test("an unknown page id fails closed", { skip }, async () => {
  await assert.rejects(() => fetchDocMarkdown({ id: "x", mdUrl: "https://docs.pharos.xyz/does-not-exist.md" }), DocsSourceError);
});
