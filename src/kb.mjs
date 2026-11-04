// Search engine over the generated Pharos documentation index.
//
// The index is a build artifact (see scripts/build-index.mjs) fetched from
// https://docs.pharos.xyz/llms.txt. Nothing here invents content: every result
// carries the official page URL and markdown URL it came from.
//
// Ranking is BM25 over weighted fields (title > headings > description > id >
// body) plus a phrase bonus. Small enough to run in a Worker, a CLI, or a
// browser tab with no dependencies.

import { DOCS, INDEX_META } from "./index.generated.mjs";

export { DOCS, INDEX_META };

const K1 = 1.4;
const B = 0.72;
const FIELD_WEIGHTS = { title: 5.0, headings: 3.0, description: 2.0, id: 1.6, text: 1.0 };
const SNIPPET_RADIUS = 170;

const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "by", "can", "do", "does",
  "for", "from", "get", "give", "how", "i", "in", "into", "is", "it", "its", "me", "my",
  "of", "on", "or", "should", "show", "tell", "that", "the", "there", "these", "this",
  "to", "use", "using", "want", "was", "what", "when", "where", "which", "who", "why",
  "will", "with", "you", "your", "explain", "please", "help", "need"
]);

// Domain vocabulary that natural-language questions use but docs spell differently.
// Kept deliberately small and auditable — no fuzzy guessing.
const ALIASES = {
  chainid: ["chain", "id"],
  rpc: ["rpc", "endpoint"],
  endpointurl: ["rpc"],
  testnet: ["atlantic"],
  mainnet: ["pacific"],
  gasfee: ["gas", "fee"],
  gasprice: ["gas"],
  smartcontract: ["contract"],
  solidity: ["foundry", "contract"],
  staking: ["validator", "stake"],
  stake: ["staking", "validator"],
  nft: ["token", "erc721"],
  erc20: ["token", "standard"],
  deploy: ["deploy", "deployment"],
  deployment: ["deploy"],
  walletconnect: ["wallet"],
  faucet: ["gas", "testnet"],
  indexer: ["indexing"],
  oracle: ["oracles"],
  bridge: ["cross", "chain"],
  multisig: ["safe"],
  skillengine: ["skill", "engine"],
  mcp: ["mcp", "model", "context", "protocol"],
  dryrun: ["simulation", "estimate"],
  estimate: ["gas"],
  errors: ["revert", "error"],
  revert: ["error", "revert"],
  install: ["setup", "install"],
  node: ["node", "validator"]
};

function normalize(text) {
  return String(text || "").toLowerCase();
}

