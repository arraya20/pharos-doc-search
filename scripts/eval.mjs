/**
 * Ranking eval. A labelled set of questions a developer would actually type,
 * each with the page(s) that answer it, written from the docs — not from what
 * the scorer already returns.
 *
 *   node scripts/eval.mjs           summary: precision@1, precision@3, MRR
 *   node scripts/eval.mjs --misses   only the queries that fall short
 *
 * A label is an array because some questions have several legitimate answers
 * (the Foundry and Hardhat tutorials are both "write your first NFT"). Any of
 * them counts. `null` means the corpus does not cover the question: the honest
 * result there is no confident answer, so scoring checks for silence instead of
 * a page.
 *
 * Exit code is 0 always — this is a measurement, not a gate. The gate lives in
 * test/ranking-eval.test.mjs, which pins the aggregate so a change that lowers
 * quality cannot land quietly.
 */
import { searchDocs, queryTerms } from "../src/kb.mjs";

/** [query, expected page ids or null, why this is the right answer] */
export const CASES = [
  // --- network facts: the parameter tables -------------------------------
  ["chain id", ["getting-started/network/pacific-mainnet"], "ChainID 1672 lives in the network table"],
  ["chainid", ["getting-started/network/pacific-mainnet"], "same, spelled as the docs spell it"],
  ["what is the pacific mainnet chain id and rpc", ["getting-started/network/pacific-mainnet"], "both values in one place"],
  ["rpc url for mainnet", ["getting-started/network/pacific-mainnet"], "RPC URL row"],
  ["atlantic testnet chain id", ["getting-started/network/atlantic-testnet"], "688689 in the testnet table"],
  ["testnet rpc endpoint", ["getting-started/network/atlantic-testnet"], "atlantic.dplabs-internal.com"],
  ["token registry", ["getting-started/token-registry"], "the registry page"],
  ["usdc contract address", ["getting-started/token-registry"], "tokens and addresses are listed there"],
  ["canonical contracts", ["getting-started/canonical-contracts"], "page name match"],

  // --- gas ---------------------------------------------------------------
  ["gas price", ["getting-started/gas-model"], "the gas model explains price and base fee"],
  ["how much does a transaction cost", ["getting-started/gas-model"], "fee arithmetic"],
  ["max priority fee per gas", ["api-and-sdk/json-rpc-methods", "getting-started/gas-model"], "method that returns it, or the model that explains it"],
  ["get pros gas", ["getting-started/get-pros-gas"], "faucet page"],
  ["faucet", ["getting-started/get-pros-gas"], "faucet page, one word"],
  ["gas fee", ["getting-started/gas-model"], "page name match"],

  // --- tutorials ---------------------------------------------------------
  ["deploy a contract with foundry", ["developer-guide/foundry"], "tool page"],
  ["write my first nft", ["developer-guide/foundry/write-your-first-nft", "developer-guide/hardhat/write-your-first-nft"], "one of the two tutorial halves"],
  ["write a simple token", ["developer-guide/foundry/write-your-first-token", "developer-guide/hardhat/write-your-first-token"], "token tutorial"],
  ["uniswap contract tutorial", ["developer-guide/foundry/write-your-first-uniswap-contract", "developer-guide/hardhat/write-your-first-uniswap-contract"], "uniswap tutorial"],
  ["hardhat config", ["developer-guide/hardhat"], "tool page"],
  ["rust sdk", ["developer-guide/rust"], "page name match"],
  ["call evm from wasm", ["developer-guide/interoperability/call-evm-from-wasm"], "page name match"],
  ["solidity version", ["resources/solidity"], "the Solidity page states what is supported"],
  ["evm compatible", ["resources/evm"], "the EVM page"],

  // --- nodes -------------------------------------------------------------
  ["node monitoring setup", ["node-and-validator-guide/node-monitoring-setup"], "page name match"],
  ["prometheus metrics", ["node-and-validator-guide/node-monitoring-setup", "pharos-node-monitoring"], "monitoring pages cover metrics"],
  ["download a snapshot", ["node-and-validator-guide/pharos-network-snapshots"], "snapshot page"],
  ["rollback blocks", ["node-and-validator-guide/rollback-blocks"], "page name match"],
  ["enable pruning", ["enable-pruning-in-pharos-node"], "page name match"],
  ["docker deployment", ["node-and-validator-guide/validator-node-deployment/using-docker-deployment"], "page name match"],
  ["minimum hardware for a validator", ["node-and-validator-guide/validator-requirements"], "the requirements table"],
  ["validator staking amount", ["node-and-validator-guide/validator-requirements", "node-and-validator-guide/validator-node-deployment"], "requirements state the stake"],
  ["node configuration file", ["node-and-validator-guide/validator-node-deployment/node-configuration"], "page name match"],
  ["jailed validator", ["node-and-validator-guide/validator-accountability"], "jailing is an accountability topic"],
  ["rebuild node with preserved node info", ["pharos-testnet-rebuild-node-with-preserved-node-info"], "page name match"],
  ["nodeid", ["node-and-validator-guide/node-debugging-and-configuration"], "Query the local NodeID lives there"],

  // --- rpc / proof -------------------------------------------------------
  ["eth_getProof", ["api-and-sdk/eth-getproof"], "method page"],
  ["storage proof", ["api-and-sdk/eth-getproof"], "method page"],
  ["merkle proof", ["api-and-sdk/eth-getproof/spv-proof-theory", "api-and-sdk/eth-getproof"], "theory page"],
  ["eth_blockNumber", ["api-and-sdk/json-rpc-methods"], "method list"],
  ["eth_maxPriorityFeePerGas", ["api-and-sdk/json-rpc-methods"], "method list"],
  ["eth_feeHistory", ["api-and-sdk/json-rpc-methods"], "method list"],

  // --- tooling -----------------------------------------------------------
  ["mcp server", ["tooling-and-infrastructure/mcp"], "page name match"],
  ["alchemy rpc", ["tooling-and-infrastructure/rpc/alchemy"], "page name match"],
  ["zan rpc", ["tooling-and-infrastructure/rpc/zan"], "page name match"],
  ["chainlink price feeds", ["tooling-and-infrastructure/oracles/chainlink-ds", "tooling-and-infrastructure/oracles/chainlink-pe"], "either feed page"],
  ["layerzero", ["tooling-and-infrastructure/cross-chain/layerzero"], "page name match"],
  ["circle cctp", ["tooling-and-infrastructure/cross-chain/circle-cctp"], "page name match"],
  ["goldsky subgraph", ["tooling-and-infrastructure/indexing/goldsky"], "page name match"],
  ["indexer", ["tooling-and-infrastructure/indexing"], "section page"],
  ["safe multisig", ["tooling-and-infrastructure/wallets/safe"], "page name match"],
  ["fordefi", ["tooling-and-infrastructure/wallets/fordefi"], "page name match"],

  // --- x402 --------------------------------------------------------------
  ["x402 payment flow", ["developer-guide/x402"], "overview page"],
  ["x402 pacific mainnet", ["developer-guide/x402/x402-pacific-mainnet"], "page name match"],
  ["402 payment required", ["developer-guide/x402"], "the flow starts with that status"],

  // --- skill engine ------------------------------------------------------
  ["pharos skill engine", ["tooling-and-infrastructure/pharos-skill-engine-guide"], "page name match"],
  ["piggy bank tutorial", ["tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide"], "page name match"],
  ["publish service agent", ["tooling-and-infrastructure/overview/publish-skill-af"], "page name match"],

  // --- about -------------------------------------------------------------
  ["what is pharos", ["introduction/readme", "introduction/encyclopedia"], "introduction"],
  ["why pharos", ["introduction/why-pharos"], "page name match"],
  ["block explorer", ["tooling-and-infrastructure/block-explorer"], "page name match"],
  ["pharosscan", ["getting-started/network/pacific-mainnet", "tooling-and-infrastructure/block-explorer"], "the network table lists the explorer URL; the explorer page describes it"],

  // --- corpus gaps: correct behaviour is "no confident answer" -----------
  ["paymaster", [null], "no page mentions paymasters"],
  ["sponsored transaction", [null], "no account-abstraction page"],
  ["eip-7702 delegation", [null], "not documented"],
  ["blob transaction", [null], "not documented"],
  ["zk proof prover", [null], "not documented"]
];

