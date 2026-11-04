// GET|POST /api/ask?q=<question>&goal=<goal>
//
// Proxies GitBook's agentic ask endpoint on docs.pharos.xyz. That endpoint is
// genuinely slow (7–25s), so the timeout is explicit and the failure is
// reported as a failure — never as an invented answer.
import { askDocs, DocsSourceError } from "../../src/docs-source.mjs";
import { json, fail, preflight, readParams, clampInt } from "../_lib/http.js";

const MAX_TIMEOUT_MS = 25_000;

export async function onRequest(context) {
  const { request } = context;
  if (request.method === "OPTIONS") return preflight();
  if (!["GET", "POST"].includes(request.method)) {
    return fail("only GET and POST are supported", { status: 405, code: "method_not_allowed" });
  }

  let params;
  try {
    params = await readParams(request, ["q", "question", "goal", "timeout"]);
  } catch (err) {
    return fail(err.message, { status: 400 });
  }

  // ?q= wins only when it actually carries text; an empty body field must not
  // shadow a real query parameter.
  const question = [params.q, params.question].map((v) => String(v ?? "").trim()).find(Boolean) || "";
  if (!question) {
    return fail('missing question — pass ?q=<question> or a JSON body {"question":"..."}', {
      status: 400,
      code: "missing_question"
    });
  }
  if (question.length > 500) return fail("question is too long (max 500 chars)", { status: 400, code: "question_too_long" });

  const timeoutMs = clampInt(params.timeout, { min: 5_000, max: MAX_TIMEOUT_MS, fallback: 20_000 });

  try {
    const payload = await askDocs(question, { goal: params.goal || "", timeoutMs });
    return json({ ...payload, runtime: "cloudflare-pages-function" });
  } catch (err) {
    if (err instanceof DocsSourceError) {
      const status = err.code === "timeout" ? 504 : err.code === "not_found" ? 404 : 502;
      return fail(err.message, {
        status,
        code: err.code,
        extra: { upstream: { url: err.url || null, httpStatus: err.status || null } }
      });
    }
    return fail(`ask failed: ${err.message}`, { status: 500, code: "internal_error" });
  }
}
