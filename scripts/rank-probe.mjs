// Ranking sanity: for a set of realistic developer questions, is the page a
// human would open actually in the top 3? Printed, not asserted — this is the
// eyeball report the ranking gets tuned against.
//
// Entries are [query, expected-id-fragment] for "the answer should be here",
// or [query, null] for "the docs do not cover this and the engine must not
// pretend otherwise" — a low-confidence search is the correct answer there.
import { searchDocs } from "../src/kb.mjs";

// Above this score the engine is claiming it found the page rather than
// offering the closest thing it has.
const CONFIDENT = 10;

const QUERIES = [
  ["what is the chain id of pacific mainnet", "getting-started/network/pacific-mainnet"],
  // Bare field names are the hard case: the answering page is a short
  // parameter table, and every long reference page mentions the same term.
  ["chain id", "getting-started/network/pacific-mainnet"],
  ["gas price", "gas"],
  ["block explorer", "block-explorer"],
  ["how much does a transaction cost", "gas"],
  ["how do i run a validator node", "node-and-validator"],
  ["connect wallet with wagmi", "wallets"],
  ["x402 payment flow 402 payment-signature", "x402"],
  ["deploy a contract with foundry", "foundry"],
  ["json-rpc eth_call example", "json-rpc"],
  ["how do i get pros tokens for gas", "get-pros-gas"],
  ["eth_getProof", "eth-getproof"],
  ["bridge assets to pacific", "cross-chain"],
  ["mcp server pharos", "mcp"],
  ["what is pros", "pros"],
  ["rate limits on the rpc", "rpc"],
  ["smart contract verification on explorer", "block-explorer"],
  ["indexer subgraph", "indexing"],
  // No page in the Pharos docs describes paymasters or account abstraction
  // beyond a contract address. Inventing an answer here would be worse than
  // admitting the gap.
  ["sponsored transaction paymaster", null]
];

let hits = 0;
let checked = 0;
for (const [query, want] of QUERIES) {
  const results = searchDocs(query, { limit: 3 });
  const ids = results.map((r) => r.id);
  const top = results[0];

  if (want === null) {
    const quiet = !top || top.score < CONFIDENT;
    if (quiet) hits += 1;
    checked += 1;
    console.log(`${quiet ? "ok  " : "MISS"}  ${query}`);
    console.log(`      → ${quiet ? "no confident answer, as expected" : "claims to know: " + ids[0]} (${top ? Math.round(top.score) : 0})`);
    continue;
  }

  const inTop = ids.some((id) => id.toLowerCase().includes(want.toLowerCase()));
  checked += 1;
  if (inTop) hits += 1;
  console.log(`${inTop ? "ok  " : "MISS"}  ${query}`);
  console.log(`      → ${ids.map((id, i) => `${i + 1}. ${id} (${Math.round(results[i].score)})`).join("  ") || "nothing"}`);
}
console.log(`\n${hits}/${checked} ranked as expected`);