/**
 * Held-out cases, written after the scorer was last tuned and never used to
 * choose a constant. If these score much worse than CASES, the tuning overfit.
 * Different phrasing on purpose — no "chain id", no "how much", no page name
 * copied verbatim from a title.
 */
export const HOLDOUT = [
  ["wpros address", ["getting-started/token-registry"], "wrapped PROS appears in both registry tables"],
  ["what tokens exist on testnet", ["getting-started/token-registry"], "the Atlantic table"],
  ["what is the ticker symbol", ["getting-started/network/pacific-mainnet"], "Coin Symbol row"],
  ["hemara socialscan", ["tooling-and-infrastructure/block-explorer/hemera-socialscan"], "page name match"],
  ["supra oracle", ["tooling-and-infrastructure/oracles/supra"], "page name match"],
  ["chainlink push engine", ["tooling-and-infrastructure/oracles/chainlink-pe"], "page name match"],
  ["nirvana rpc", ["tooling-and-infrastructure/rpc/nirvana"], "page name match"],
  ["goldsky", ["tooling-and-infrastructure/indexing/goldsky"], "page name match"],
  ["how do I manage my node", ["node-and-validator-guide/node-management"], "page name match"],
  ["deploy the node with a binary", ["node-and-validator-guide/validator-node-deployment/using-binary-deployment"], "page name match"],
  ["devnet rapid initialization", ["node-and-validator-guide/rapid-node-initialization/rapid-node-initialization-devnet"], "page name match"],
  ["pharos encyclopedia", ["introduction/encyclopedia"], "page name match"],
  ["vision and mission", ["introduction/vision-and-mission"], "page name match"],
  ["frequently asked questions", ["getting-started/faqs"], "page name match"],
  ["how does interoperability work", ["developer-guide/interoperability", "developer-guide/interoperability/call-evm-from-wasm"], "section page or the WASM guide"],
  ["spv proof", ["api-and-sdk/eth-getproof/spv-proof-theory", "api-and-sdk/eth-getproof"], "theory page"],
  ["anvita flow", ["tooling-and-infrastructure/overview"], "page name match"],
  ["cross chain infrastructure", ["tooling-and-infrastructure/cross-chain"], "section page"],
  ["indexing provider", ["tooling-and-infrastructure/indexing"], "section page"],
  ["oracle providers", ["tooling-and-infrastructure/oracles"], "section page"],
  ["wallet providers", ["tooling-and-infrastructure/wallets"], "section page"],
  ["validator node deployment", ["node-and-validator-guide/validator-node-deployment"], "page name match"],
  ["base fee", ["getting-started/gas-model"], "the gas model defines it"],
  ["testnet faucet for pros", ["getting-started/get-pros-gas"], "faucet page"],
  ["block explorer for pharos", ["tooling-and-infrastructure/block-explorer"], "page name match"],
  ["all rpc providers", ["tooling-and-infrastructure/rpc"], "section page"],
  ["node snapshots download link", ["node-and-validator-guide/pharos-network-snapshots"], "snapshot page"],
  ["safe wallet integration", ["tooling-and-infrastructure/wallets/safe"], "page name match"],

  // corpus gaps — the honest answer is silence
  ["state rent", [null], "not documented"],
  ["liquid staking derivative", [null], "not documented"],
  ["eip-4844 blob fee", [null], "not documented"],
  ["proposer builder separation", [null], "not documented"]
];

