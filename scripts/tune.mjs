/**
 * Grid search over the two BM25 knobs, scored on the labelled set in eval.mjs.
 *
 *   node scripts/tune.mjs
 *
 * Works by writing patched copies of src/kb.mjs to a temp dir and importing
 * them, so the shipped module keeps its constants as constants. If the winner
 * is not the current pair, that is a signal — change the constants in kb.mjs and
 * re-run the eval, do not import this script's output at runtime.
 */
import { mkdir, writeFile, readFile, copyFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { runEval } from "./eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const tmp = path.join(repo, ".tune-tmp");

const source = await readFile(path.join(repo, "src/kb.mjs"), "utf8");

async function variant(k1, b) {
  const dir = path.join(tmp, `k${k1}-b${b}`);
  await mkdir(dir, { recursive: true });
  const patched = source
    .replace(/^const K1 = [\d.]+;$/m, `const K1 = ${k1};`)
    .replace(/^const B = [\d.]+;$/m, `const B = ${b};`);
  if (patched === source) throw new Error("constants not found — tune.mjs is out of date");
  await writeFile(path.join(dir, "kb.mjs"), patched);
  await copyFile(path.join(repo, "src/index.generated.mjs"), path.join(dir, "index.generated.mjs"));
  return import(pathToFileURL(path.join(dir, "kb.mjs")).href);
}

const rows = [];
for (const k1 of [0.6, 0.9, 1.2, 1.4, 1.8, 2.4]) {
  for (const b of [0.4, 0.55, 0.68, 0.75, 0.82, 0.9]) {
    const mod = await variant(k1, b);
    const { p1, p3, mrr, rows: detail } = runEval(mod.searchDocs);
    rows.push({ k1, b, p1, p3, mrr, misses: detail.filter((r) => !r.ok).map((r) => r.query) });
  }
}

rows.sort((x, y) => y.p3 - x.p3 || y.p1 - x.p1 || y.mrr - x.mrr);
console.log("k1    b     P@1     P@3     MRR     misses");
for (const r of rows) {
  console.log(
    `${r.k1.toFixed(2)}  ${r.b.toFixed(2)}  ${(r.p1 * 100).toFixed(1)}%  ${(r.p3 * 100).toFixed(1)}%  ${r.mrr.toFixed(3)}  ${r.misses.length}${r.misses.length ? "  " + r.misses.join("; ") : ""}`
  );
}
const best = rows[0];
console.log(`\nbest: k1=${best.k1} b=${best.b}`);
await rm(tmp, { recursive: true, force: true });
