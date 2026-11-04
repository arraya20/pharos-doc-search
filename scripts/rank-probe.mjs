// Ranking sanity: for a set of realistic developer questions, is the page a
// human would open actually in the top 3? Printed, not asserted — this is the
// eyeball report the ranking gets tuned against.
import { searchDocs } from "../src/kb.mjs";

const QUERIES = [
  ["what is the chain id of pacific mainnet", "network"],
  ["how much does a transaction cost", "gas"],
  ["how do i run a validator node", "node-and-validator"],
  ["connect wallet with wagmi", "wallets"],
  ["x402 payment flow 402 payment-signature", "x402"],
  ["deploy a contract with foundry", "foundry"],
  ["json-rpc eth_call example", "json-rpc"],
  ["how do i get pros tokens for gas", "get-pros-gas"],
  ["sponsored transaction paymaster", "paymaster"],
  ["eth_getProof", "eth-getproof"],
  ["bridge assets to pacific", "cross-chain"],
  ["mcp server pharos", "mcp"],
  ["what is pros", "pros"],
  ["rate limits on the rpc", "rpc"],
  ["smart contract verification on explorer", "block-explorer"],
  ["indexer subgraph", "indexing"]
];

let hits = 0;
for (const [query, want] of QUERIES) {
  const results = searchDocs(query, { limit: 3 });
  const ids = results.map((r) => r.id);
  const inTop = ids.some((id) => id.toLowerCase().includes(want));
  if (inTop) hits += 1;
  console.log(`${inTop ? "ok  " : "MISS"}  ${query}`);
  console.log(`      → ${ids.map((id, i) => `${i + 1}. ${id} (${Math.round(results[i].score)})`).join("  ") || "nothing"}`);
}
console.log(`\n${hits}/${QUERIES.length} had the expected page in the top 3`);
