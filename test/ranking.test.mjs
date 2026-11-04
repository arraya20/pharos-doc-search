// The ranking has been tuned against a labelled set; these thresholds are the
// floor it must not fall through. They are deliberately below the current
// numbers (see `node scripts/eval.mjs`) so a legitimate change elsewhere is not
// blocked, while a real regression — a constant nudged, a tokenizer change, an
// index rebuild with different text — fails loudly.
import test from "node:test";
import assert from "node:assert/strict";
import { CASES, HOLDOUT, HOLDOUT2, runEval } from "../scripts/eval.mjs";
import { searchDocs } from "../src/kb.mjs";

test("labelled queries keep the right page in the top three", () => {
  const { p1, p3, mrr, rows } = runEval(searchDocs, CASES);
  const failures = rows.filter((r) => !r.ok).map((r) => `${r.query} → ${r.top}`);
  assert.deepEqual(failures, [], `top-3 regressions:\n  ${failures.join("\n  ")}`);
  assert.ok(p3 >= 0.95, `precision@3 ${(p3 * 100).toFixed(1)}% < 95%`);
  assert.ok(p1 >= 0.75, `precision@1 ${(p1 * 100).toFixed(1)}% < 75%`);
  assert.ok(mrr >= 0.85, `MRR ${mrr.toFixed(3)} < 0.850`);
});

test("unseen phrasing holds up as well as the tuning set", () => {
  // Same floor for both sets: if the tuning set passes and this one collapses,
  // the scorer was fitted to the exact words in CASES.
  const { p1, p3, rows } = runEval(searchDocs, HOLDOUT);
  const failures = rows.filter((r) => !r.ok).map((r) => `${r.query} → ${r.top}`);
  assert.deepEqual(failures, [], `top-3 regressions on held-out phrasing:\n  ${failures.join("\n  ")}`);
  assert.ok(p3 >= 0.9, `held-out precision@3 ${(p3 * 100).toFixed(1)}% < 90%`);
  assert.ok(p1 >= 0.75, `held-out precision@1 ${(p1 * 100).toFixed(1)}% < 75%`);
});

test("a set the scorer has never been tuned against still clears the bar", () => {
  // HOLDOUT2 was written after HOLDOUT had been mined for fixes, so it is the
  // only set that can catch fitting to exact wording. It keeps one known miss
  // ("which contracts does the team deploy" — the target page never says
  // "team"), which is why this asserts a floor rather than a clean sheet:
  // chasing that case would spend the set and prove nothing.
  const { p1, p3, gapPass, gapTotal } = runEval(searchDocs, HOLDOUT2);
  assert.ok(p3 >= 0.9, `pristine precision@3 ${(p3 * 100).toFixed(1)}% < 90%`);
  assert.ok(p1 >= 0.8, `pristine precision@1 ${(p1 * 100).toFixed(1)}% < 80%`);
  assert.equal(gapPass, gapTotal, "a gap question was answered confidently");
});

test("questions the docs do not answer stay unanswered", () => {
  // A confident result for "paymaster" is worse than no result: the corpus has
  // no such page, so any hit is a plausible-looking lie assembled from shared
  // vocabulary.
  const { gapPass, gapTotal, rows } = runEval(searchDocs, CASES);
  const leaked = rows.filter((r) => r.gap && !r.ok).map((r) => `${r.query} → ${r.top}`);
  assert.deepEqual(leaked, [], `gap queries answered anyway:\n  ${leaked.join("\n  ")}`);
  assert.equal(gapPass, gapTotal);
  assert.ok(gapTotal >= 5, "gap cases went missing from the tuning set");
});
