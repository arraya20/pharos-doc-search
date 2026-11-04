# pharos-doc-search

Search Pharos developer documentation from the terminal, from code, or over HTTP.
Two modes that fail differently on purpose:

- **offline search** — a BM25 index of all 74 pages is committed to the repo, so ranking works with no network and no API key.
- **live answers** — `ask` and `doc` hit `docs.pharos.xyz` and fail closed if the upstream is unreachable, so you never get a fabricated page.

```
pharos-docs "pacific mainnet chain id and rpc"
pharos-docs ask "how do I bridge USDC?" --goal "fund a trading bot"
pharos-docs doc getting-started/gas-model
```

Index: 74 pages · 8 sections · `1e73d0ea17ec7c23` · 87 tests (82 offline, 5 live).

## Why this exists

The docs site is a GitBook. Its own search is keyword-only and returns pages, not
passages; agents that scrape it end up quoting stale URLs or inventing ones.
`llms.txt` gives you the page list, and every page has a `.md` twin, so the honest
fix is small: fetch the list, fetch the markdown, rank passages, keep the URL that
each passage came from.

Three rules are baked in:

1. **Every result carries its source URL and page id.** Nothing is returned that
   cannot be traced to a page you can open.
2. **The index build is fail-closed.** A dead link or a soft-404 aborts the build
   with a non-zero exit; it never ships a page that 200s with "Page Not Found"
   (GitBook does exactly that).
3. **Live commands do not guess.** Timeouts and upstream errors surface as errors
   with the URL that failed, never as an empty result that looks like "no answer".

## Ranking

BM25 over weighted fields (title > headings > description > id > body), plus
three corrections that the corpus needs:

