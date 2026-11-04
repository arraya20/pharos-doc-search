// Offline tests: index integrity and ranking behaviour.
// These run with no network access — they assert against the committed index.
import test from "node:test";
import assert from "node:assert/strict";

import { searchDocs, getDoc, listSections, toToolResult, assessConfidence, suggestTerms, INDEX_META, DOCS } from "../src/kb.mjs";

const ORIGIN = "https://docs.pharos.xyz";

test("index has the full page set and no duplicates", () => {
  assert.ok(DOCS.length >= 60, `expected at least 60 pages, got ${DOCS.length}`);
  assert.equal(INDEX_META.pageCount, DOCS.length, "pageCount must match DOCS length");
  const ids = new Set();
  for (const doc of DOCS) {
    assert.ok(doc.id && typeof doc.id === "string", "every page needs an id");
    assert.ok(!ids.has(doc.id), `duplicate id: ${doc.id}`);
    ids.add(doc.id);
  }
});

test("every page points at a real docs.pharos.xyz URL", () => {
  for (const doc of DOCS) {
    assert.ok(doc.url.startsWith(`${ORIGIN}/`), `${doc.id}: url must be on docs.pharos.xyz — got ${doc.url}`);
    assert.ok(doc.mdUrl.startsWith(`${ORIGIN}/`), `${doc.id}: mdUrl must be on docs.pharos.xyz`);
    assert.equal(doc.url, doc.mdUrl.replace(/\.md$/, ""), `${doc.id}: url and mdUrl disagree`);
    assert.ok(doc.title && doc.title.length > 1, `${doc.id}: missing title`);
    assert.ok(doc.section, `${doc.id}: missing section`);
    assert.ok(typeof doc.plain === "string" && doc.plain.length > 40, `${doc.id}: missing plain text`);
    assert.equal(doc.httpStatus, 200, `${doc.id}: indexed from a non-200 response`);
  }
});

test("no page URL is a placeholder or invented host", () => {
  const hosts = new Set(DOCS.map((doc) => new URL(doc.url).host));
  assert.deepEqual([...hosts], ["docs.pharos.xyz"], `unexpected hosts in index: ${[...hosts].join(", ")}`);
});

