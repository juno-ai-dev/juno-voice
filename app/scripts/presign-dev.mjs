// Dev-server presign endpoint for `npm run dev`.
//
// Vite has no Next.js-style API routes: it builds static assets, and its dev
// server is a connect middleware stack. That suits this app, because the
// presign endpoint must never exist inside a production artifact -- in
// production it is the Cloudflare Worker in infra/pinata-presign-worker.
//
// This plugin mounts the SAME worker module as a same-origin dev endpoint, so
// there is one implementation and no drift:
//
//   PINATA_JWT set   -> "pinata" mode: real worker, real Pinata, real IPFS.
//   PINATA_JWT unset -> "offline" mode: documents are pinned to a local store
//                       under app/.dev-ipfs and served back through a dev
//                       gateway, so the publish -> fetch -> verify loop works
//                       with no account and no network. Pins are local only;
//                       the app shows a standing notice whenever the gateway
//                       is same-origin (see AppConfig.localPinStore).
//
// The plugin is only ever created for `vite dev`: never for builds, previews,
// or vitest.

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { handleRequest, validateSignRequest, KINDS } from "../../infra/pinata-presign-worker/worker.mjs";

export const PRESIGN_PATH = "/api/presign/sign";
export const DEV_IPFS_PREFIX = "/api/dev-ipfs";
export const DEV_GATEWAY_PATH = `${DEV_IPFS_PREFIX}/ipfs`;
export const DEV_UPLOAD_PATH = `${DEV_IPFS_PREFIX}/upload`;
export const DEV_PIN_DIR = ".dev-ipfs";
// Mirrors DEFAULT_IPFS_GATEWAY in src/config.ts. .env.example spells the
// default out, so a copied env file states it explicitly without meaning to
// choose it: treat that value as "not configured" and let offline mode use its
// own gateway, or locally pinned documents would never resolve.
const DEFAULT_GATEWAY = "https://ipfs.io/ipfs";

const SIGNED_URL_TTL_MS = 60_000;
const MAX_REQUEST_BYTES = 1_048_576;
// Hop-by-hop and connection headers must not be copied onto a fetch Request.
const SKIPPED_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length"]);

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

// RFC 4648 base32, lowercase, unpadded -- the multibase "b" encoding CIDv1 uses.
export function base32Lower(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// CIDv1, raw codec, sha2-256: the identifier a raw block of these exact bytes
// has on IPFS. It is a real CID for real bytes; only the pin is local.
export function rawCidV1(bytes) {
  const digest = createHash("sha256").update(bytes).digest();
  const multihash = Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...digest]);
  return `b${base32Lower(multihash)}`;
}

export function createMemoryPinStore() {
  const pins = new Map();
  return {
    async put(cid, bytes, meta) { pins.set(cid, { bytes, meta }); },
    async get(cid) { return pins.get(cid) ?? null; },
  };
}

export function createFilePinStore(dir) {
  const filePath = (cid, suffix = "") => path.join(dir, `${cid}${suffix}`);
  return {
    async put(cid, bytes, meta) {
      await mkdir(dir, { recursive: true });
      await writeFile(filePath(cid), bytes);
      await writeFile(filePath(cid, ".meta.json"), JSON.stringify(meta, null, 2));
    },
    async get(cid) {
      try {
        const bytes = await readFile(filePath(cid));
        const meta = JSON.parse(await readFile(filePath(cid, ".meta.json"), "utf8"));
        return { bytes, meta };
      } catch {
        return null;
      }
    },
  };
}

// Offline endpoint: presign, upload, and gateway reads against a local store.
// It mirrors the guarantees the deployed worker relies on Pinata for -- the
// per-kind size and MIME caps, single use, and a 60-second expiry -- so code
// paths that work here work against the real thing.
export function createOfflineEndpoint({ store, now = () => Date.now() }) {
  const tickets = new Map();
  return async function handleOffline(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json(403, { error: "Origin not allowed." });

    if (url.pathname === PRESIGN_PATH) {
      if (request.method !== "POST") return json(405, { error: "POST is the only method." });
      let body;
      try {
        body = await request.json();
      } catch {
        return json(400, { error: "The request body must be valid JSON." });
      }
      const validated = validateSignRequest(body);
      if (validated.error) return json(validated.status, { error: validated.error });
      const token = randomUUID();
      tickets.set(token, { ...validated, expiresAt: now() + SIGNED_URL_TTL_MS });
      return json(200, { url: `${DEV_UPLOAD_PATH}?token=${token}` });
    }

    if (url.pathname === DEV_UPLOAD_PATH) {
      if (request.method !== "POST") return json(405, { error: "POST is the only method." });
      const ticket = tickets.get(url.searchParams.get("token") ?? "");
      if (!ticket) return json(403, { error: "This upload link is not valid." });
      tickets.delete(url.searchParams.get("token"));
      if (now() > ticket.expiresAt) return json(403, { error: "This upload link has expired." });
      let file;
      try {
        file = (await request.formData()).get("file");
      } catch {
        return json(400, { error: "The upload must be multipart form data." });
      }
      if (!file || typeof file.arrayBuffer !== "function") return json(400, { error: "The upload is missing a file part." });
      if (file.type && file.type !== ticket.contentType) return json(400, { error: "The file type does not match the signed request." });
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > KINDS[ticket.kind].maxBytes) return json(413, { error: `A ${ticket.kind} upload may be at most ${KINDS[ticket.kind].maxBytes} bytes.` });
      if (bytes.length !== ticket.size) return json(400, { error: "The uploaded size does not match the signed request." });
      const cid = rawCidV1(bytes);
      await store.put(cid, bytes, { contentType: ticket.contentType, filename: ticket.filename, size: bytes.length });
      return json(200, { data: { cid } });
    }

    if (url.pathname.startsWith(`${DEV_GATEWAY_PATH}/`)) {
      if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "GET is the only method." });
      const [cid] = url.pathname.slice(`${DEV_GATEWAY_PATH}/`.length).split("/");
      if (!/^b[a-z2-7]{20,}$/.test(cid ?? "")) return json(400, { error: "Not a supported content identifier." });
      const entry = await store.get(cid);
      if (!entry) return json(404, { error: "Nothing is pinned in the local store under that identifier." });
      return new Response(entry.bytes, {
        status: 200,
        headers: {
          "content-type": entry.meta?.contentType ?? "application/octet-stream",
          "cache-control": "no-store",
          "x-dev-pin-store": "local",
        },
      });
    }

    return null;
  };
}

