// Live documentation access.
//
// Two official, key-free surfaces are used:
//
//   1. `GET https://docs.pharos.xyz/index.md?ask=<question>&goal=<goal>`
//      GitBook's agentic ask endpoint: a grounded answer plus the source pages
//      it used. Documented in https://docs.pharos.xyz/llms.txt.
//
//   2. `GET https://docs.pharos.xyz/<path>.md`
//      The raw markdown for any page in the index.
//
// Everything here fails closed: a non-200, a timeout, or an unparseable body
// throws a typed error. Nothing is invented to fill the gap.

export const DOCS_ORIGIN = "https://docs.pharos.xyz";
export const ASK_ENDPOINT = `${DOCS_ORIGIN}/index.md`;
export const DEFAULT_TIMEOUT_MS = 45_000;

export class DocsSourceError extends Error {
  constructor(message, { status = 0, url = "", code = "upstream_error" } = {}) {
    super(message);
    this.name = "DocsSourceError";
    this.status = status;
    this.url = url;
    this.code = code;
  }
}

async function get(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/markdown,text/plain;q=0.9,*/*;q=0.5", "user-agent": "pharos-doc-search-cli/1.0" },
      redirect: "follow"
    });
    const body = await res.text();
    if (!res.ok) {
      throw new DocsSourceError(`docs.pharos.xyz returned HTTP ${res.status}`, {
        status: res.status,
        url,
        code: res.status === 404 ? "not_found" : "upstream_error"
      });
    }
    return { body, status: res.status, finalUrl: res.url };
  } catch (err) {
    if (err instanceof DocsSourceError) throw err;
    const timedOut = err.name === "AbortError";
    throw new DocsSourceError(
      timedOut ? `docs.pharos.xyz did not answer within ${timeoutMs}ms` : `docs.pharos.xyz request failed: ${err.message}`,
      { status: 0, url, code: timedOut ? "timeout" : "network_error" }
    );
  } finally {
    clearTimeout(timer);
  }
}

function pageUrlFromMarkdown(mdUrl) {
  return mdUrl.replace(/\.md$/, "");
}

function parseLinkList(block) {
  const items = [];
  const re = /^-\s+\[(.+?)\]\((\S+?)\)\s*$/gm;
  let m;
  while ((m = re.exec(block))) {
    const [, title, url] = m;
    items.push({ title: title.trim(), url: pageUrlFromMarkdown(url), mdUrl: url });
  }
  return items;
}

/**
 * Split a GitBook ask response into answer, follow-ups and sources.
 * Response shape (see llms.txt): an H1 question, the answer body, then
 * "# Suggested Follow-up Questions:" and "# Sources:" sections.
 */
export function parseAskResponse(text, { question = "" } = {}) {
  const cleaned = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!cleaned) throw new DocsSourceError("empty ask response", { code: "unparseable" });

  const sections = {};
  let current = "answer";
  sections[current] = [];
  for (const line of cleaned.split("\n")) {
    if (/^#\s+Suggested Follow-up Questions:/i.test(line)) {
      current = "followups";
      sections[current] = sections[current] || [];
      continue;
    }
    if (/^#\s+Sources:/i.test(line)) {
      current = "sources";
      sections[current] = sections[current] || [];
      continue;
    }
    if (/^#\s+/.test(line) && current === "answer" && sections.answer.length === 0) {
      // The H1 echo of the question.
      sections.question = [line.replace(/^#\s+/, "")];
      continue;
    }
    sections[current].push(line);
  }

  const answer = (sections.answer || []).join("\n").trim();
  const sources = parseLinkList((sections.sources || []).join("\n"));
  const followups = parseLinkList((sections.followups || []).join("\n")).map((item) => ({
    question: item.title,
    url: item.url
  }));

  if (!answer) throw new DocsSourceError("ask response had no answer body", { code: "unparseable" });

  return {
    question: (sections.question || [question])[0] || question,
    answer,
    sources,
    followups
  };
}

/** Ask the live documentation a question. Returns a grounded answer + sources. */
export async function askDocs(question, { goal = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new DocsSourceError("question is required", { code: "bad_request" });

  const url = new URL(ASK_ENDPOINT);
  url.searchParams.set("ask", q);
  if (goal) url.searchParams.set("goal", goal);

  const { body, status } = await get(url.toString(), timeoutMs);
  const parsed = parseAskResponse(body, { question: q });
  return {
    success: true,
    question: q,
    goal: goal || null,
    answer: parsed.answer,
    sources: parsed.sources,
    followups: parsed.followups,
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    upstream: { url: url.toString(), httpStatus: status }
  };
}

/**
 * GitBook answers a missing page with HTTP 200 and a "Page Not Found" body.
 * Status alone therefore cannot prove a page exists.
 */
export const NOT_FOUND_BODY = /^#\s+Page Not Found\b/;

export function isSoftNotFound(body) {
  return NOT_FOUND_BODY.test(String(body || "").trimStart());
}

/**
 * Link-liveness decision for one fetched page. `verify` and the live link test
 * both reduce to this: HTTP status alone cannot prove a page exists, because
 * GitBook answers a missing page with 200 and a "Page Not Found" body.
 */
export function verifyFetchHealthy({ status, body }) {
  if (status !== 200) return { ok: false, error: `HTTP ${status}` };
  if (isSoftNotFound(body)) return { ok: false, error: 'soft 404 (HTTP 200 with a "Page Not Found" body)' };
  return { ok: true, error: "" };
}

/** Fetch the raw markdown of one indexed page. */
export async function fetchDocMarkdown(doc, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!doc || !doc.mdUrl) throw new DocsSourceError("unknown document", { code: "bad_request" });
  const { body, status } = await get(doc.mdUrl, timeoutMs);
  if (isSoftNotFound(body)) {
    throw new DocsSourceError(`${doc.mdUrl} is a soft 404 (HTTP ${status} with a "Page Not Found" body)`, {
      status,
      url: doc.mdUrl,
      code: "not_found"
    });
  }
  const markdown = stripAgentInstructions(body);
  if (!markdown) throw new DocsSourceError(`${doc.mdUrl} returned an empty page`, { status, url: doc.mdUrl, code: "unparseable" });
  return { markdown, httpStatus: status, url: doc.url, mdUrl: doc.mdUrl };
}

export function stripAgentInstructions(markdown) {
  let text = String(markdown || "");
  const cut = text.indexOf("\n# Agent Instructions");
  if (cut !== -1) text = text.slice(0, cut);
  return text.replace(/^>\s*For the complete documentation index[\s\S]*?\n\n/, "").replace(/\n{3,}/g, "\n\n").trim();
}
