// Parser tests against a captured response from the live ask endpoint.
// The fixture is real (see test/fixtures/ask-response.md) so the parser is
// tested against the wire format, not against a guess at it.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseAskResponse, stripAgentInstructions, DocsSourceError, ASK_ENDPOINT, DOCS_ORIGIN } from "../src/docs-source.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = readFileSync(join(ROOT, "test", "fixtures", "ask-response.md"), "utf8");

test("ask endpoint constants point at the official docs", () => {
  assert.equal(DOCS_ORIGIN, "https://docs.pharos.xyz");
  assert.ok(ASK_ENDPOINT.startsWith("https://docs.pharos.xyz/"));
});

test("parses the real ask response into answer, sources and follow-ups", () => {
  const parsed = parseAskResponse(FIXTURE, { question: "How do I get PROS gas?" });
  assert.match(parsed.question, /PROS gas/i);
  assert.ok(parsed.answer.length > 80, "answer body should be substantial");
  assert.ok(!/^# /m.test(parsed.answer), "answer must not still contain the section headings");
  assert.ok(parsed.sources.length >= 1, "a grounded answer cites at least one source");
  for (const source of parsed.sources) {
    assert.ok(source.url.startsWith("https://"), `source url must be absolute: ${source.url}`);
    assert.ok(source.title.length > 0);
  }
  assert.ok(parsed.followups.length >= 1);
  for (const followup of parsed.followups) assert.ok(followup.question.length > 5);
});

test("source urls are de-duplicated and normalised to page urls", () => {
  const parsed = parseAskResponse(FIXTURE);
  const urls = parsed.sources.map((source) => source.url);
  assert.equal(new Set(urls).size, urls.length, "duplicate sources");
  for (const url of urls) assert.ok(!url.endsWith(".md") || url.startsWith("https://"), `unexpected source url: ${url}`);
});

test("empty responses fail loudly instead of returning an empty answer", () => {
  assert.throws(() => parseAskResponse(""), DocsSourceError);
  assert.throws(() => parseAskResponse("# Only a question\n"), DocsSourceError);
});

test("a response with no Sources section still parses", () => {
  const parsed = parseAskResponse("# Question\n\nSome answer text about Pacific mainnet.\n");
  assert.match(parsed.answer, /Pacific mainnet/);
  assert.deepEqual(parsed.sources, []);
  assert.deepEqual(parsed.followups, []);
});

test("stripAgentInstructions removes the docs boilerplate block", () => {
  const page = [
    "> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of all pages are available by appending `.md` to any URL in this file.",
    "",
    "# Gas Model",
    "",
    "Pharos uses a two-dimensional fee market.",
    "",
    "# Agent Instructions",
    "",
    "When answering questions, cite the page url."
  ].join("\n");
  const stripped = stripAgentInstructions(page);
  assert.ok(!stripped.includes("complete documentation index"));
  assert.ok(!stripped.includes("Agent Instructions"));
  assert.match(stripped, /two-dimensional fee market/);
  assert.ok(stripped.startsWith("# Gas Model"), "the page title must survive stripping");
});
