// Shared helpers for the Pages Functions API.

export const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type"
};

export function json(body, { status = 200, cache = "no-store", headers = {} } = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cache,
      ...CORS_HEADERS,
      ...headers
    }
  });
}

export function fail(message, { status = 400, code = "bad_request", extra = {} } = {}) {
  return json({ success: false, error: { code, message }, ...extra }, { status });
}

export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

const MAX_BODY_BYTES = 8 * 1024;

/** Read params from the query string or a JSON body, so GET and POST behave alike. */
export async function readParams(request, names) {
  const url = new URL(request.url);
  const params = {};
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value !== null) params[name] = value;
  }
  if (request.method === "POST") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      // A search request is a few hundred bytes. Refuse anything that is not,
      // rather than buffering an unbounded body into the edge isolate.
      const declared = Number.parseInt(request.headers.get("content-length") || "", 10);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new Error(`request body is too large (max ${MAX_BODY_BYTES} bytes)`);
      }
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) throw new Error(`request body is too large (max ${MAX_BODY_BYTES} bytes)`);
      let body;
      try {
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        throw new Error("request body is not valid JSON");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("request body must be a JSON object");
      }
      for (const name of names) {
        if (body[name] !== undefined && body[name] !== null) params[name] = String(body[name]);
      }
    }
  }
  return params;
}

export function clampInt(value, { min, max, fallback }) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