/**
 * Pristine check. Written after HOLDOUT was mined for the "exist", "manage" and
 * "frequently asked questions" misses, so that feedback loop cannot flatter
 * itself. The scorer was not changed in response to anything below; the four
 * gap topics were verified absent from the corpus before being labelled.
 */
export const HOLDOUT2 = [
  ["where does the node store its node id", ["node-and-validator-guide/node-debugging-and-configuration"]],
  ["prometheus metrics for my node", ["node-and-validator-guide/node-monitoring-setup", "pharos-node-monitoring"]],
  ["revert to an earlier block height", ["node-and-validator-guide/rollback-blocks"]],
  ["what happens if a validator goes offline", ["node-and-validator-guide/validator-accountability"]],
  ["run the node in docker", ["node-and-validator-guide/validator-node-deployment/using-docker-deployment"]],
  ["start the node from a downloaded binary", ["node-and-validator-guide/validator-node-deployment/using-binary-deployment"]],
  ["which contracts does the team deploy", ["getting-started/canonical-contracts"]],
  ["chainlink price feeds", ["tooling-and-infrastructure/oracles/chainlink-ds"]],
  ["chainlink ccip bridge", ["tooling-and-infrastructure/cross-chain/chainlink-ccip"]],
  ["layerzero omnichain messaging", ["tooling-and-infrastructure/cross-chain/layerzero"]],
  ["hemera explorer", ["tooling-and-infrastructure/block-explorer/hemera-socialscan"]],
  ["supra oracle network", ["tooling-and-infrastructure/oracles/supra", "tooling-and-infrastructure/oracles"]],
  ["piggy bank contract tutorial", ["tooling-and-infrastructure/pharos-skill-engine-guide/piggybank-skill-guide"]],
  ["rebuild the node and keep the same node info", ["pharos-testnet-rebuild-node-with-preserved-node-info"]],
  ["fordefi custody", ["tooling-and-infrastructure/wallets/fordefi"]],
  ["safe multisig", ["tooling-and-infrastructure/wallets/safe"]],
  ["zan node service", ["tooling-and-infrastructure/rpc/zan"]],
  ["alchemy api key", ["tooling-and-infrastructure/rpc/alchemy"]],
  ["publish a service agent", ["tooling-and-infrastructure/overview/publish-skill-af"]],
  ["call a solidity contract from wasm", ["developer-guide/interoperability/call-evm-from-wasm"]],

  // verified absent from the corpus
  ["state expiry", [null], "not documented"],
  ["eip-7702 delegation", [null], "not documented"],
  ["mev auction", [null], "not documented"],
  ["blob space", [null], "not documented"]
];


