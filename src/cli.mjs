#!/usr/bin/env node
// pharos-docs — search the Pharos developer documentation from a terminal.
//
// Three paths, on purpose:
//   • pharos-docs "<question>"  → live answer from the Pharos Developer Docs MCP
//                                 (askQuestion), cited. If the live docs are
//                                 unreachable it says so and falls back to the
//                                 offline index.
//   • pharos-docs ask "<q>"     → the same live answer, but fail-closed: no fallback.
//   • pharos-docs search "<q>"  → offline BM25 over the generated index
//                                 (fast, deterministic, no network).
//
// Nothing is fabricated: every result carries the page it came from, and any
// upstream failure is reported as a failure.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { searchDocs, getDoc, listSections, toToolResult, INDEX_META, DOCS } from "./kb.mjs";
import { fetchDocMarkdown, verifyFetchHealthy, DocsSourceError } from "./docs-source.mjs";
import { answerQuestion } from "./answer.mjs";

function readVersion() {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const c = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : String(text));
const bold = c("1");
const dim = c("90");
const orange = c("38;5;209");
const cyan = c("36");
const green = c("32");
const yellow = c("33");
const red = c("31");

const CONFIDENCE_COLOR = { high: green, medium: yellow, low: red, none: red };

function help() {
  console.log(`
${orange(bold("pharos-docs"))} ${dim("— Pharos developer documentation, from the terminal")}
${dim(`index: ${INDEX_META.pageCount} pages from ${INDEX_META.source} · hash ${INDEX_META.contentHash}`)}

${bold("USAGE")}
  pharos-docs "<question>" [options]         concise answer + sources (live docs MCP,
                                             falls back to the offline index)
  pharos-docs ask "<question>" [--goal "..."] same answer, fail-closed (no fallback)
  pharos-docs search "<query>" [options]     offline ranked search, no network
  pharos-docs doc <id> [--raw]               read one page (live markdown)
  pharos-docs sections                       list documentation sections
  pharos-docs list [--section <name>]        list every indexed page
  pharos-docs verify                         check every index URL is still live

${bold("OPTIONS")}
  -l, --limit <n>        max search results (default 5)
  -s, --section <name>   restrict to a section (Network, MCP, ...)
      --json             machine-readable output
      --version          print the version
      --goal "<text>"    why you need the answer (sharpens the ask command)
      --timeout <ms>     upstream timeout for live calls (default 45000)
      --offline          never touch the network: search the index (doc: print the indexed copy)
      --no-color         disable ANSI styling
  -h, --help             this screen

${bold("EXAMPLES")}
  pharos-docs "how do I deploy a contract?"
  pharos-docs search "what is the pacific mainnet chain id and rpc"
  pharos-docs search "how do I deploy with foundry" --limit 3
  pharos-docs ask "how do I bridge USDC to Pharos?" --goal "fund a trading bot"
  pharos-docs doc getting-started/gas-model --raw
  pharos-docs verify --json
`);
}

