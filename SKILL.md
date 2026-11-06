---
name: pharos-doc-search
description: Look up Pharos developer documentation without inventing URLs. Offline ranked search over all 74 pages, live grounded answers with sources, and a JSON API for agents.
version: 1.0.0
---

# Pharos Doc Search

## When to use

Any question about Pharos Network — chain ids, RPC endpoints, gas, bridging,
contract deployment, wallets, node operation, skill engine, x402. Use this
before answering from memory, and before scraping `docs.pharos.xyz` by hand.

## Boundary

Read-only. No keys, no signing, no transactions. Results are quotes from
`docs.pharos.xyz` with the URL they came from — the tool never paraphrases a
page it did not fetch.

## Two modes, different failure modes

| Mode | Command | Network | Use when |
| --- | --- | --- | --- |
| offline | `pharos-docs search "<query>"` | none | you need candidate pages fast, or the network is down |
| live | `pharos-docs ask "<q>"` | required | you need prose that answers the question |

Offline ranking is a committed index; it can be stale but it never lies about
what it fetched. Live mode fails closed: a timeout is an error, not "no answer".

## Procedure

1. Start with `pharos-docs search "<question as keywords>" --json` to get page ids,
   URLs, scores, and a `confidence` verdict.
2. Read `confidence`. `low` or `none` means your vocabulary missed the docs'
   vocabulary. Use `suggestTerms` from the JSON, or run `pharos-docs sections`
   and search inside the right section with `-s`.
3. Pin the page: `pharos-docs doc <id>` for live markdown, `--offline` for the
   indexed copy. Prefer live for values that change (RPC URLs, stake minimums,
   contract addresses).
4. For an explanatory question, `pharos-docs ask "<q>" --goal "<why>"`. The goal
   sharpens the answer; the source list is what you cite.
5. Cite `https://docs.pharos.xyz/<id>` — never a URL you constructed yourself.

## Do not

- Do not invent page ids. If `doc` says `doc_not_found`, it prints the closest
  real ids; pick one of those.
- Do not treat an empty result as "the docs do not say". Run `ask`, or search a
  section, before concluding anything is undocumented.
- Do not quote the `snippet` field as a full explanation. It is a 240-character
  window around the match; open the page.
- Do not retry `ask` on a `504`. Report the timeout and the URL.

## Output requirement

Every claim you surface must carry the page URL it came from. When the tool
reports low confidence or an upstream error, say so explicitly instead of
answering from memory — the failure is information the caller needs.
