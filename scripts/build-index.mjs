#!/usr/bin/env node
// Build the offline documentation index from the live Pharos docs.
//
// Source of truth: https://docs.pharos.xyz/llms.txt (official GitBook index)
// Each entry points at a real page; both the HTML URL and the .md URL are
// fetched and their HTTP status recorded. If any page fails, the build exits
// non-zero instead of silently shipping a dead link.
//
// Output is written as two artifacts derived from one payload:
//   src/index.generated.mjs  — full index, used by the CLI and Pages Functions
//   public/index.generated.js — slim index for the browser (plain text only)
// The search engine itself is copied from src/kb.mjs to public/kb.mjs, so the
// CLI, the API and the dashboard run identical ranking code.

import { writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://docs.pharos.xyz";
const INDEX_URL = `${ORIGIN}/llms.txt`;
const CONCURRENCY = 6;
const TIMEOUT_MS = 25_000;
const MAX_BODY_CHARS = 7_000;

const SECTION_NAMES = {
  "": "Root",
  introduction: "Introduction",
  "getting-started": "Getting Started",
  "node-and-validator-guide": "Node & Validator",
  "tooling-and-infrastructure": "Tooling & Infrastructure",
  "api-and-sdk": "API & SDK",
  "developer-guide": "Developer Guide",
  resources: "Resources"
};

async function getText(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/markdown,text/plain;q=0.9,*/*;q=0.5", "user-agent": "pharos-doc-search-indexer/1.0" },
      redirect: "follow"
    });
    const body = await res.text();
    return { status: res.status, body, url: res.url };
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 700 * attempt));
      return getText(url, attempt + 1);
    }
    return { status: 0, body: "", url, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Some GitBook hosts answer a missing page with HTTP 200 and a "Page Not Found"
 * markdown body. `res.ok` is not enough — indexing that placeholder would ship
 * an empty page under a real URL, and a live link check would call it healthy.
 */
const NOT_FOUND_BODY = /^#\s+Page Not Found\b/;
export function isSoftNotFound(body) {
  return NOT_FOUND_BODY.test(String(body || "").trimStart());
}

/** Parse the llms.txt bullet list into ordered entries. */
export function parseLlmsTxt(text) {
  const entries = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(/^-\s+\[(.+?)\]\((https?:\/\/[^)\s]+)\)\s*(?::\s*(.*))?$/);
    if (!m) continue;
    const [, rawTitle, url, desc = ""] = m;
    if (!url.startsWith(ORIGIN)) continue;
    const path = url.slice(ORIGIN.length).replace(/\.md$/, "").replace(/^\//, "");
    if (!path) continue;
    entries.push({
      id: path,
      title: rawTitle.replace(/\\_/g, "_").replace(/\s+/g, " ").trim(),
      description: desc.trim(),
      url: `${ORIGIN}/${path}`,
      mdUrl: `${ORIGIN}/${path}.md`
    });
  }
  return entries;
}

/** Remove GitBook chrome so search never matches repeated boilerplate. */
export function stripBoilerplate(markdown) {
  let text = markdown;
  const agentBlock = text.indexOf("\n# Agent Instructions");
  if (agentBlock !== -1) text = text.slice(0, agentBlock);
  const hrBlock = text.indexOf("\n---\n\n# Agent Instructions");
  if (hrBlock !== -1) text = text.slice(0, hrBlock);
  text = text.replace(/^>\s*For the complete documentation index[\s\S]*?\n\n/, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Undo CommonMark backslash escapes. GitBook writes `# eth\_getProof` so that
 * the underscore is not read as emphasis, but that backslash is markup, not
 * content: rendered as text it leaks through as "eth\_getProof" in titles,
 * headings and snippets. Only ASCII punctuation can be escaped, so only that
 * is unescaped.
 */
export function unescapeMarkdown(value) {
  // GitBook's markdown export escapes inconsistently — `wss\://` next to
  // `wss://`, `api\_key` next to `apikey` — so one pass leaves half-unescaped
  // text behind. Repeat until stable (bounded; three is generous). Letters and
  // digits are never unescaped, so `C:\\Users` and `\n` inside code survive.
  let text = String(value);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
    if (next === text) break;
    text = next;
  }
  return text;
}

export function extractHeadings(markdown) {
  const headings = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) {
      const clean = m[2]
        .replace(/<[^>]*>/g, " ") // GitBook appends <a href="#anchor"></a> to headings
        .replace(/[*`]/g, "")
        .replace(/\s+/g, " ");
      const heading = unescapeMarkdown(clean).trim();
      if (heading) headings.push(heading);
    }
  }
  return [...new Set(headings)].slice(0, 20);
}

export function extractTitle(markdown, fallback) {
  const h1 = markdown.match(/^#\s+(.+)$/m);
  return h1 ? unescapeMarkdown(h1[1].replace(/[*`]/g, "")).trim() : unescapeMarkdown(fallback);
}

/**
 * Flatten markdown into one searchable/snippet-friendly line.
 * Table separator rows are dropped, pipes become separators, links collapse to
 * their text, and code fences keep their content — otherwise a snippet for
 * "chain id" reads like "| ChainID | 1672 | | ------- | ---- |".
 */
export function toPlainText(markdown) {
  let inFence = false;
  const kept = [];
  for (const raw of markdown.split("\n")) {
    if (/^\s*```/.test(raw)) {
      // The fence contributes only its language tag ("shell", "json") otherwise.
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      // Code samples are already plain text; stripping "markup" out of them
      // mangles the one thing a reader might want to copy.
      kept.push(raw.trim());
      continue;
    }
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(raw)) continue; // table separator row
    kept.push(unescapeMarkdown(tidyProse(raw)));
  }
  return kept
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One line of prose markdown, flattened. */
function tidyProse(line) {
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    // Autolinks are plain text by now, so anything still tag-shaped is markup
    // (<figure>, <img src=...>) that would print as literal angle brackets.
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    .replace(/^\s*\|/g, "")
    .replace(/\|\s*$/g, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/[*`]/g, "")
    .trim();
}


function sectionFor(id) {
  const first = id.split("/")[0];
  if (!id.includes("/")) return SECTION_NAMES[""];
  return SECTION_NAMES[first] || first.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  process.stdout.write(`→ fetching ${INDEX_URL}\n`);
  const indexRes = await getText(INDEX_URL);
  if (indexRes.status !== 200) {
    console.error(`✖ llms.txt returned HTTP ${indexRes.status}`);
    process.exit(1);
  }

  const entries = parseLlmsTxt(indexRes.body);
  if (entries.length < 20) {
    console.error(`✖ only ${entries.length} entries parsed from llms.txt — refusing to build`);
    process.exit(1);
  }
  process.stdout.write(`→ ${entries.length} documentation pages listed\n`);

  const failures = [];
  const docs = await mapLimit(entries, CONCURRENCY, async (entry) => {
    const page = await getText(entry.mdUrl);
    if (page.status !== 200 || page.body.trim().length < 30 || isSoftNotFound(page.body)) {
      failures.push({
        id: entry.id,
        status: page.status,
        error: page.error || (isSoftNotFound(page.body) ? "soft 404 (Page Not Found body)" : "empty body")
      });
      return null;
    }
    const markdown = stripBoilerplate(page.body);
    const title = extractTitle(markdown, entry.title);
    const headings = extractHeadings(markdown);
    const body = markdown
      .replace(/^#\s+.+\n/, "")
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/\n{2,}/g, "\n"))
      .trim();

    return {
      id: entry.id,
      title,
      section: sectionFor(entry.id),
      url: entry.url,
      mdUrl: entry.mdUrl,
      description: entry.description || firstParagraph(body),
      headings,
      text: body.slice(0, MAX_BODY_CHARS),
      plain: toPlainText(body),
      bytes: Buffer.byteLength(page.body, "utf8"),
      httpStatus: page.status
    };
  });

  if (failures.length) {
    console.error(`✖ ${failures.length} page(s) failed:`);
    for (const f of failures) console.error(`   ${f.id} → HTTP ${f.status} ${f.error || ""}`);
    console.error("  refusing to write an index with dead links");
    process.exit(1);
  }

  const sorted = docs.filter(Boolean).sort((a, b) => a.id.localeCompare(b.id));
  const sections = [...new Set(sorted.map((d) => d.section))].sort((a, b) =>
    a === "Root" ? -1 : b === "Root" ? 1 : a.localeCompare(b)
  );

  // contentHash must depend on page content and nothing else. Hashing the whole
  // record made every rebuild produce a new hash (and a new git diff) even when
  // not one byte of documentation had changed, which made the hash useless as a
  // "did the docs move?" signal. Field order is fixed here, not inherited from
  // object literal order, so the projection cannot drift silently.
  const hash = hashDocs(sorted);

  // Keep the previous build timestamp when the content is unchanged, so an
  // unchanged rebuild is a byte-for-byte no-op in git rather than churn.
  const previous = await readMeta(join(ROOT, "src", "index.generated.mjs"));
  const nowStamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const generatedAt = previous && previous.contentHash === hash ? previous.generatedAt : nowStamp;

  const meta = {
    source: INDEX_URL,
    origin: ORIGIN,
    pageCount: sorted.length,
    sections,
    contentHash: hash,
    generatedAt,
    askEndpoint: `${ORIGIN}/index.md?ask=<question>&goal=<goal>`
  };

  const header = [
    "// Generated by scripts/build-index.mjs — do not edit by hand.",
    "// Source: https://docs.pharos.xyz/llms.txt",
    "// Regenerate with: npm run build:index"
  ];

  const fullFile = [
    ...header,
    `export const INDEX_META = ${JSON.stringify(meta, null, 2)};`,
    "",
    `export const DOCS = ${JSON.stringify(sorted, null, 2)};`,
    "",
    "export default DOCS;",
    ""
  ].join("\n");

  // The browser bundle carries only the fields the dashboard needs. Same page
  // set, same hash: test/bundle.test.mjs proves the two never drift.
  const slim = sorted.map((doc) => ({
    id: doc.id,
    title: doc.title,
    section: doc.section,
    url: doc.url,
    mdUrl: doc.mdUrl,
    description: doc.description,
    headings: doc.headings,
    plain: doc.plain
  }));
  const slimFile = [
    ...header,
    "// Slim build for the browser: no markdown bodies, `plain` only.",
    `export const INDEX_META = ${JSON.stringify(meta, null, 2)};`,
    "",
    `export const DOCS = ${JSON.stringify(slim)};`,
    "",
    "export default DOCS;",
    ""
  ].join("\n");

  await writeFile(join(ROOT, "src", "index.generated.mjs"), fullFile, "utf8");
  await writeFile(join(ROOT, "public", "index.generated.js"), slimFile, "utf8");

  // The browser runs the same ranking code as the CLI and the Pages Function —
  // copied, not reimplemented, so the three can never disagree. Only the import
  // specifier differs (.mjs in src, .js served statically).
  const engine = await readFile(join(ROOT, "src", "kb.mjs"), "utf8");
  const browserEngine = engine
    .replace('from "./index.generated.mjs"', 'from "./index.generated.js"')
    .replace(
      "// Search engine over the generated Pharos documentation index.",
      "// Copy of src/kb.mjs generated by scripts/build-index.mjs — do not edit.\n// Search engine over the generated Pharos documentation index."
    );
  await writeFile(join(ROOT, "public", "kb.mjs"), browserEngine, "utf8");

  const totalKb = (Buffer.byteLength(fullFile, "utf8") / 1024).toFixed(0);
  const slimKb = (Buffer.byteLength(slimFile, "utf8") / 1024).toFixed(0);
  process.stdout.write(
    `✔ indexed ${sorted.length} pages across ${sections.length} sections (${totalKb} KB full / ${slimKb} KB browser, hash ${hash})\n`
  );
}