// Pinata mode: the deployed worker, verbatim. Same-origin dev requests carry an
// Origin header the worker checks, so the allowlist is the dev server itself.
export function createPinataEndpoint({ jwt, groupId, fetcher }) {
  return async function handlePinata(request) {
    const url = new URL(request.url);
    if (url.pathname !== PRESIGN_PATH) return null;
    const workerUrl = new URL(request.url);
    workerUrl.pathname = "/sign";
    const workerRequest = new Request(workerUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    });
    const env = { PINATA_JWT: jwt, ALLOWED_ORIGINS: url.origin, ...(groupId ? { PINATA_GROUP_ID: groupId } : {}) };
    return handleRequest(workerRequest, env, fetcher ?? fetch);
  };
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      req.destroy();
      throw new Error("too_large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function toWebRequest(req) {
  const protocol = req.socket?.encrypted ? "https" : "http";
  const url = new URL(req.url ?? "/", `${protocol}://${req.headers.host ?? "127.0.0.1"}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (SKIPPED_HEADERS.has(name)) continue;
    for (const entry of Array.isArray(value) ? value : [value]) if (typeof entry === "string") headers.append(name, entry);
  }
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : await readBody(req, MAX_REQUEST_BYTES);
  return new Request(url, { method, headers, body });
}

async function sendWebResponse(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => res.setHeader(name, value));
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * Decides whether the dev endpoint applies, which mode it runs in, and the
 * env defaults the browser build needs. Returns a Vite plugin or null.
 */
export function createPresignDev({ command, mode, isPreview = false, env = {}, root = process.cwd() } = {}) {
  const disabled = (why) => ({ mode: "disabled", why, env: {}, plugin: null });
  // Builds, previews, and vitest never mount it: a production artifact must
  // not be able to reach a development endpoint.
  if (command !== "serve" || isPreview || mode === "test" || env.VITEST) return disabled("not a dev server");
  if (env.VITE_PRESIGN_URL?.trim()) return disabled("VITE_PRESIGN_URL is set");

  const jwt = env.PINATA_JWT?.trim();
  const pinMode = jwt ? "pinata" : "offline";
  const injected = { VITE_PRESIGN_URL: PRESIGN_PATH };
  const gateway = env.VITE_IPFS_GATEWAY?.trim().replace(/\/+$/, "");
  const gatewayConfigured = Boolean(gateway) && gateway !== DEFAULT_GATEWAY;
  if (pinMode === "offline" && !gatewayConfigured) injected.VITE_IPFS_GATEWAY = DEV_GATEWAY_PATH;

  const handle = pinMode === "pinata"
    ? createPinataEndpoint({ jwt, groupId: env.PINATA_GROUP_ID?.trim() })
    : createOfflineEndpoint({ store: createFilePinStore(path.resolve(root, DEV_PIN_DIR)) });

  const plugin = {
    name: "juno-voice:presign-dev",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(PRESIGN_PATH) && !url.startsWith(`${DEV_IPFS_PREFIX}/`)) return next();
        let response = null;
        try {
          response = await handle(await toWebRequest(req));
        } catch (error) {
          response = error instanceof Error && error.message === "too_large"
            ? json(413, { error: "The request body is too large." })
            : json(500, { error: "The development presign endpoint failed." });
        }
        if (!response) return next();
        await sendWebResponse(res, response);
      });
      const logger = server.config.logger;
      if (pinMode === "pinata") {
        logger.info(`  presign  ${PRESIGN_PATH} -> Pinata (PINATA_JWT found). Pins are public and permanent.`);
      } else {
        logger.warn(`  presign  ${PRESIGN_PATH} -> local pin store (${DEV_PIN_DIR}). Documents are NOT on the public IPFS network; do not reference them in mainnet transactions. Set PINATA_JWT in .env.local to pin for real.`);
        if (gatewayConfigured) logger.warn(`  presign  VITE_IPFS_GATEWAY is set, so locally pinned documents will not resolve.`);
      }
    },
  };
  return { mode: pinMode, why: null, env: injected, plugin };
}