function parseArgs(argv) {
  const opts = {
    command: null,
    queryParts: [],
    limit: 5,
    section: null,
    goal: "",
    timeout: undefined,
    json: false,
    raw: false,
    offline: false,
    help: false
  };

  const takesValue = { "-l": "limit", "--limit": "limit", "-s": "section", "--section": "section", "--goal": "goal", "--timeout": "timeout" };
  const commands = new Set(["ask", "search", "doc", "sections", "list", "verify"]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "-v" || arg === "--version") {
      opts.version = true;
    } else if (arg === "--raw") {
      opts.raw = true;
    } else if (arg === "--offline") {
      opts.offline = true;
    } else if (arg === "--no-color") {
      process.env.NO_COLOR = "1";
    } else if (takesValue[arg]) {
      const key = takesValue[arg];
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${arg} needs a value`);
      }
      opts[key] = key === "limit" || key === "timeout" ? Number(value) : value;
      i++;
    } else if (!arg.startsWith("-") && opts.command === null && commands.has(arg) && opts.queryParts.length === 0) {
      opts.command = arg;
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      opts.queryParts.push(arg);
    }
  }

  opts.query = opts.queryParts.join(" ").trim();
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new Error("--limit must be a positive integer");
  return opts;
}

function printSearch(payload) {
  const { query, results, confidence } = payload;
  console.log(`\n${orange(bold("pharos-docs"))} ${dim("search")} ${bold(`"${query}"`)}`);
  console.log(
    dim(
      `${results.length} result${results.length === 1 ? "" : "s"} · confidence ${confidence.level}` +
        (confidence.reason ? ` (${confidence.reason})` : "") +
        ` · index ${INDEX_META.pageCount} pages @ ${INDEX_META.contentHash}`
    )
  );

  if (results.length === 0) {
    console.log(`\n${yellow("No page in the offline index matched.")}`);
    if (payload.suggestions?.length) console.log(`${dim("did you mean:")} ${payload.suggestions.join(", ")}`);
    console.log(`${dim("try the live docs:")} ${cyan(`pharos-docs ask "${query}"`)}\n`);
    return;
  }

  if (confidence.level === "low") {
    console.log(`\n${yellow("No confident match: the pages below only share a few weak terms with the query. Treat them as leads, not an answer.")}`);
  }

  results.forEach((doc, i) => {
    console.log(`\n${orange(bold(`${i + 1}.`))} ${bold(doc.title)} ${dim(`· ${doc.section} · score ${doc.score}`)}`);
    console.log(`   ${cyan(doc.url)}`);
    if (doc.snippet) console.log(`   ${dim(doc.snippet)}`);
    console.log(`   ${dim(`id: ${doc.id}  ·  pharos-docs doc ${doc.id}`)}`);
  });

  const colorize = CONFIDENCE_COLOR[confidence.level] || dim;
  if (confidence.hint) console.log(`\n${colorize(confidence.hint)}`);
  console.log();
}

function printAsk(payload) {
  const via = payload.via === "mcp" ? "Pharos Developer Docs MCP" : "live docs.pharos.xyz";
  console.log(`\n${orange(bold("pharos-docs"))} ${dim(`answer · ${via}`)}`);
  console.log(`${bold(payload.question)}${payload.goal ? dim(`  (goal: ${payload.goal})`) : ""}\n`);
  console.log(payload.answer.trim());
  if (payload.sources.length) {
    console.log(`\n${bold("Sources")}`);
    for (const source of payload.sources.slice(0, 8)) console.log(`  ${cyan(source.url)} ${dim(`(${source.title})`)}`);
    if (payload.sources.length > 8) console.log(dim(`  … ${payload.sources.length - 8} more`));
  }
  if (payload.followups.length) {
    console.log(`\n${bold("Follow-ups")}`);
    for (const f of payload.followups.slice(0, 3)) console.log(`  ${dim("-")} ${f.question}`);
  }
  const tool = payload.upstream.tool ? ` · tool ${payload.upstream.tool}` : "";
  console.log(`\n${dim(`source: ${payload.upstream.url}${tool} · HTTP ${payload.upstream.httpStatus} · ${payload.fetchedAt}`)}\n`);
}

async function runVerify(opts) {
  const started = Date.now();
  const rows = [];
  for (const doc of DOCS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || 15_000);
    let status = 0;
    let error = "";
    try {
      const res = await fetch(doc.mdUrl, { method: "GET", signal: controller.signal, headers: { "user-agent": "pharos-doc-search-cli/1.0" } });
      status = res.status;
      const body = await res.text();
      // HTTP 200 with a "Page Not Found" body is GitBook's soft-404, and it is
      // exactly the failure this check exists to catch. `res.ok` is not enough.
      const health = verifyFetchHealthy({ status, body });
      error = health.error;
    } catch (err) {
      error = err.name === "AbortError" ? "timeout" : err.message;
    } finally {
      clearTimeout(timer);
    }
    rows.push({ id: doc.id, url: doc.mdUrl, pageUrl: doc.url, status, ok: status === 200 && !error, error });
  }

  const broken = rows.filter((row) => !row.ok);
  const payload = {
    success: broken.length === 0,
    checked: rows.length,
    ok: rows.length - broken.length,
    broken,
    durationMs: Date.now() - started,
    index: { contentHash: INDEX_META.contentHash, generatedAt: INDEX_META.generatedAt },
    checkedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z")
  };

  if (opts.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`\n${orange(bold("pharos-docs"))} ${dim("verify")} ${INDEX_META.pageCount} index URLs`);
    for (const row of rows) {
      const mark = row.ok ? green("200") : red(row.error || String(row.status));
      if (!row.ok) console.log(`  ${mark} ${row.id} ${dim(row.url)}`);
    }
    console.log(
      `\n${broken.length === 0 ? green("✔ all links live") : red(`✖ ${broken.length} broken`)} ${dim(
        `· ${rows.length - broken.length}/${rows.length} ok · ${payload.durationMs}ms`
      )}\n`
    );
  }
  return broken.length === 0 ? 0 : 1;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(red(`error: ${err.message}`));
    console.error(dim("see pharos-docs --help"));
    return 2;
  }

  if (opts.version) {
    console.log(readVersion());
    return 0;
  }

  if (opts.help || (!opts.command && !opts.query)) {
    help();
    return 0;
  }

  if (opts.command === "sections") {
    const sections = listSections();
    if (opts.json) {
      console.log(JSON.stringify({ sections, pages: INDEX_META.pageCount, source: INDEX_META.source }, null, 2));
    } else {
      console.log(`\n${bold("Sections")} ${dim(`(${INDEX_META.pageCount} pages)`)}`);
      for (const section of sections) {
        const count = DOCS.filter((doc) => doc.section === section).length;
        console.log(`  ${orange("•")} ${section} ${dim(`(${count})`)}`);
      }
      console.log();
    }
    return 0;
  }

  if (opts.command === "list") {
    let pool = DOCS;
    if (opts.section) {
      const sections = listSections();
      const exact = sections.find((name) => name.toLowerCase() === opts.section.toLowerCase());
      if (!exact) {
        console.error(red(`error: unknown section "${opts.section}"`));
        console.error(dim(`sections: ${sections.join(", ")}`));
        return 2;
      }
      pool = DOCS.filter((doc) => doc.section === exact);
    }
    if (opts.json) {
      console.log(JSON.stringify({ total: pool.length, docs: pool }, null, 2));
      return 0;
    }
    console.log(`\n${bold("Documentation index")} ${dim(`${pool.length} pages`)}`);
    let lastSection = null;
    for (const doc of pool) {
      if (doc.section !== lastSection) {
        console.log(`\n${orange(bold(doc.section))}`);
        lastSection = doc.section;
      }
      console.log(`  ${doc.title} ${dim(`· ${doc.id}`)}`);
    }
    console.log();
    return 0;
  }

  if (opts.command === "doc") {
    if (!opts.query) {
      console.error(red("error: doc needs a page id (try pharos-docs list)"));
      return 2;
    }
    const doc = getDoc(opts.query);
    if (!doc) {
      console.error(red(`error: no page with id "${opts.query}"`));
      const needle = opts.query.toLowerCase().replace(/\.md$/, "");
      const tail = needle.split("/").pop().slice(0, 4);
      const near = DOCS.filter(
        (d) => d.id.toLowerCase().includes(needle) || (tail.length >= 3 && d.id.toLowerCase().split("/").pop().startsWith(tail))
      ).slice(0, 5);
      if (near.length) console.error(dim(`closest: ${near.map((d) => d.id).join(", ")}`));
      return 2;
    }

    if (opts.offline) {
      const payload = { success: true, source: "index", doc };
      if (opts.json) return console.log(JSON.stringify(payload, null, 2)), 0;
      console.log(`\n${bold(doc.title)} ${dim(`· ${doc.section}`)}\n${cyan(doc.url)}\n`);
      console.log(doc.text);
      console.log(`\n${dim("(indexed copy — run without --offline for the live page)")}\n`);
      return 0;
    }

    try {
      const live = await fetchDocMarkdown(doc, { timeoutMs: opts.timeout });
      if (opts.json) {
        console.log(JSON.stringify({ success: true, source: "live", url: live.url, mdUrl: live.mdUrl, httpStatus: live.httpStatus, markdown: live.markdown }, null, 2));
      } else if (opts.raw) {
        console.log(live.markdown);
      } else {
        console.log(`\n${bold(doc.title)} ${dim(`· ${doc.section} · HTTP ${live.httpStatus}`)}\n${cyan(doc.url)}\n`);
        console.log(live.markdown);
        console.log(`\n${dim(`source: ${live.mdUrl}`)}\n`);
      }
      return 0;
    } catch (err) {
      reportUpstreamError(err);
      return 1;
    }
  }

  if (opts.command === "ask") {
    if (!opts.query) {
      console.error(red("error: ask needs a question"));
      return 2;
    }
    try {
      const payload = await answerQuestion(opts.query, { goal: opts.goal, timeoutMs: opts.timeout });
      if (opts.json) console.log(JSON.stringify({ mode: "answer", ...payload }, null, 2));
      else printAsk(payload);
      return 0;
    } catch (err) {
      reportUpstreamError(err);
      return 1;
    }
  }

  // Bare `pharos-docs "<question>"`: answer from the live docs; if they cannot be
  // reached, say so and degrade to the offline index instead of failing or guessing.
  // `search`, `--offline` and `--section` are explicit requests for the index.
  if (!opts.command && !opts.offline && !opts.section) {
    try {
      const payload = await answerQuestion(opts.query, { goal: opts.goal, timeoutMs: opts.timeout });
      if (opts.json) console.log(JSON.stringify({ mode: "answer", ...payload }, null, 2));
      else printAsk(payload);
      return 0;
    } catch (err) {
      const code = err instanceof DocsSourceError ? err.code : "error";
      console.error(yellow(`live docs unavailable (${err.message}) — falling back to the offline index.`));
      console.error(dim("what follows are retrieved passages from the committed index, not a synthesized answer.\n"));
      const results = searchDocs(opts.query, { limit: opts.limit });
      const payload = toToolResult(opts.query, results, { filter: { section: null, limit: opts.limit } });
      if (opts.json) console.log(JSON.stringify({ mode: "offline_fallback", fallback: { code, message: err.message }, ...payload }, null, 2));
      else printSearch(payload);
      return 0;
    }
  }

  if (opts.command === "search" && !opts.query) {
    console.error(red("error: search needs a query"));
    return 2;
  }

  if (opts.command === "verify") {
    return runVerify(opts);
  }

  if (opts.section) {
    const sections = listSections();
    const exact = sections.find((name) => name.toLowerCase() === opts.section.toLowerCase());
    if (!exact) {
      console.error(red(`error: unknown section "${opts.section}"`));
      console.error(dim(`sections: ${sections.join(", ")}`));
      return 2;
    }
    opts.section = exact;
  }

  const results = searchDocs(opts.query, { limit: opts.limit, section: opts.section });
  const payload = toToolResult(opts.query, results, { filter: { section: opts.section || null, limit: opts.limit } });
  if (opts.json) console.log(JSON.stringify(payload, null, 2));
  else printSearch(payload);
  return 0;
}

function reportUpstreamError(err) {
  if (err instanceof DocsSourceError) {
    console.error(red(`error: ${err.message}`));
    console.error(dim(`code: ${err.code}${err.url ? ` · ${err.url}` : ""}`));
    if (err.code === "timeout") console.error(dim("the live docs are slow right now — search the offline index instead: pharos-docs \"<query>\""));
  } else {
    console.error(red(`error: ${err.message}`));
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(red(`fatal: ${err.stack || err.message}`));
    process.exit(1);
  });