/**
 * The exact fields that make up "the documentation". Anything time-derived
 * (fetch timestamps, build stamps) is deliberately absent.
 */
export function contentProjection(docs) {
  return docs.map((doc) => ({
    id: doc.id,
    title: doc.title,
    section: doc.section,
    url: doc.url,
    mdUrl: doc.mdUrl,
    description: doc.description,
    headings: doc.headings,
    text: doc.text,
    plain: doc.plain,
    bytes: doc.bytes
  }));
}

/** Stable 16-char content hash. Same docs in, same hash out — always. */
export function hashDocs(docs) {
  return createHash("sha256").update(JSON.stringify(contentProjection(docs))).digest("hex").slice(0, 16);
}

/** Read contentHash/generatedAt back out of an already-generated index file. */
export async function readMeta(path) {
  try {
    const source = await readFile(path, "utf8");
    const contentHash = source.match(/"contentHash":\s*"([0-9a-f]+)"/);
    const generatedAt = source.match(/"generatedAt":\s*"([^"]+)"/);
    if (!contentHash || !generatedAt) return null;
    return { contentHash: contentHash[1], generatedAt: generatedAt[1] };
  } catch {
    return null;
  }
}

function firstParagraph(text) {
  const paragraph = text
    .split("\n\n")
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("|") && !p.startsWith("-") && !p.startsWith(">"));
  if (!paragraph) return "";
  return unescapeMarkdown(paragraph.replace(/[*`\[\]]/g, "")).replace(/\s+/g, " ").slice(0, 240);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`✖ index build failed: ${err.stack || err.message}`);
    process.exit(1);
  });
}
