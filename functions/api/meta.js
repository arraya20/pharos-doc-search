// GET /api/meta — what this deployment knows, and how fresh it is.
import { INDEX_META, DOCS, listSections } from "../../src/kb.mjs";
import { json, preflight } from "../_lib/http.js";

const BUILD = {
  name: "pharos-doc-search",
  version: "1.0.0"
};

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET") return json({ success: false, error: { code: "method_not_allowed", message: "use GET" } }, { status: 405 });

  const bySection = {};
  for (const doc of DOCS) bySection[doc.section] = (bySection[doc.section] || 0) + 1;

  return json(
    {
      success: true,
      build: BUILD,
      index: {
        pageCount: INDEX_META.pageCount,
        contentHash: INDEX_META.contentHash,
        generatedAt: INDEX_META.generatedAt,
        source: INDEX_META.source,
        origin: INDEX_META.origin,
        sections: listSections(),
        pagesBySection: bySection
      },
      endpoints: {
        search: "/api/search?q=<query>&limit=5&section=<name>",
        ask: "/api/ask?q=<question>&goal=<goal>",
        doc: "/api/doc?id=<page-id>&source=index|live",
        meta: "/api/meta"
      },
      upstreams: {
        llmsTxt: INDEX_META.source,
        askEndpoint: INDEX_META.askEndpoint,
        note: "search is local to the edge; ask and source=live call docs.pharos.xyz"
      }
    },
    { cache: "public, max-age=300" }
  );
}
