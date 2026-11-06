# pharos-doc-search

Ask the Pharos developer documentation a question from the terminal, from code,
or over HTTP, and get a concise answer with links to the pages it came from.
Built on the **Pharos Developer Docs MCP** (`https://docs.pharos.xyz/~gitbook/mcp`),
with an offline index as a safety net. Two paths that fail differently on purpose:

- **live answer** — `pharos-docs "<question>"` calls the docs MCP `askQuestion`
  tool and prints the answer with its sources. It fails closed: a timeout or
  upstream error is reported as one, never turned into a made-up answer. If the
  live docs cannot be reached, the bare command says so and falls back to the
  offline index; `ask` never falls back.
- **offline search** — a BM25 index of all 74 pages is committed to the repo, so
  `pharos-docs search` ranks pages with no network and no API key.

```
pharos-docs "how do I deploy a contract?"
pharos-docs ask "how do I bridge USDC?" --goal "fund a trading bot"
pharos-docs search "pacific mainnet chain id and rpc"
pharos-docs doc getting-started/gas-model
```

Index: 74 pages · 8 sections · `b9fac7ad8280a998` · 133 tests (128 offline, 5 live).

## Built on the Pharos Developer Docs MCP

`docs.pharos.xyz` publishes an MCP server (streamable HTTP, key-free, stateless).
One JSON-RPC `tools/call` is all it takes, so there is no SDK dependency:

```bash
curl -s https://docs.pharos.xyz/~gitbook/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"askQuestion","arguments":{"question":"how do I deploy a contract?"}}}'
```

| MCP tool | Used for |
| --- | --- |
| `askQuestion` `{question, goal?}` | **The default answer path.** `src/mcp.mjs` calls it, splits the reply into answer and `# Sources`, and makes relative doc links absolute. |
| `searchDocumentation` `{query}` | Not called at runtime. The committed index plays this role offline. |
| `getPage` `{url}` | Not called at runtime. `pharos-docs doc <id>` fetches the page's `.md` twin instead. |

If the MCP call fails with anything but a timeout, `src/answer.mjs` retries once
through GitBook's `index.md?ask=` endpoint (same upstream, different route) and
records why in the payload (`mcpError`). A timeout is not retried: the upstream is
slow, and a second wait buys nothing. The payload's `via` field says which path
answered (`mcp` or `gitbook-ask`). The Cloudflare `/api/ask` endpoint calls the
GitBook `?ask=` route directly and does not go through MCP.

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

Node 20.11+. No dependencies to install.

```bash
git clone https://github.com/arraya20/pharos-doc-search
cd pharos-doc-search
npm link             # puts `pharos-docs` on your PATH
pharos-docs --help
```

Run it without installing anything:

```bash
node src/cli.mjs "how do I deploy with foundry"
```

## Usage

`pharos-docs "<question>"` returns a concise answer plus the doc pages it used.
`pharos-docs search "<query>"` returns ranked pages from the offline index.
All outputs below are real runs, captured unedited (colors off, `NO_COLOR=1`).

### 1. A question the docs answer

```
$ pharos-docs "how do I deploy a contract?"
pharos-docs answer · Pharos Developer Docs MCP
how do I deploy a contract?

For a Solidity contract on Pharos, you can deploy with Foundry:

1. Install Foundry and set up your contract project.
2. Compile and test it:

   ```sh
   forge build
   forge test
   ```
3. Create a deployment script that loads `PRIVATE_KEY`, starts a broadcast, and deploys your contract.
4. Set your key and run the script:

   ```sh
   export PRIVATE_KEY=<your-private-key>
   forge script script/DeployToken.s.sol --rpc-url <PHAROS_RPC_URL> --broadcast
   ```

Make sure the deployer wallet has enough testnet tokens for deployment costs. The [Write Your First Token](https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token) includes a complete deployment-script example.

Sources
  https://docs.pharos.xyz/developer-guide/foundry/write-your-first-uniswap-contract (Write Your First Uniswap Contract)
  https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-uniswap-contract (Write Your First Uniswap Contract)
  https://docs.pharos.xyz/node-and-validator-guide/validator-node-deployment (Validator Node Deployment)
  https://docs.pharos.xyz/developer-guide/foundry/write-your-first-token (Write Your First Token)
  https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-nft (Write Your First NFT)
  https://docs.pharos.xyz/developer-guide/foundry/write-your-first-nft (Write Your First NFT)
  https://docs.pharos.xyz/developer-guide/interoperability/call-evm-from-wasm (Call EVM From WASM)
  https://docs.pharos.xyz/developer-guide/hardhat/write-your-first-token (Write Your First Token)
  … 2 more

source: https://docs.pharos.xyz/~gitbook/mcp · tool askQuestion · HTTP 200 · 2026-11-06T07:27:57Z
```