- **Whole-phrase and title coverage** — a query that names a page ("write my
  first NFT") leads with that page instead of a page that merely repeats words.
- **Compound terms** — `ChainID` is indexed as `chain`, `id` and `chainid`, so
  "chain id" and "chainid" find each other.
- **Definition-page bonus** — a short page that covers the query gets a bounded
  boost. "chain id" should open the 40-token Network Information table, not the
  4000-token method list that says `chainId` more often purely because it is
  longer. BM25 counts how much of the query is in the page; it cannot see how
  much of the page is about the query, and the shortest pages in this corpus are
  all parameter references. Three gates keep it honest: the query must carry
  information (idf mass, so a bare "network" does not promote whatever page is
  shortest), the page must cover the query almost entirely (weighted by term
  rarity, so dropping "usdc" disqualifies while dropping "contract" does not),
  and for a one-word query the page must be *about* the term — named in its
  title/headings, or dense enough in the body to be a table label rather than a
  passing mention.
- **Rarity-weighted coverage** — missing a rare operative word costs more than
  missing a common one. Without it, a page that repeats the object of the
  question outranks the page that answers it.
- **Query-side filler** — question scaffolding ("how much", "exist", "difference")
  is dropped from the query only. Several of these are rare in the corpus and so
  carry high idf, which made them actively harmful: "what tokens exist on
  testnet" ranked `exist` as the second most important word.
- **Plural folding** — `tokens`/`token`, `addresses`/`address` are one term.
  Only a trailing `-s` is folded: a half-Porter that turns "pruning" into "prun"
  but not "prune" is worse than nothing, so `-ing`/`-ment` pairs are handled by
  the auditable alias table instead.
- **Intent table** — for a handful of names the docs never write down. "faucet"
  appears on no page at all, so the term degraded into an alias for "gas
  testnet" and opened the fee mechanics page. Aliases cannot fix a word that is
  absent from the corpus; a two-line table pointing at the page can.

Ranking is measured, not eyeballed:

```
npm run eval               # labelled questions, precision@1/@3, MRR, gap cases
npm run eval -- --holdout  # written after tuning: catches overfitting
npm run eval -- --holdout2 # written after the first holdout was mined for fixes
npm run tune               # grid search over k1/b, scored on the tuning set
```

The three sets are kept apart on purpose. Tuning on the set you report is how
search quality claims become fiction: fix the misses you can see and the number
goes up whether or not the scorer got better. `CASES` is the set constants were
chosen against, `HOLDOUT` was written afterwards, and once its misses had been
used for three fixes it stopped being evidence — so `HOLDOUT2` was written and
run once, and its one miss was left alone rather than tuned away.

| set      | precision@1 | precision@3 | MRR   | gaps |
|----------|-------------|-------------|-------|------|
| CASES    | 87.1%       | 100%        | 0.927 | 5/5  |
| HOLDOUT  | 92.9%       | 100%        | 0.952 | 4/4  |
| HOLDOUT2 | 85.0%       | 95.0%       | 0.904 | 4/4  |

`test/ranking.test.mjs` fails the suite when top-3 drops below these floors, so
a constant nudged or an index rebuilt with different text cannot regress the
ranking silently.

Most of the remaining precision@1 gap is genuine ambiguity — "gas price" is
answered by both the gas model and `eth_gasPrice`. The one known wrong answer:
"which contracts does the team deploy" opens the Piggy Bank tutorial instead of
Canonical Contracts, because "team" is the rarest word in the query and the
target page never uses it.

`npm run eval -- --show` prints the top three for every case, which is what you
want while changing the scorer; `npm run eval -- --misses` prints only the ones
that are wrong.

## Install

Node 20.11+.

```bash
git clone https://github.com/arraya20/pharos-doc-search
cd pharos-doc-search
npm link             # puts `pharos-docs` on your PATH; there are no dependencies to install
pharos-docs --help
```

Run it without installing anything:

```bash
node src/cli.mjs "how do I deploy with foundry"
```

## Usage

```
$ pharos-docs "pacific mainnet chain id and rpc"
pharos-docs search "pacific mainnet chain id and rpc"
3 results · confidence high (top page covers 60% of query terms) · index 74 pages @ 1e73d0ea17ec7c23

1. Pacific Mainnet · Getting Started · score 41.16
   https://docs.pharos.xyz/getting-started/network/pacific-mainnet
   Network Information Parameter · Value Network · Pharos Pacific Mainnet ChainID · 1672 Coin Symbol/Ticker · PROS RPC URL · https://rpc.pharos.xyz ...
   id: getting-started/network/pacific-mainnet  ·  pharos-docs doc getting-started/network/pacific-mainnet

2. x402 Pacific Mainnet · Developer Guide · score 36.15
   https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet
   ...
```

`ask` is the one command that needs the network. It returns a grounded answer
with a numbered source list, plus the raw upstream URL and HTTP status so you can
audit it:

```
$ pharos-docs ask "How do I get PROS gas for a test wallet?"
pharos-docs ask · live docs.pharos.xyz
For a **test wallet**, use **Atlantic Testnet**. Its gas token is **PHRS**, not PROS.
Add Atlantic to your wallet with RPC https://atlantic.dplabs-internal.com, chain ID 688689 ...

Sources
  https://docs.pharos.xyz/getting-started/get-pros-gas (Get PROS Gas)
  https://docs.pharos.xyz/tooling-and-infrastructure/wallets (Wallet)
  ...
source: https://docs.pharos.xyz/index.md?ask=... · HTTP 200 · 2026-11-04T13:51:37Z
```

### Commands

| Command | Network | What it does |
| --- | --- | --- |
| `pharos-docs <query>` | no | BM25 search over passages; `-l/--limit`, `-s/--section`, `--json` |
| `pharos-docs ask "<q>"` | yes | Grounded answer + sources; `--goal`, `--timeout` |
| `pharos-docs doc <id>` | yes | Live markdown of one page; `--offline` for the indexed copy, `--raw` for no header |
| `pharos-docs sections` | no | The 8 sections with page counts |
| `pharos-docs list [--section <s>]` | no | Every indexed page id and URL |
| `pharos-docs verify` | yes | Re-checks all 74 index URLs; exit 1 if any are dead |

Exit codes: `0` success (including a search that legitimately found nothing),
`1` upstream/runtime failure, `2` bad usage or unknown page id.

### As a library

```js
import { searchDocs, getDoc, listSections, toToolResult } from "pharos-doc-search";

const results = searchDocs("gas refund", { limit: 3 });
// → [{ id, title, url, section, score, snippet, matchedTerms }, ...]

// Shaped for an LLM tool call: includes ids, urls, and a "did I find it" verdict.
const toolResult = toToolResult("gas refund", results);
```

`toToolResult` exists because agents need a machine-readable admission of
uncertainty more than they need another blob of text: it reports `confidence`,
`matchedTerms`, and a `suggestTerms` list when the query was a near miss.

## HTTP API

The same engine ships as Cloudflare Pages Functions, so a deployed copy is a
public read-only API. All endpoints are `GET` (or `POST` with a JSON body),
CORS-open, and cached at the edge (`max-age=300` for search, `60` for live).

| Endpoint | Query | Returns |
| --- | --- | --- |
| `GET /api/search` | `q` (or `query`), `limit`, `section`, `id` | `{ success, query, count, results[], confidence }`; pass `id` alone for a single-page lookup |
| `GET /api/ask` | `q`, `goal` (max 500 chars) | `{ success, answer, sources[], followUps[], upstream }` |
| `GET /api/doc` | `id`, `source=index\|live` (`live=1` alias) | `{ doc: { id, title, url, markdown } , source }` |
| `GET /api/meta` | — | index hash, page counts, sections, endpoint list |

```bash
curl -s 'https://HOST/api/search?q=managing+contract+state&limit=2' | jq '.results[].url'
curl -s 'https://HOST/api/ask?q=how+do+I+deploy+with+foundry' | jq -r '.answer, .sources[].url'
```

`limit` is clamped to 1-20 (default 5) rather than rejected. Timeouts are clamped
to 3-20 s per endpoint. Errors are structured and never return `200` with an
empty list: `400 missing_query | question_too_long | bad_request`,
`404 doc_not_found | not_found`, `405 method_not_allowed`,
`502 upstream_error | network_error | unparseable`, `504 timeout`,
`500 internal_error`. Request bodies over 8 KB are refused, not buffered.

## Deploy

```bash
npx wrangler pages deploy        # uses wrangler.toml → project "pharos-doc-search"
npx wrangler pages dev           # local build at http://localhost:8788
```

Static assets and Functions deploy together from `public/` + `functions/`.
The dashboard is a plain HTML page with no build step and no client-side
framework: it searches the same index that the CLI ships.

## Rebuilding the index

```bash
npm run build:index      # fetches llms.txt + 74 markdown pages (~5 s)
npm run verify           # re-checks every URL is still live (74/74)
```

The build is deliberately strict. It exits non-zero when:

- `llms.txt` yields fewer pages than the previous build (the docs tree shrank);
- any page returns a non-200;
- any page returns the GitBook soft-404 body (`# Page Not Found`) behind a 200;
- a page's markdown body is empty after boilerplate is stripped.

Output is two artifacts from one payload: `src/index.generated.mjs` (with full
markdown, 661 KB, used by `doc --offline`) and `public/index.generated.js`
(plain text only, 385 KB, used by the browser). `test/bundle.test.mjs` asserts
they share the same content hash, so a stale copy fails the suite.

The build is reproducible: `contentHash` is taken over page content only, and
`generatedAt` is carried over from the previous build when nothing changed, so
rebuilding an unchanged docs tree produces a byte-identical file and an empty
git diff. `test/index-determinism.test.mjs` pins that down — a hash that moved
on every build would be noise, not a signal.

## Tests

```bash
npm test           # 107 pass, 5 skipped (live tests are opt-in)
npm run test:live  # 5 more: real ask call, real page fetch, 74-URL liveness sweep
```

Content comes out of GitBook's markdown export with punctuation escapes
(`eth\_getProof`, `wss\://`), and GitBook is inconsistent about doubling them.
Those backslashes are markup, not content, so the title/snippet projections strip
them while the stored markdown body is left verbatim; `test/markdown-escapes.test.mjs`
pins both halves of that, including a sweep over all 74 pages.

The suite covers the ranking invariants (an exact page id beats a mention,
section filters actually filter, gibberish scores low), the CLI contract
(exit codes, `--json` shape, unknown ids suggest a near match), every API
handler including its error paths, and the build invariants above.

## Limits

- **Index freshness is manual.** The docs move; `npm run verify` tells you when.
- **`ask` is an upstream call, not a local model.** It is as fast and as good as
  `docs.pharos.xyz` allows, typically 5-20 s, and returns 502/504 when upstream
  does. It does not fall back to local synthesis.
- **No auth, no rate limit of its own.** The deployed API is read-only and
  cheap, but if you self-host it publicly put it behind Cloudflare rate limiting.
- **Content is Pharos's.** Results quote their docs; the MIT license covers this
  tool, not the text it retrieves.

## Layout

```
src/kb.mjs                 tokenizer, BM25 scoring, confidence, tool-result shaping
src/index.generated.mjs    committed index (74 pages, full markdown)
src/docs-source.mjs        live fetch + ask, fail-closed, soft-404 aware
src/cli.mjs                the CLI (no dependencies)
scripts/build-index.mjs    llms.txt → index, strict
functions/api/*.js         Pages Functions endpoints
functions/_lib/http.js     CORS, JSON, param parsing, body cap
public/                    dashboard (no build step)
test/                      87 tests
```

Built for the Pharos Agent Arena. Docs: <https://docs.pharos.xyz>.

MIT © 2026 Namri
