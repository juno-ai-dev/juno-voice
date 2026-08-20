// Pinata presign worker for Juno Voice.
//
// The browser app never holds a Pinata credential. This worker owns the admin
// JWT (a Cloudflare secret) and issues short-lived signed upload URLs via
// Pinata's v3 API. Abuse controls are deliberately minimal and enforced where
// they cannot be bypassed: per-kind size and MIME caps are baked into the
// signed URL by Pinata itself, URLs expire after 60 seconds, and only
// allowlisted browser origins may ask for one. Rate limiting is delegated to a
// Cloudflare rate-limiting rule (see README.md); a stateless worker cannot
// rate-limit reliably on its own.

const PINATA_SIGN_ENDPOINT = "https://uploads.pinata.cloud/v3/files/sign";
const SIGNED_URL_EXPIRES_SECONDS = 60;
export const SIGN_REQUEST_MAX_BYTES = 1_024;

class RequestTooLargeError extends Error {}

async function readRequestJson(request) {
  const declared = request.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && BigInt(declared) > BigInt(SIGN_REQUEST_MAX_BYTES)) {
    try { await request.body?.cancel(); } catch { /* The rejection remains oversized even if cancellation fails. */ }
    throw new RequestTooLargeError();
  }
  if (!request.body) return JSON.parse("");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > SIGN_REQUEST_MAX_BYTES) {
      try { await reader.cancel(); } catch { /* The rejection remains oversized even if cancellation fails. */ }
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export const KINDS = Object.freeze({
  document: Object.freeze({ maxBytes: 16_384, mimeTypes: Object.freeze(["application/json"]) }),
  image: Object.freeze({ maxBytes: 524_288, mimeTypes: Object.freeze(["image/png", "image/jpeg", "image/webp"]) }),
});

export function allowedOrigin(request, env) {
  const origin = request.headers.get("origin");
  if (!origin || typeof env.ALLOWED_ORIGINS !== "string") return null;
  const allowed = env.ALLOWED_ORIGINS.split(",").map((entry) => entry.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function corsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function json(status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(origin ? corsHeaders(origin) : {}) },
  });
}

// Returns { kind, filename, size, contentType } or { status, error }.
export function validateSignRequest(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { status: 400, error: "The request body must be a JSON object." };
  }
  const kind = KINDS[body.kind];
  if (!kind) return { status: 400, error: "kind must be \"document\" or \"image\"." };
  if (typeof body.filename !== "string" || !body.filename.trim() || body.filename.length > 128) {
    return { status: 400, error: "filename must be 1 to 128 characters." };
  }
  const filename = body.filename.replace(/[^\w.-]+/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+/, "") || "upload";
  if (!Number.isSafeInteger(body.size) || body.size < 1) {
    return { status: 400, error: "size must be a positive integer byte count." };
  }
  if (body.size > kind.maxBytes) {
    return { status: 413, error: `A ${body.kind} upload may be at most ${kind.maxBytes} bytes.` };
  }
  if (typeof body.content_type !== "string" || !kind.mimeTypes.includes(body.content_type)) {
    return { status: 400, error: `content_type must be one of: ${kind.mimeTypes.join(", ")}.` };
  }
  return { kind: body.kind, filename, size: body.size, contentType: body.content_type };
}

export async function handleRequest(request, env, fetcher = fetch) {
  const origin = allowedOrigin(request, env);
  if (request.method === "OPTIONS") {
    return origin
      ? new Response(null, { status: 204, headers: corsHeaders(origin) })
      : json(403, { error: "Origin not allowed." });
  }
  if (request.method !== "POST" || new URL(request.url).pathname !== "/sign") {
    return json(404, { error: "POST /sign is the only endpoint." }, origin);
  }
  if (!origin) return json(403, { error: "Origin not allowed." });
  let body;
  try {
    body = await readRequestJson(request);
  } catch (cause) {
    if (cause instanceof RequestTooLargeError) {
      return json(413, { error: `The request body is too large; the limit is ${SIGN_REQUEST_MAX_BYTES} bytes.` }, origin);
    }
    return json(400, { error: "The request body must be valid JSON." }, origin);
  }
  const validated = validateSignRequest(body);
  if (validated.error) return json(validated.status, { error: validated.error }, origin);
  const limits = KINDS[validated.kind];
  const signRequest = {
    date: Math.floor(Date.now() / 1000),
    expires: SIGNED_URL_EXPIRES_SECONDS,
    filename: validated.filename,
    network: "public",
    max_file_size: limits.maxBytes,
    allow_mime_types: [...limits.mimeTypes],
    ...(typeof env.PINATA_GROUP_ID === "string" && env.PINATA_GROUP_ID ? { group_id: env.PINATA_GROUP_ID } : {}),
  };
  let upstream;
  try {
    upstream = await fetcher(PINATA_SIGN_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${env.PINATA_JWT}`, "content-type": "application/json" },
      body: JSON.stringify(signRequest),
    });
  } catch {
    return json(502, { error: "The pinning service is unreachable." }, origin);
  }
  if (!upstream.ok) {
    // Never echo the upstream body; it can contain account details.
    return json(502, { error: "The pinning service rejected the request." }, origin);
  }
  let payload;
  try {
    payload = await upstream.json();
  } catch {
    return json(502, { error: "The pinning service returned an unreadable response." }, origin);
  }
  const url = typeof payload?.data === "string" ? payload.data
    : typeof payload?.data?.url === "string" ? payload.data.url : null;
  if (!url || !url.startsWith("https://uploads.pinata.cloud/")) {
    return json(502, { error: "The pinning service returned an unexpected response." }, origin);
  }
  return json(200, { url }, origin);
}

export default {
  fetch: (request, env) => handleRequest(request, env),
};
