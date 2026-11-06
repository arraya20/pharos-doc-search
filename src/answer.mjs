// Live answer pipeline: MCP `askQuestion` first, GitBook `?ask=` second.
//
// Both hit docs.pharos.xyz and both fail closed. The second one only runs when
// the first failed for a reason that a different endpoint could plausibly avoid
// (HTTP error, network error, unparseable body). A timeout means the upstream
// itself is slow, so retrying it would just double the wait — that error is
// rethrown and the caller decides whether to fall back to the offline index.

import { askDocs, DocsSourceError, DEFAULT_TIMEOUT_MS } from "./docs-source.mjs";
import { askMcp } from "./mcp.mjs";

export async function answerQuestion(question, { goal = "", timeoutMs = DEFAULT_TIMEOUT_MS, mcp = askMcp, ask = askDocs } = {}) {
  try {
    return await mcp(question, { goal, timeoutMs });
  } catch (mcpError) {
    if (!(mcpError instanceof DocsSourceError)) throw mcpError;
    if (mcpError.code === "timeout" || mcpError.code === "bad_request") throw mcpError;

    try {
      const payload = await ask(question, { goal, timeoutMs });
      return { ...payload, via: "gitbook-ask", mcpError: { code: mcpError.code, message: mcpError.message } };
    } catch (askError) {
      // Report both failures; the first is the primary path.
      if (askError instanceof DocsSourceError) {
        const combined = new DocsSourceError(`${mcpError.message}; fallback endpoint also failed: ${askError.message}`, {
          status: askError.status,
          url: askError.url || mcpError.url,
          code: askError.code
        });
        throw combined;
      }
      throw askError;
    }
  }
}
