// GET|POST /api/search?q=<query>&limit=<n>&section=<name>
//
// Offline BM25 search over the generated documentation index. Runs at the edge
// with no upstream call, so it is always available even when docs.pharos.xyz is
// slow — which is exactly when agents need it.
import { searchDocs, toToolResult, listSections, getDoc, INDEX_META, DOCS } from "../../src/kb.mjs";
import { json, fail, preflight, readParams, clampInt } from "../_lib/http.js";

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET" && request.method !== "POST") {
    return fail("only GET and POST are supported", { status: 405, code: "method_not_allowed" });
  }

  let params;
  try {
    params = await readParams(request, ["q", "query", "limit", "section", "id"]);
  } catch (err) {
    return fail(err.message, { status: 400 });
  }

  // Single-page lookup, handy for agents that already know the id.
  const id = params.id;
  if (id !== undefined) {
    const doc = getDoc(id);
    if (!doc) return fail(`no page with id "${id}"`, { status: 404, code: "doc_not_found" });
    return json({ success: true, doc }, { cache: "public, max-age=3600" });
  }

  const query = (params.q ?? params.query ?? "").trim();
  if (!query) {
    return fail('missing query — pass ?q=<query> or a JSON body {"query":"..."}', {
      status: 400,
      code: "missing_query",
      extra: { pages: INDEX_META.pageCount, sections: listSections() }
    });
  }

  const limit = clampInt(params.limit, { min: 1, max: 20, fallback: 5 });
  const section = params.section || null;
  const results = searchDocs(query, { limit, section });
  const payload = toToolResult(query, results, {
    filter: { section, limit },
    runtime: "cloudflare-pages-function",
    availablePages: DOCS.length
  });

  return json(payload, { cache: "public, max-age=300" });
}
