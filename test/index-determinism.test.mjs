// The index is a derived artifact. If rebuilding it twice produces two different
// files, its hash means nothing and every rebuild shows up as a git diff, which
// trains people to ignore the diff. These tests pin that down.
import test from "node:test";
import assert from "node:assert/strict";
import { hashDocs, contentProjection, readMeta } from "../scripts/build-index.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doc = (over = {}) => ({
  id: "getting-started/gas-model",
  title: "Gas Model",
  section: "Getting Started",
  url: "https://docs.pharos.xyz/getting-started/gas-model",
  mdUrl: "https://docs.pharos.xyz/getting-started/gas-model.md",
  description: "How gas works.",
  headings: ["Gas Model"],
  text: "# Gas Model\n\nbody",
  plain: "body",
  bytes: 1234,
  httpStatus: 200,
  ...over
});

test("the hash ignores timestamps and HTTP metadata", () => {
  const a = doc({ fetchedAt: "2026-11-04T14:02:43Z", httpStatus: 200 });
  const b = doc({ fetchedAt: "2026-12-31T23:59:59Z", httpStatus: 200 });
  assert.equal(hashDocs([a]), hashDocs([b]));
  assert.deepEqual(contentProjection([a]), contentProjection([b]));
});

test("the hash changes when a page's text changes", () => {
  assert.notEqual(hashDocs([doc()]), hashDocs([doc({ text: "# Gas Model\n\nother body" })]));
});

test("the hash changes when a page is added or removed", () => {
  const two = [doc(), doc({ id: "root", title: "Root" })];
  assert.notEqual(hashDocs([doc()]), hashDocs(two));
});

test("the hash is stable across repeated calls", () => {
  const docs = [doc(), doc({ id: "a/b" })];
  assert.equal(hashDocs(docs), hashDocs(docs));
});

test("readMeta round-trips a generated file and tolerates a missing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "index-meta-"));
  try {
    const file = join(dir, "index.generated.mjs");
    await writeFile(
      file,
      'export const INDEX_META = {\n  "contentHash": "deadbeefdeadbeef",\n  "generatedAt": "2026-11-04T14:02:43Z"\n};\n',
      "utf8"
    );
    assert.deepEqual(await readMeta(file), {
      contentHash: "deadbeefdeadbeef",
      generatedAt: "2026-11-04T14:02:43Z"
    });
    assert.equal(await readMeta(join(dir, "nope.mjs")), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
