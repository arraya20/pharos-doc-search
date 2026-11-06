// Client for the Pharos Developer Docs MCP server.
//
//   POST https://docs.pharos.xyz/~gitbook/mcp      (MCP streamable HTTP, JSON-RPC 2.0)
//
// The server is key-free and stateless, so a single `tools/call` is enough — no
// `initialize` handshake or session id. It advertises three tools:
//
//   searchDocumentation  { query }            ranked passages with links
//   getPage              { url }              full markdown of one page
//   askQuestion          { question, goal? }  synthesized answer + "# Sources"
//
// `askQuestion` is what `pharos-docs "<question>"` calls first. Like the rest of
// the live path this fails closed: a timeout, a JSON-RPC error, a tool error or
// an empty body throws a typed DocsSourceError. Nothing is invented to fill a gap.

import { DocsSourceError, DOCS_ORIGIN, DEFAULT_TIMEOUT_MS } from "./docs-source.mjs";

export const MCP_ENDPOINT = `${DOCS_ORIGIN}/~gitbook/mcp`;

/** Pull the JSON-RPC message out of an SSE (`data: {...}`) or plain JSON body. */
export function parseMcpBody(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new DocsSourceError("empty MCP response", { code: "unparseable", url: MCP_ENDPOINT });

  const dataLines = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const candidate = dataLines.length ? dataLines.join("") : text;

  try {
    return JSON.parse(candidate);
  } catch {
    throw new DocsSourceError("MCP response was not valid JSON-RPC", { code: "unparseable", url: MCP_ENDPOINT });
  }
}

/** Call one MCP tool and return its concatenated text content. */
export async function callMcpTool(name, args, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetchImpl(MCP_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "user-agent": "pharos-doc-search-cli/1.0"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    });
    raw = await res.text();
  } catch (err) {
    const timedOut = err.name === "AbortError";
    throw new DocsSourceError(
      timedOut ? `docs MCP did not answer within ${timeoutMs}ms` : `docs MCP request failed: ${err.message}`,
      { status: 0, url: MCP_ENDPOINT, code: timedOut ? "timeout" : "network_error" }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new DocsSourceError(`docs MCP returned HTTP ${res.status}`, { status: res.status, url: MCP_ENDPOINT, code: "upstream_error" });
  }

  const message = parseMcpBody(raw);
  if (message.error) {
    throw new DocsSourceError(`docs MCP error: ${message.error.message || JSON.stringify(message.error)}`, {
      status: res.status,
      url: MCP_ENDPOINT,
      code: "upstream_error"
    });
  }

  const content = Array.isArray(message.result?.content) ? message.result.content : [];
  const text = content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();

  if (message.result?.isError) {
    throw new DocsSourceError(`docs MCP tool ${name} failed: ${text || "no detail"}`, { status: res.status, url: MCP_ENDPOINT, code: "upstream_error" });
  }
  if (!text) throw new DocsSourceError(`docs MCP tool ${name} returned no text`, { status: res.status, url: MCP_ENDPOINT, code: "unparseable" });

  return { text, status: res.status };
}

/** Turn `](/path)` links in an answer into absolute docs URLs. */
export function absolutizeDocLinks(markdown) {
  return String(markdown || "").replace(/\]\((\/[^)\s]*)\)/g, (_, path) => `](${DOCS_ORIGIN}${path.replace(/\.md$/, "")})`);
}

/**
 * Split an `askQuestion` result into the answer and its source list.
 * Shape: answer body, then `# Sources` followed by `- [title](url)` lines.
 */
export function parseMcpAnswer(text, { question = "" } = {}) {
  const cleaned = String(text || "").replace(/\r\n/g, "\n").trim();
  const split = cleaned.split(/\n#{1,3}\s+Sources?:?\s*\n/i);
  const answer = absolutizeDocLinks((split[0] || "").trim());
  const sourceBlock = split.slice(1).join("\n");

  const sources = [];
  const seen = new Set();
  const re = /^\s*[-*]\s+\[(.+?)\]\((\S+?)\)\s*$/gm;
  let m;
  while ((m = re.exec(sourceBlock))) {
    const url = m[2].replace(/\.md$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    sources.push({ title: m[1].trim(), url, mdUrl: `${url}.md` });
  }

  if (!answer) throw new DocsSourceError("MCP answer had no body", { code: "unparseable", url: MCP_ENDPOINT });
  return { question, answer, sources };
}

/** Ask the docs MCP server a question via its `askQuestion` tool. */
export async function askMcp(question, { goal = "", timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const q = String(question || "").trim();
  if (!q) throw new DocsSourceError("question is required", { code: "bad_request" });

  const args = { question: q };
  if (goal) args.goal = goal;
  const { text, status } = await callMcpTool("askQuestion", args, { timeoutMs, fetchImpl });
  const parsed = parseMcpAnswer(text, { question: q });

  return {
    success: true,
    via: "mcp",
    question: q,
    goal: goal || null,
    answer: parsed.answer,
    sources: parsed.sources,
    followups: [],
    fetchedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    upstream: { url: MCP_ENDPOINT, tool: "askQuestion", httpStatus: status }
  };
}