### 2. Offline search, no network

```
$ pharos-docs search "pacific mainnet chain id and rpc" --limit 2
pharos-docs search "pacific mainnet chain id and rpc"
2 results · confidence high (top page covers 100% of query terms) · index 74 pages @ b9fac7ad8280a998

1. Pacific Mainnet · Getting Started · score 64.5
   https://docs.pharos.xyz/getting-started/network/pacific-mainnet
   Network Information Parameter · Value Network · Pharos Pacific Mainnet ChainID · 1672 Coin Symbol/Ticker · PROS RPC URL · https://rpc.pharos.xyz Block Explorer · https://www.pharosscan.xyz > For the current node binary and Do…
   id: getting-started/network/pacific-mainnet  ·  pharos-docs doc getting-started/network/pacific-mainnet

2. x402 Pacific Mainnet · Developer Guide · score 35.59
   https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet
   A developer guide on how to get started with x402 on Pharos Pacific Mainnet Server-side: Using Express + x402 Middleware For Express applications, you can use the middleware pattern: /…
   id: developer-guide/x402/x402-pacific-mainnet  ·  pharos-docs doc developer-guide/x402/x402-pacific-mainnet
```

### 3. A question the docs do not answer

The answer says it cannot answer instead of inventing one. The sources are the
closest pages, listed so you can check for yourself.

```
$ pharos-docs "what is the price of bitcoin on binance"
pharos-docs answer · Pharos Developer Docs MCP
what is the price of bitcoin on binance

I cannot provide Binance’s live Bitcoin price. The docs list a Pharos BTC/USD oracle feed, but not a current Binance quote. [Chainlink Push Engine Feeds](https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe).

Sources
  https://docs.pharos.xyz/tooling-and-infrastructure/oracles/chainlink-pe (Chainlink Push Engine Feeds)
  https://docs.pharos.xyz/tooling-and-infrastructure/oracles (Oracle)
  https://docs.pharos.xyz/getting-started/token-registry (Token Registry)
  https://docs.pharos.xyz/tooling-and-infrastructure/overview/publish-skill-af (Publish Service Agent)
  https://docs.pharos.xyz/introduction/why-pharos (Why Pharos)
  https://docs.pharos.xyz/getting-started/network/atlantic-testnet (Atlantic Testnet)
  https://docs.pharos.xyz/getting-started/get-pros-gas (Get PROS Gas)
  https://docs.pharos.xyz/api-and-sdk/json-rpc-methods (JSON-RPC API Methods)
  … 2 more

source: https://docs.pharos.xyz/~gitbook/mcp · tool askQuestion · HTTP 200 · 2026-11-06T07:28:19Z
```

Offline `search` is just as candid: when the best page shares only a few weak
terms with the query it prints `confidence low` and a warning that the pages are
leads, not an answer; when nothing matches it prints "No page in the offline
index matched" and exits 0.

### When the live docs are unreachable

The bare command says so on stderr, then degrades to the offline index. Here a
1 ms `--timeout` forces the failure:

```
$ pharos-docs "how do I deploy with foundry" --timeout 1 --limit 2
live docs unavailable (docs MCP did not answer within 1ms) — falling back to the offline index.
what follows are retrieved passages from the committed index, not a synthesized answer.


pharos-docs search "how do I deploy with foundry"
2 results · confidence medium (related pages found, but the question may need the live docs) · index 74 pages @ b9fac7ad8280a998

1. Foundry · Developer Guide · score 20.99
   https://docs.pharos.xyz/developer-guide/foundry
   This guide is suitable for developers who want to start building dApps using Pharos and Foundry toolchains. If you are a new user of Ethereum, please consider researching the Ethereum documentation before continuing. Write Your First Transaction This guide w…
   id: developer-guide/foundry  ·  pharos-docs doc developer-guide/foundry

2. Write Your First dApp · Developer Guide · score 19.78
   https://docs.pharos.xyz/developer-guide/foundry/write-your-first-dapp
   This guide will walk you through the process of building and deploying your first end-to-end decentralized application (dApp) on the Pharos blockchain. By the end of this guide, you will have a fully functional dApp that includes a…
   id: developer-guide/foundry/write-your-first-dapp  ·  pharos-docs doc developer-guide/foundry/write-your-first-dapp
```

`pharos-docs ask "<q>"` has no such fallback: it exits 1 with the upstream error.
`--offline` skips the network entirely, `--json` prints a machine-readable
payload (`"mode": "answer"` or `"mode": "offline_fallback"`).

### Commands

| Command | Network | What it does |
| --- | --- | --- |
| `pharos-docs "<question>"` | yes, falls back | Concise answer + sources via the docs MCP; `--goal`, `--timeout`. Falls back to offline search, with a notice, if the live docs fail. `--offline` or `--section` go straight to the index. |
| `pharos-docs ask "<q>"` | yes | The same answer, fail-closed: exit 1 on upstream failure, no fallback |
| `pharos-docs search "<q>"` | no | BM25 search over passages; `-l/--limit`, `-s/--section`, `--json` |
| `pharos-docs doc <id>` | yes | Live markdown of one page; `--offline` for the indexed copy, `--raw` for no header |
| `pharos-docs sections` | no | The 8 sections with page counts |
| `pharos-docs list [--section <s>]` | no | Every indexed page id and URL |
| `pharos-docs verify` | yes | Re-checks all 74 index URLs; exit 1 if any are dead |

Exit codes: `0` success (including a search that legitimately found nothing, and
a bare question that fell back to the index), `1` upstream/runtime failure of
`ask`, `doc` or `verify`, `2` bad usage or unknown page id.

### As a library

```js
// not on npm yet: npm i github:arraya20/pharos-doc-search
import { searchDocs, getDoc, listSections, toToolResult } from "pharos-doc-search";
import { askMcp } from "pharos-doc-search/mcp";   // live answer via the docs MCP

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
npm test           # 128 pass, 5 skipped (live tests are opt-in)
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
  the docs MCP allows, typically 5-20 s. `ask` returns an error when upstream does;
  only the bare `pharos-docs "<question>"` falls back to the offline index, and it
  says so when it does.
- **No auth, no rate limit of its own.** The deployed API is read-only and
  cheap, but if you self-host it publicly put it behind Cloudflare rate limiting.
- **Content is Pharos's.** Results quote their docs; the MIT license covers this
  tool, not the text it retrieves.

## Layout

```
src/kb.mjs                 tokenizer, BM25 scoring, confidence, tool-result shaping
src/index.generated.mjs    committed index (74 pages, full markdown)
src/docs-source.mjs        live fetch + GitBook ask, fail-closed, soft-404 aware
src/mcp.mjs                Pharos Developer Docs MCP client (askQuestion)
src/answer.mjs             MCP first, GitBook ask second, typed errors
src/cli.mjs                the CLI (no dependencies)
scripts/build-index.mjs    llms.txt → index, strict
functions/api/*.js         Pages Functions endpoints
functions/_lib/http.js     CORS, JSON, param parsing, body cap
public/                    dashboard (no build step)
test/                      133 tests
```

Built for the Pharos Agent Arena. Docs: <https://docs.pharos.xyz>.

MIT © 2026 arraya20