export function tokenize(text) {
  const raw = normalize(text).replace(/[^a-z0-9_\-.\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (const token of raw) {
    const cleaned = token.replace(/^[.\-]+|[.\-]+$/g, "");
    if (!cleaned) continue;
    // Keep dotted/hyphenated identifiers searchable both whole and in parts.
    out.push(cleaned);
    if (/[.\-_]/.test(cleaned)) {
      for (const part of cleaned.split(/[.\-_]+/)) if (part.length > 2) out.push(part);
    }
  }
  return out;
}

function queryTerms(query) {
  const base = tokenize(query).filter((t) => t.length > 1 && !STOPWORDS.has(t));
  const expanded = new Set(base);
  for (const term of base) {
    const squeeze = term.replace(/[_\-.]/g, "");
    if (ALIASES[squeeze]) for (const alias of ALIASES[squeeze]) expanded.add(alias);
    if (ALIASES[term]) for (const alias of ALIASES[term]) expanded.add(alias);
  }
  return { base, all: [...expanded] };
}

function termFrequency(tokens) {
  const tf = new Map();
  for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
  return tf;
}

// --- index-time precomputation -------------------------------------------

const CORPUS = DOCS.map((doc) => {
  const fields = {
    title: termFrequency(tokenize(doc.title)),
    headings: termFrequency(tokenize(doc.headings.join(" "))),
    description: termFrequency(tokenize(doc.description)),
    id: termFrequency(tokenize(doc.id.replace(/[/\-_.]/g, " "))),
    text: termFrequency(tokenize(doc.plain || doc.text))
  };
  const lengths = Object.fromEntries(
    Object.entries(fields).map(([field, tf]) => [field, [...tf.values()].reduce((a, b) => a + b, 0) || 0])
  );
  return {
    doc,
    fields,
    lengths,
    searchable: normalize([doc.title, doc.description, doc.headings.join(" "), doc.plain || doc.text, doc.id].join(" "))
  };
});

const AVG_LEN = {};
for (const field of Object.keys(FIELD_WEIGHTS)) {
  const total = CORPUS.reduce((acc, entry) => acc + entry.lengths[field], 0);
  AVG_LEN[field] = total / CORPUS.length || 1;
}

const DOC_FREQ = new Map();
for (const entry of CORPUS) {
  const seen = new Set();
  for (const field of Object.keys(FIELD_WEIGHTS)) {
    for (const term of entry.fields[field].keys()) seen.add(term);
  }
  for (const term of seen) DOC_FREQ.set(term, (DOC_FREQ.get(term) || 0) + 1);
}

function idf(term) {
  const df = DOC_FREQ.get(term) || 0;
  return Math.log(1 + (CORPUS.length - df + 0.5) / (df + 0.5));
}

// --- public API -----------------------------------------------------------

export function listSections() {
  return INDEX_META.sections.slice();
}

export function getDoc(id) {
  if (!id) return null;
  const want = String(id).trim().replace(/^\/+/, "").replace(/\.md$/, "");
  return DOCS.find((doc) => doc.id === want) || null;
}

export function searchDocs(query, options = {}) {
  const opts = typeof options === "number" ? { limit: options } : options || {};
  const requested = Number(opts.limit);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(Math.trunc(requested), 50)) : 5;
  const section = opts.section || opts.category || null;

  let pool = CORPUS;
  if (section && section.toLowerCase() !== "all") {
    const want = section.toLowerCase();
    pool = pool.filter((entry) => entry.doc.section.toLowerCase() === want);
  }

  const trimmed = String(query || "").trim();
  // An empty query has no answer. Returning the first N pages would look like a
  // match list to any caller that does not re-check the input; callers that want
  // a listing should read DOCS directly.
  if (!trimmed) return [];

  const { base, all } = queryTerms(trimmed);
  if (all.length === 0) return [];
  // Raw query tokens (stopwords included) are used for "does the query name
  // this page's title" checks — "how do I write my first NFT" names the page.
  const rawTokens = new Set(tokenize(trimmed));

  const scored = [];
  for (const entry of pool) {
    let score = 0;
    const matchedTerms = [];

    for (const term of all) {
      const weight = base.includes(term) ? 1 : 0.6;
      let termScore = 0;
      for (const [field, fieldWeight] of Object.entries(FIELD_WEIGHTS)) {
        const tf = entry.fields[field].get(term);
        if (!tf) continue;
        const lenNorm = entry.lengths[field] / AVG_LEN[field];
        const denom = tf + K1 * (1 - B + B * lenNorm);
        termScore += fieldWeight * idf(term) * ((tf * (K1 + 1)) / denom);
      }
      if (termScore > 0) {
        score += termScore * weight;
        matchedTerms.push(term);
      }
    }

    // Title coverage: when the query names the page's subject outright, that
    // page should lead. "chain id and rpc for pacific mainnet" must resolve to
    // the Pacific Mainnet page, not to a guide that merely mentions those words
    // in a table. Partial coverage only nudges; full coverage multiplies.
    const titleTokens = new Set(tokenize(entry.doc.title));
    if (titleTokens.size) {
      let covered = 0;
      for (const token of titleTokens) if (rawTokens.has(token)) covered++;
      const coverage = covered / titleTokens.size;
      score += 7 * coverage;
      if (coverage === 1 && titleTokens.size >= 2) score *= 1.75;
    }

    // Whole-phrase bonus: a query that appears verbatim is a strong signal.
    const phrase = normalize(trimmed).replace(/\s+/g, " ");
    if (phrase.length > 3) {
      const fields = [
        [normalize(entry.doc.title), 14],
        [normalize(entry.doc.headings.join(" ")), 8],
        [normalize(entry.doc.description), 6],
        [entry.searchable, 3]
      ];
      for (const [haystack, bonus] of fields) {
        if (haystack.includes(phrase)) {
          score += bonus;
          break;
        }
      }
    }

    // Query coverage, weighted by term rarity: missing a rare operative word
    // ("stake") must hurt more than missing a common one ("wallet"). Without
    // this, a page that only repeats the object of the question outranks the
    // page that actually answers it.
    const uniqueBase = [...new Set(base)];
    if (uniqueBase.length > 1) {
      let idfTotal = 0;
      let idfHit = 0;
      for (const term of uniqueBase) {
        const weight = idf(term);
        idfTotal += weight;
        if (matchedTerms.includes(term)) idfHit += weight;
      }
      const coverage = idfTotal > 0 ? idfHit / idfTotal : 0;
      score *= 0.35 + 0.65 * coverage;
    }

    if (score > 0) {
      scored.push({
        ...entry.doc,
        score: Math.round(score * 100) / 100,
        matchedTerms: [...new Set(matchedTerms)],
        snippet: buildSnippet(entry.doc, base.length ? base : all)
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, limit);
}

function buildSnippet(doc, terms) {
  // `plain` is the whitespace-normalised copy built by scripts/build-index.mjs.
  // Lowercasing (not normalising) keeps offsets aligned with the original text
  // so the slice preserves the document's real casing.
  const text = doc.plain || doc.text;
  const lowered = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const idx = lowered.indexOf(term);
    if (idx !== -1 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return doc.description || text.slice(0, 240);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + SNIPPET_RADIUS);
  const slice = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${slice}${end < text.length ? "…" : ""}`;
}

/** How much the offline index actually knows about this question. */
export function assessConfidence(results, query) {
  if (!results.length) {
    return {
      level: "none",
      reason: "no page in the offline index matched these terms",
      hint: "use `pharos-docs ask \"<question>\"` to query the live documentation"
    };
  }
  const { base } = queryTerms(query);
  const top = results[0];
  const covered = base.length ? base.filter((t) => top.matchedTerms.includes(t)).length / base.length : 0;
  if (top.score >= 30 && covered >= 0.5) {
    return { level: "high", reason: `top page covers ${Math.round(covered * 100)}% of query terms` };
  }
  if (top.score >= 12) {
    return { level: "medium", reason: "related pages found, but the question may need the live docs" };
  }
  return {
    level: "low",
    reason: "only weak term overlap — the index may not cover this",
    hint: "use `pharos-docs ask \"<question>\"` for a grounded answer from the live documentation"
  };
}

/** Bounded Levenshtein — returns the distance, or null when it exceeds `max`. */
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return null;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = current[0];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      best = Math.min(best, current[j]);
    }
    if (best > max) return null;
    previous = current;
  }
  return previous[b.length] <= max ? previous[b.length] : null;
}

