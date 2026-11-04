// GET /api/doc?id=<page-id>&source=live|index
//
// One page of the documentation. `live` fetches the current markdown from
// docs.pharos.xyz; `index` returns the copy baked into the build (always
// available, possibly one build behind).
import { getDoc, INDEX_META } from "../../src/kb.mjs";
import { fetchDocMarkdown, DocsSourceError } from "../../src/docs-source.mjs";
import { json, fail, preflight, readParams, clampInt } from "../_lib/http.js";

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET" && request.method !== "POST") {
    return fail("only GET and POST are supported", { status: 405, code: "method_not_allowed" });
  }

  let params;
  try {
    params = await readParams(request, ["id", "source", "live", "timeout"]);
  } catch (err) {
    return fail(err.message, { status: 400 });
  }

  const doc = getDoc(params.id || "");
  if (!doc) {
    return fail(`no page with id "${params.id || ""}"`, { status: 404, code: "doc_not_found" });
  }

  // `source=live` is the documented switch; `live=1` is accepted because that is
  // what people type. Anything else is a mistake worth reporting, not defaulting.
  let mode;
  if (params.source !== undefined) {
    mode = params.source;
  } else if (params.live !== undefined) {
    mode = params.live === "1" || params.live === "true" ? "live" : "index";
  } else {
    mode = "index";
  }
  if (mode !== "index" && mode !== "live") {
    return fail(`unknown source "${mode}" — use source=index or source=live`, {
      status: 400,
      code: "bad_request"
    });
  }

  if (mode === "index") {
    return json(
      {
        success: true,
        source: "index",
        index: { contentHash: INDEX_META.contentHash, generatedAt: INDEX_META.generatedAt },
        doc
      },
      { cache: "public, max-age=3600" }
    );
  }

  const timeoutMs = clampInt(params.timeout, { min: 3_000, max: 20_000, fallback: 15_000 });
  try {
    const live = await fetchDocMarkdown(doc, { timeoutMs });
    return json({ success: true, source: "live", ...live, doc: { id: doc.id, title: doc.title, section: doc.section } });
  } catch (err) {
    if (err instanceof DocsSourceError) {
      return fail(`${err.message} — the index copy is still available with source=index`, {
        status: err.code === "timeout" ? 504 : 502,
        code: err.code
      });
    }
    return fail(`doc fetch failed: ${err.message}`, { status: 500, code: "internal_error" });
  }
}
