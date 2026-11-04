// GitBook escapes punctuation in its markdown export, and does it inconsistently:
// `wss\://` next to `wss://`, `api\_key` next to `apikey`, and sometimes a doubled
// `\\_`. That backslash is markup, not content. If it survives into the index it
// shows up verbatim in every title, heading and snippet the CLI and the web page
// print, which is why this is pinned twice: on the helper, and on the artifact.
import { test } from "node:test";
import assert from "node:assert/strict";

import { DOCS } from "../src/kb.mjs";
import * as build from "../scripts/build-index.mjs";

test("unescapeMarkdown removes the backslash from escaped punctuation", () => {
  assert.equal(build.unescapeMarkdown("eth\\_getProof"), "eth_getProof");
  assert.equal(build.unescapeMarkdown("a\\*b"), "a*b");
  assert.equal(build.unescapeMarkdown("\\[not a link\\]"), "[not a link]");
  assert.equal(build.unescapeMarkdown("\\`code\\`"), "`code`");
});

test("unescapeMarkdown collapses the doubled escapes GitBook also emits", () => {
  assert.equal(build.unescapeMarkdown("wss\\\\://api.zan.top"), "wss://api.zan.top");
  assert.equal(build.unescapeMarkdown("{api\\\\_key}"), "{api_key}");
});

test("unescapeMarkdown leaves backslashes before letters and digits alone", () => {
  // `C:\\Users` and a `\n` escape are content, not markdown punctuation. Halving
  // them would corrupt every Windows path and code sample in the docs.
  assert.equal(build.unescapeMarkdown("C:\\\\Users\\\\name"), "C:\\Users\\name");
  assert.equal(build.unescapeMarkdown("print('a\\nb')"), "print('a\\nb')");
  assert.equal(build.unescapeMarkdown("nothing to do"), "nothing to do");
});

test("titles, headings and plain text come out of the extractors unescaped", () => {
  assert.equal(build.extractTitle("# eth\\_getProof — SPV", "fallback"), "eth_getProof — SPV");
  assert.deepEqual(build.extractHeadings("## eth\\_gasPrice\n### \\[optional\\] params"), [
    "eth_gasPrice",
    "[optional] params"
  ]);
  assert.equal(build.toPlainText("Use `eth\\_getProof` on mainnet."), "Use eth_getProof on mainnet.");
});

test("no page in the built index carries a markdown escape", () => {
  const escaped = /\\[_*[\]`|]/;
  const dirty = DOCS.filter(
    (doc) => escaped.test(doc.title) || escaped.test(doc.description) || escaped.test(doc.plain)
  ).map((doc) => doc.id);
  assert.deepEqual(dirty, [], "escapes leaked into the artifact");
  const dirtyHeadings = DOCS.filter((doc) => doc.headings.some((h) => escaped.test(h))).map((doc) => doc.id);
  assert.deepEqual(dirtyHeadings, [], "escapes leaked into headings");
});

test("the raw markdown body keeps its escapes, so `doc` can still print source", () => {
  // Only the display/search projections are unescaped. `text` is the page's
  // markdown verbatim — unescaping it would hand back subtly different source.
  const withEscapes = DOCS.filter((doc) => /\\[_*[\]`]/.test(doc.text));
  assert.ok(withEscapes.length > 0, "expected at least one page with escaped markdown");
  assert.ok(withEscapes.every((doc) => doc.text !== doc.plain));
});
