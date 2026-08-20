import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalDocumentBytes, validateProjectDocument } from "./metadataDocuments";
import { createMetadataClient, ipfsGatewayUrl } from "./metadataFetch";

const doc = validateProjectDocument({ doc: "juno-voice/project", version: 1, name: "Alpha Project", summary: "A test project." });
const bytes = canonicalDocumentBytes(doc);
const digestOf = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
const digest = digestOf(bytes);
const uri = "ipfs://bafyalphaproject";
const gateway = "https://ipfs-gateway.test/ipfs";

const fetcherOf = (body: Uint8Array, status = 200) => vi.fn(async () => new Response(status === 200 ? body.slice() : null, { status }));

describe("metadata read side", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); sessionStorage.clear(); });
  afterEach(() => vi.unstubAllGlobals());

  it("rewrites ipfs URIs onto the gateway, encoding path segments individually", () => {
    expect(ipfsGatewayUrl(gateway, "ipfs://bafyabc")).toBe(`${gateway}/bafyabc`);
    expect(ipfsGatewayUrl(gateway, "ipfs://bafyabc/meta data.json")).toBe(`${gateway}/bafyabc/meta%20data.json`);
    expect(ipfsGatewayUrl(`${gateway}/`, "ipfs://bafyabc")).toBe(`${gateway}/bafyabc`);
    expect(ipfsGatewayUrl(gateway, "ipfs://")).toBeNull();
    expect(ipfsGatewayUrl(gateway, "ipfs://../evil")).toBeNull();
    expect(ipfsGatewayUrl(gateway, "https://example.com/x")).toBeNull();
  });

  it("rejects dot path segments before URL normalization can leave the gateway prefix", () => {
    expect(ipfsGatewayUrl(gateway, "ipfs://bafyabc/./metadata.json")).toBeNull();
    expect(ipfsGatewayUrl(gateway, "ipfs://bafyabc/../metadata.json")).toBeNull();
    expect(ipfsGatewayUrl(gateway, "ipfs://bafyabc/path/../../outside.json")).toBeNull();
    expect(ipfsGatewayUrl(`${gateway}/nested/../`, "ipfs://bafyabc/metadata.json"))
      .toBe(`${gateway}/bafyabc/metadata.json`);
  });

  it("verifies fetched bytes against the on-chain digest before parsing", async () => {
    const fetcher = fetcherOf(bytes);
    const client = createMetadataClient({ gatewayBase: gateway, fetcher });
    const result = await client.load(uri, digest, "juno-voice/project");
    expect(result).toEqual({ state: "verified", doc });
    expect(fetcher).toHaveBeenCalledWith(`${gateway}/bafyalphaproject`, expect.objectContaining({ headers: { accept: "application/json" } }));
  });

  it("withholds content whose bytes do not match the committed fingerprint", async () => {
    const client = createMetadataClient({ gatewayBase: gateway, fetcher: fetcherOf(bytes) });
    const result = await client.load(uri, `sha256:${"0".repeat(64)}`, "juno-voice/project");
    expect(result).toEqual({ state: "mismatch" });
  });

  it("reports digest-matching but unrecognized documents as invalid", async () => {
    const junk = new TextEncoder().encode('{"doc":"something-else"}');
    const client = createMetadataClient({ gatewayBase: gateway, fetcher: fetcherOf(junk) });
    const result = await client.load(uri, digestOf(junk), "juno-voice/project");
    expect(result.state).toBe("invalid");
  });

  it("never fetches https or unknown-scheme references inline", async () => {
    const fetcher = fetcherOf(bytes);
    const client = createMetadataClient({ gatewayBase: gateway, fetcher });
    expect(await client.load("https://example.com/meta.json", digest, "juno-voice/project")).toEqual({ state: "unsupported" });
    expect(await client.load("javascript:alert(1)", digest, "juno-voice/project")).toEqual({ state: "unsupported" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("aborts oversized responses and allows retry after transient failures", async () => {
    const big = new Uint8Array(70_000);
    const client = createMetadataClient({ gatewayBase: gateway, fetcher: fetcherOf(big) });
    const oversize = await client.load(uri, digest, "juno-voice/project");
    expect(oversize.state).toBe("unfetchable");

    const failing = vi.fn(async () => { throw new Error("network down"); });
    const retryClient = createMetadataClient({ gatewayBase: gateway, fetcher: failing });
    expect((await retryClient.load(uri, digest, "juno-voice/project")).state).toBe("unfetchable");
    expect((await retryClient.load(uri, digest, "juno-voice/project")).state).toBe("unfetchable");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("caches terminal verdicts for the session", async () => {
    const fetcher = fetcherOf(bytes);
    const client = createMetadataClient({ gatewayBase: gateway, fetcher });
    await client.load(uri, digest, "juno-voice/project");
    await client.load(uri, digest, "juno-voice/project");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("restores verified bytes from sessionStorage and re-hashes them first", async () => {
    const first = createMetadataClient({ gatewayBase: gateway, fetcher: fetcherOf(bytes) });
    await first.load(uri, digest, "juno-voice/project");

    const offline = vi.fn(async () => { throw new Error("offline"); });
    const second = createMetadataClient({ gatewayBase: gateway, fetcher: offline });
    expect(await second.load(uri, digest, "juno-voice/project")).toEqual({ state: "verified", doc });
    expect(offline).not.toHaveBeenCalled();

    // Poisoned storage self-heals into a network fetch.
    sessionStorage.setItem(`juno-voice:metadata:v1:${digest}`, "tampered");
    const third = createMetadataClient({ gatewayBase: gateway, fetcher: fetcherOf(bytes) });
    expect(await third.load(uri, digest, "juno-voice/project")).toEqual({ state: "verified", doc });
  });

  it("caps concurrent gateway fetches", async () => {
    let active = 0, peak = 0;
    const fetcher = vi.fn(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return new Response(bytes.slice());
    });
    const client = createMetadataClient({ gatewayBase: gateway, fetcher, maxConcurrent: 2 });
    await Promise.all(Array.from({ length: 6 }, (_, index) => client.load(`ipfs://bafy${index}`, digest, "juno-voice/project")));
    expect(peak).toBeLessThanOrEqual(2);
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});