test("no indexed page is empty after boilerplate stripping", () => {
  for (const doc of DOCS) {
    assert.ok(!/For the complete documentation index/.test(doc.plain), `${doc.id}: llms.txt boilerplate leaked into the index`);
    assert.ok(!/^# Agent Instructions/m.test(doc.text || ""), `${doc.id}: agent instructions block was not stripped`);
  }
});

test("sections are derived and cover every page", () => {
  const sections = listSections();
  assert.ok(sections.length >= 5, `expected several sections, got ${sections.length}`);
  const covered = new Set(DOCS.map((doc) => doc.section));
  for (const section of covered) assert.ok(sections.includes(section), `section ${section} missing from listSections()`);
});

// Each case is a question plus the canonical page that must rank first.
// These are the regression tests that keep ranking honest.
const RANKING = [
  ["what is the chain id and rpc for pacific mainnet", "getting-started/network/pacific-mainnet"],
  ["atlantic testnet network settings", "getting-started/network/atlantic-testnet"],
  ["how do I query a contract with MCP", "tooling-and-infrastructure/mcp"],
  ["gas model refund", "getting-started/gas-model"],
  ["eth_getProof spv proof", "api-and-sdk/eth-getproof"],
  ["safe multisig wallet", "tooling-and-infrastructure/wallets/safe"],
  ["canonical contracts addresses", "getting-started/canonical-contracts"],
  ["x402 payment flow", "developer-guide/x402"],
  ["node monitoring prometheus", "pharos-node-monitoring"],
  ["how to join the validator set", "node-and-validator-guide/node-management"]
];

for (const [query, expectedId] of RANKING) {
  test(`ranks ${expectedId} first for "${query}"`, () => {
    const results = searchDocs(query, { limit: 5 });
    assert.ok(results.length > 0, "expected results");
    assert.equal(results[0].id, expectedId, `expected ${expectedId}, got ${results.map((r) => r.id).join(" > ")}`);
  });
}

test("results carry the fields an agent needs", () => {
  const [first] = searchDocs("deploy contract foundry", { limit: 1 });
  for (const field of ["id", "title", "section", "url", "mdUrl", "snippet", "score", "matchedTerms"]) {
    assert.ok(first[field] !== undefined, `missing ${field}`);
  }
  assert.ok(first.score > 0);
  assert.ok(Array.isArray(first.matchedTerms) && first.matchedTerms.length > 0);
  assert.ok(first.snippet.length > 20, "snippet should be readable prose");
  assert.ok(!first.snippet.includes("|---"), "snippet should not contain markdown table rules");
});

test("snippets keep the document's own casing", () => {
  const [first] = searchDocs("pacific mainnet chain id", { limit: 1 });
  assert.match(first.snippet, /[A-Z]/, "snippet lost capitalisation — offset mapping is off");
});

test("limit and section filters are respected", () => {
  const three = searchDocs("pharos", { limit: 3 });
  assert.equal(three.length, 3);
  const network = searchDocs("network", { limit: 10, section: "Getting Started" });
  assert.ok(network.length > 0);
  for (const doc of network) assert.equal(doc.section, "Getting Started");
});

test("limit is clamped to a sane range", () => {
  assert.equal(searchDocs("pharos", { limit: 0 }).length, 1, "limit 0 should fall back to 1");
  assert.ok(searchDocs("pharos", { limit: 999 }).length <= 50, "limit should be capped");
});

test("gibberish returns no results instead of noise", () => {
  const results = searchDocs("zzzqqqx unrelatedtokenxyzzy", { limit: 5 });
  assert.equal(results.length, 0);
  const payload = toToolResult("zzzqqqx unrelatedtokenxyzzy", results);
  assert.equal(payload.confidence.level, "none");
  assert.ok(payload.suggestions === undefined || Array.isArray(payload.suggestions));
});

test("off-topic questions report low confidence instead of pretending", () => {
  const query = "why is my transaction reverted";
  const results = searchDocs(query, { limit: 3 });
  const confidence = assessConfidence(results, query);
  assert.ok(["low", "none"].includes(confidence.level), `expected low confidence, got ${confidence.level}`);
  assert.ok(confidence.hint, "low confidence must point at the live ask endpoint");
});

test("headline questions report high confidence", () => {
  const query = "what is the chain id and rpc for pacific mainnet";
  const confidence = assessConfidence(searchDocs(query, { limit: 3 }), query);
  assert.equal(confidence.level, "high");
});

test("getDoc resolves ids with slashes, leading slash and .md suffix", () => {
  const base = "getting-started/gas-model";
  assert.ok(getDoc(base));
  assert.equal(getDoc(`/${base}`).id, base);
  assert.equal(getDoc(`${base}.md`).id, base);
  assert.equal(getDoc("does/not/exist"), null);
  assert.equal(getDoc(""), null);
});

test("search is deterministic", () => {
  const a = JSON.stringify(searchDocs("deploy a contract", { limit: 5 }));
  const b = JSON.stringify(searchDocs("deploy a contract", { limit: 5 }));
  assert.equal(a, b);
});

test("toToolResult shape is stable for API consumers", () => {
  const query = "bridge usdc";
  const payload = toToolResult(query, searchDocs(query, { limit: 2 }));
  assert.equal(payload.success, true);
  assert.equal(payload.query, query);
  assert.ok(payload.source.startsWith(ORIGIN));
  assert.equal(payload.index.pages, INDEX_META.pageCount);
  assert.equal(payload.index.contentHash, INDEX_META.contentHash);
  assert.equal(typeof payload.confidence.level, "string");
  assert.ok(Array.isArray(payload.results));
  for (const result of payload.results) assert.equal(result.score > 0, true);
});

test("every ranking case returns a page whose text actually mentions a query term", () => {
  for (const [query, expectedId] of RANKING) {
    const doc = getDoc(expectedId);
    const terms = query.split(/\s+/).filter((word) => word.length > 3);
    const haystack = `${doc.title} ${doc.plain}`.toLowerCase();
    assert.ok(
      terms.some((term) => haystack.includes(term.slice(0, 5))),
      `${expectedId} does not mention any term from "${query}"`
    );
  }
});

test("suggestTerms proposes vocabulary that exists in the index", () => {
  const suggestions = suggestTerms("how do i deploi a contrat");
  assert.ok(suggestions.length > 0, "expected suggestions for a typo");
  const vocabulary = new Set(DOCS.flatMap((doc) => doc.plain.toLowerCase().match(/[a-z0-9_-]{4,}/g) || []));
  for (const suggestion of suggestions) assert.ok(vocabulary.has(suggestion), `${suggestion} is not in the corpus`);
});