/** Score one case. Returns {ok, rank} where rank is 1-based or Infinity. */
export function scoreCase(query, expected, limit = 10, search = searchDocs) {
  const results = search(query, { limit });
  if (expected[0] === null) {
    // Silence is the correct answer. A raw score cut-off is the wrong test: a
    // page can score well on the words it does share ("proof", "prover") while
    // never mentioning the term that makes the question answerable ("zk"). What
    // matters is whether the top page covers the whole query.
    const top = results[0];
    const covered = !top || queryTerms(query).base.every((t) => top.matchedTerms.includes(t));
    return { ok: !top || !covered, rank: Infinity, results, gap: true, topCoverage: covered };
  }
  const index = results.findIndex((r) => expected.includes(r.id));
  return { ok: index >= 0 && index < 3, rank: index < 0 ? Infinity : index + 1, results };
}

export function runEval(search = searchDocs, cases = CASES) {
  const rows = cases.map(([query, expected, why]) => {
    const { ok, rank, results, gap } = scoreCase(query, expected, 10, search);
    return { query, expected, why, ok, rank, top: results[0]?.id ?? null, gap: !!gap, results };
  });
  const measured = rows.filter((r) => !r.gap);
  const p1 = measured.filter((r) => r.rank === 1).length / measured.length;
  const p3 = measured.filter((r) => r.rank <= 3).length / measured.length;
  const mrr = measured.reduce((sum, r) => sum + (r.rank === Infinity ? 0 : 1 / r.rank), 0) / measured.length;
  const gaps = rows.filter((r) => r.gap);
  return { rows, p1, p3, mrr, gapPass: gaps.filter((r) => r.ok).length, gapTotal: gaps.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const holdout = process.argv.includes("--holdout") || process.argv.includes("--holdout2");
  const cases = process.argv.includes("--holdout2") ? HOLDOUT2 : holdout ? HOLDOUT : CASES;
  const { rows, p1, p3, mrr, gapPass, gapTotal } = runEval(searchDocs, cases);
  const onlyMisses = process.argv.includes("--misses");
  const showAll = process.argv.includes("--show");
  if (holdout) console.log("(held-out set — never used to pick a constant)\n");
  for (const row of rows) {
    if (onlyMisses && row.ok) continue;
    const verdict = row.gap ? (row.ok ? "gap ok" : "gap LEAK") : row.ok ? `#${row.rank}` : `#${row.rank === Infinity ? "-" : row.rank} MISS`;
    console.log(`${verdict.padEnd(9)} ${row.query}`);
    if (showAll && !row.gap) {
      const top = row.results.slice(0, 3).map((r, i) => `${i + 1}. ${r.id} (${r.score})`);
      console.log(`          ${top.join("  ") || "(nothing)"}`);
    }
    if (!row.ok) {
      console.log(`          wanted: ${row.expected.join(" | ")}`);
      console.log(`          got:    ${row.top ?? "(nothing)"}`);
      console.log(`          why:    ${row.why}`);
    }
  }
  const pass = rows.filter((r) => r.ok).length;
  console.log(
    `\n${pass}/${rows.length} ok · precision@1 ${(p1 * 100).toFixed(1)}% · precision@3 ${(p3 * 100).toFixed(1)}% · MRR ${mrr.toFixed(3)} · gaps ${gapPass}/${gapTotal}`
  );
}