let VOCABULARY = null;

/** Term → corpus frequency, built once from the indexed text. */
function vocabulary() {
  if (VOCABULARY) return VOCABULARY;
  const counts = new Map();
  for (const entry of CORPUS) {
    for (const [term, tf] of entry.fields.text) counts.set(term, (counts.get(term) || 0) + tf);
  }
  VOCABULARY = counts;
  return VOCABULARY;
}

/** "Did you mean" for terms the corpus has never seen — real vocabulary only. */
export function suggestTerms(query, max = 5) {
  const { all } = queryTerms(query);
  const vocab = vocabulary();
  const found = new Map();
  for (const term of all) {
    if (vocab.has(term) || term.length < 4) continue;
    let best = null;
    for (const [candidate, count] of vocab) {
      if (candidate[0] !== term[0] || candidate.length < 4) continue;
      if (editDistance(term, candidate, 2) === null) continue;
      if (!best || count > best.count) best = { candidate, count };
    }
    if (best) found.set(best.candidate, best.count);
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([term]) => term);
}

/** Result shape shared by the CLI, the API and MCP-style tool callers. */
export function toToolResult(query, results, extras = {}) {
  const confidence = assessConfidence(results, query);
  const payload = {
    success: true,
    query,
    source: INDEX_META.source,
    index: { pages: INDEX_META.pageCount, contentHash: INDEX_META.contentHash, generatedAt: INDEX_META.generatedAt },
    confidence,
    total: results.length,
    results: results.map((doc) => ({
      id: doc.id,
      title: doc.title,
      section: doc.section,
      url: doc.url,
      mdUrl: doc.mdUrl,
      headings: doc.headings,
      snippet: doc.snippet,
      score: doc.score,
      matchedTerms: doc.matchedTerms
    }))
  };
  if (confidence.level === "none" || confidence.level === "low") {
    const suggestions = suggestTerms(query);
    if (suggestions.length) payload.suggestions = suggestions;
  }
  return { ...payload, ...extras };
}
