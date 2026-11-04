// Adversarial probe of the search engine: empty, stopwords, huge, unicode,
// unknown section, silly limits. Prints the observable behaviour only.
import { searchDocs, toToolResult, listSections, getDoc, INDEX_META } from "../src/kb.mjs";

const cases = [
  ["empty", ""],
  ["spaces", "   "],
  ["stopwords", "the and of a to"],
  ["long-5k", "gas ".repeat(1000)],
  ["emoji", "🔥🔥🔥"],
  ["chainid-joined", "chainid"],
  ["uppercase", "MAINNET"],
  ["punctuation", "???"],
  ["sql-ish", "'; drop table docs; --"]
];

for (const [name, q] of cases) {
  let out;
  try {
    const results = searchDocs(q, { limit: 2 });
    const shaped = toToolResult(q, results);
    out = `count=${results.length} confidence=${shaped.confidence} terms=${JSON.stringify(shaped.matchedTerms)}${
      results.length ? ` top=${results[0].id}` : ""
    }`;
  } catch (err) {
    out = `THREW ${err.name}: ${err.message}`;
  }
  console.log(name.padEnd(14), out);
}

console.log("\nsections:", JSON.stringify(listSections()));
console.log("unknown section:", JSON.stringify(searchDocs("gas", { section: "Nope" }).length));
console.log("limit 0:", searchDocs("gas", { limit: 0 }).length, "limit -5:", searchDocs("gas", { limit: -5 }).length, "limit 999:", searchDocs("gas", { limit: 999 }).length);
console.log("id traversal:", JSON.stringify(getDoc("../package.json")), JSON.stringify(getDoc("getting-started/gas-model").title));
console.log("dup ids:", INDEX_META.pageCount === new Set((await import("../src/index.generated.mjs")).DOCS.map((d) => d.id)).size);
