// CLI contract tests: spawn the real binary and check exit codes and output.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cli.mjs");

function run(args, { timeout = 20_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, timeout, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("no arguments prints help and exits 0", async () => {
  const { code, stdout } = await run([]);
  assert.equal(code, 0);
  assert.match(stdout, /USAGE/);
  assert.match(stdout, /pharos-docs ask/);
});

test("--help documents every command", async () => {
  const { code, stdout } = await run(["--help"]);
  assert.equal(code, 0);
  for (const command of ["ask", "doc", "sections", "list", "verify"]) {
    assert.match(stdout, new RegExp(command));
  }
});

test("--version prints a semver", async () => {
  const { code, stdout } = await run(["--version"]);
  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("search --json returns a machine-readable payload", async () => {
  const { code, stdout } = await run(["chain id and rpc for pacific mainnet", "--json"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.success, true);
  assert.equal(payload.results[0].id, "getting-started/network/pacific-mainnet");
  assert.ok(payload.index.pages > 60);
});

test("search honours --limit and --section", async () => {
  const { stdout } = await run(["network", "--limit", "2", "--section", "Getting Started", "--json"]);
  const payload = JSON.parse(stdout);
  assert.ok(payload.results.length <= 2);
  for (const result of payload.results) assert.equal(result.section, "Getting Started");
});

test("rejects an unknown option with exit code 2", async () => {
  const { code, stderr } = await run(["--nope"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown option/);
});

test("rejects a bad --limit value", async () => {
  const { code, stderr } = await run(["chain", "--limit", "0"]);
  assert.equal(code, 2);
  assert.match(stderr, /limit/);
});

test("sections --json lists the derived sections", async () => {
  const { code, stdout } = await run(["sections", "--json"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.ok(payload.sections.includes("Getting Started"));
  assert.ok(payload.pages > 60);
});

test("doc --offline prints the indexed page without network", async () => {
  const { code, stdout } = await run(["doc", "getting-started/gas-model", "--offline"]);
  assert.equal(code, 0);
  assert.match(stdout, /gas/i);
  assert.match(stdout, /indexed copy/);
});

test("doc with an unknown id exits 2 and suggests a near match", async () => {
  const { code, stderr } = await run(["doc", "getting-started/gas-modle"]);
  assert.equal(code, 2);
  assert.match(stderr, /no page with id/);
  assert.match(stderr, /closest:/);
});

test("doc without an id exits 2", async () => {
  const { code, stderr } = await run(["doc"]);
  assert.equal(code, 2);
  assert.match(stderr, /needs a page id/);
});

test("gibberish search exits 0 and admits it found nothing", async () => {
  const { code, stdout } = await run(["zzzqqqx", "--json"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.total, 0);
  assert.equal(payload.confidence.level, "none");
});

test("a misspelled section is reported, not silently empty", async () => {
  const ok = await run(["--section", "Getting Started", "gas"]);
  assert.equal(ok.code, 0);
  const bad = await run(["--section", "Gettings Started", "gas"]);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /unknown section/);
  assert.match(bad.stderr, /Getting Started/);
});

test("list refuses an unknown section too", async () => {
  const r = await run(["list", "--section", "Nope"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown section/);
});
