// Soft 404s: the failure mode that quietly poisons an index.
//
// docs.pharos.xyz answers a missing page with HTTP 200 and a "Page Not Found"
// markdown body. A status-code-only check calls that healthy, so the index
// builder, the live page fetcher and the link liveness test all have to look at
// the body. These tests pin that behaviour without touching the network.
import test from "node:test";
import assert from "node:assert/strict";

import { isSoftNotFound as sourceDetects, fetchDocMarkdown, DocsSourceError } from "../src/docs-source.mjs";
import { isSoftNotFound as builderDetects } from "../scripts/build-index.mjs";

const SOFT_404 = [
  "# Page Not Found",
  "",
  "The URL `does-not-exist` does not exist. This page may have been moved, renamed, or deleted.",
  "",
  "## Suggested Pages",
  "",
  "- [Pharos Node Monitoring](https://docs.pharos.xyz/pharos-node-monitoring.md)"
].join("\n");

test("a Page Not Found body is recognised as a soft 404", () => {
  assert.equal(sourceDetects(SOFT_404), true);
  assert.equal(builderDetects(SOFT_404), true);
});

test("leading whitespace does not hide a soft 404", () => {
  assert.equal(sourceDetects(`\n\n  ${SOFT_404}`), true);
  assert.equal(builderDetects(`\n\n  ${SOFT_404}`), true);
});

test("real pages are not mistaken for soft 404s", () => {
  const page = "# Gas Model\n\nPharos uses a two-dimensional fee market.\n";
  assert.equal(sourceDetects(page), false);
  assert.equal(builderDetects(page), false);
  assert.equal(sourceDetects(""), false);
  assert.equal(sourceDetects(undefined), false);
  assert.equal(builderDetects(undefined), false);
});

test("a page that merely mentions 'Page Not Found' mid-document is still a page", () => {
  const page = "# Errors\n\nThe node may answer with \"Page Not Found\" when a path is wrong.\n";
  assert.equal(sourceDetects(page), false);
});

test("fetchDocMarkdown rejects instead of returning the placeholder body", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(SOFT_404, { status: 200, headers: { "content-type": "text/markdown" } });
  try {
    await assert.rejects(
      () => fetchDocMarkdown({ id: "does-not-exist", url: "https://docs.pharos.xyz/does-not-exist", mdUrl: "https://docs.pharos.xyz/does-not-exist.md" }),
      (err) => {
        assert.ok(err instanceof DocsSourceError);
        assert.equal(err.code, "not_found");
        assert.equal(err.status, 200, "the HTTP status is kept, even though it lied");
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchDocMarkdown rejects an empty page", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("   \n\n", { status: 200, headers: { "content-type": "text/markdown" } });
  try {
    await assert.rejects(
      () => fetchDocMarkdown({ id: "empty", url: "https://docs.pharos.xyz/empty", mdUrl: "https://docs.pharos.xyz/empty.md" }),
      (err) => err instanceof DocsSourceError && err.code === "unparseable"
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("fetchDocMarkdown returns real markdown and strips the boilerplate", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      "> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of all pages are available by appending `.md` to any URL in this file.\n\n# Gas Model\n\nTwo-dimensional fee market.\n",
      { status: 200, headers: { "content-type": "text/markdown" } }
    );
  try {
    const live = await fetchDocMarkdown({ id: "gas-model", url: "https://docs.pharos.xyz/gas-model", mdUrl: "https://docs.pharos.xyz/gas-model.md" });
    assert.equal(live.httpStatus, 200);
    assert.match(live.markdown, /^# Gas Model/);
    assert.ok(!live.markdown.includes("complete documentation index"));
    assert.equal(live.url, "https://docs.pharos.xyz/gas-model");
  } finally {
    globalThis.fetch = original;
  }
});
