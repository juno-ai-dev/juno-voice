import { sha256Digest } from "./metadataDigest";
import { MetadataDocumentError, parseMetadataDocument, type MetadataDocKind, type MetadataDocument } from "./metadataDocuments";

// Read side of the metadata spec (docs/METADATA_DOCUMENTS.md): fetch document
// bytes through the configured IPFS gateway, hash the exact bytes against the
// on-chain digest, and only parse content that verifies. Content whose bytes
// do not match the committed fingerprint is never rendered.

export type VerifiedMetadata =
  | { state: "verified"; doc: MetadataDocument }
  | { state: "mismatch" }
  | { state: "invalid"; message: string }
  | { state: "unfetchable"; message: string }
  | { state: "unsupported" };

export interface MetadataClient {
  load(uri: string, digest: string, expected: MetadataDocKind): Promise<VerifiedMetadata>;
}

export const METADATA_FETCH_MAX_BYTES = 65_536;
const STORAGE_PREFIX = "juno-voice:metadata:v1:";

// Rewrites ipfs://<cid>[/path…] onto the gateway, encoding each path segment
// separately so path-carrying references stay valid URLs.
export function ipfsGatewayUrl(gatewayBase: string, uri: string): string | null {
  if (!uri.startsWith("ipfs://")) return null;
  const segments = uri.slice("ipfs://".length).split("/");
  if (!/^[a-zA-Z0-9]+$/.test(segments[0] ?? "")) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  try {
    const relativeGateway = gatewayBase.startsWith("/") && !gatewayBase.startsWith("//");
    const relativeOrigin = "https://juno-voice.invalid";
    const configured = relativeGateway ? new URL(gatewayBase, relativeOrigin) : new URL(gatewayBase);
    if (configured.search || configured.hash) return null;
    const prefix = new URL(configured.href);
    prefix.pathname = `${prefix.pathname.replace(/\/+$/, "")}/`;
    const target = new URL(prefix.href);
    target.pathname = `${prefix.pathname}${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
    if (target.origin !== prefix.origin || !target.pathname.startsWith(prefix.pathname)) return null;
    return relativeGateway ? target.pathname : target.href;
  } catch {
    return null;
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`The linked file exceeds the ${maxBytes}-byte reader limit.`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`The linked file exceeds the ${maxBytes}-byte reader limit.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function readStoredBytes(digest: string): Uint8Array | null {
  try {
    const stored = sessionStorage.getItem(`${STORAGE_PREFIX}${digest}`);
    return stored === null ? null : new TextEncoder().encode(stored);
  } catch {
    return null;
  }
}

function storeVerifiedBytes(digest: string, bytes: Uint8Array) {
  try {
    sessionStorage.setItem(`${STORAGE_PREFIX}${digest}`, new TextDecoder().decode(bytes));
  } catch {
    // Best-effort cache only; quota or storage failures never block rendering.
  }
}

export function createMetadataClient(options: {
  gatewayBase: string;
  fetcher?: typeof fetch;
  maxBytes?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
}): MetadataClient {
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const maxBytes = options.maxBytes ?? METADATA_FETCH_MAX_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 4;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cache = new Map<string, Promise<VerifiedMetadata>>();

  let active = 0;
  const queue: Array<() => void> = [];
  const acquire = () => new Promise<void>((resolve) => {
    if (active < maxConcurrent) { active += 1; resolve(); }
    else queue.push(() => { active += 1; resolve(); });
  });
  const release = () => { active -= 1; queue.shift()?.(); };

  const verify = async (bytes: Uint8Array, digest: string, expected: MetadataDocKind): Promise<VerifiedMetadata> => {
    if (await sha256Digest(bytes) !== digest) return { state: "mismatch" };
    try {
      const doc = parseMetadataDocument(bytes, expected);
      storeVerifiedBytes(digest, bytes);
      return { state: "verified", doc };
    } catch (cause) {
      return { state: "invalid", message: cause instanceof MetadataDocumentError ? cause.message : "The linked file is not a recognized document." };
    }
  };

  const loadFresh = async (uri: string, digest: string, expected: MetadataDocKind): Promise<VerifiedMetadata> => {
    // A stored copy is only trusted after re-hashing, so poisoned or stale
    // storage self-heals into a network fetch.
    const stored = readStoredBytes(digest);
    if (stored && await sha256Digest(stored) === digest) return verify(stored, digest, expected);
    const url = ipfsGatewayUrl(options.gatewayBase, uri);
    if (!url) return { state: "unsupported" };
    await acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!response.ok) return { state: "unfetchable", message: `The gateway responded with status ${response.status}.` };
      return await verify(await readCapped(response, maxBytes), digest, expected);
    } catch (cause) {
      return { state: "unfetchable", message: cause instanceof Error ? cause.message : "The linked file could not be fetched." };
    } finally {
      clearTimeout(timer);
      release();
    }
  };

  return {
    load(uri, digest, expected) {
      const key = `${expected}\n${digest}\n${uri}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const promise = loadFresh(uri, digest, expected).then((result) => {
        // Unfetchable is transient; drop it from the cache so a later render
        // can retry. Terminal verdicts stay cached for the session.
        if (result.state === "unfetchable") cache.delete(key);
        return result;
      });
      cache.set(key, promise);
      return promise;
    },
  };
}
