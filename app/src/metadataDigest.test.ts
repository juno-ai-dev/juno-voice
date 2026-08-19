import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digestMetadataFile, MAX_HASH_FILE_BYTES, METADATA_DIGEST_PATTERN, sha256Digest, URI_SCHEME_PATTERN } from "./metadataDigest";

describe("metadata digests", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("hashes bytes to the canonical sha256:<hex> form", async () => {
    vi.stubGlobal("crypto", webcrypto);
    await expect(sha256Digest(new TextEncoder().encode("abc"))).resolves.toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("fails closed when secure hashing is unavailable", async () => {
    vi.stubGlobal("crypto", {});
    await expect(sha256Digest(new Uint8Array(1))).rejects.toThrow("Secure browser hashing is unavailable");
  });
  it("refuses files over the 20 MB hashing cap without reading them", async () => {
    const arrayBuffer = vi.fn();
    const file = { size: MAX_HASH_FILE_BYTES + 1, arrayBuffer } as unknown as File;
    await expect(digestMetadataFile(file)).rejects.toThrow("no larger than 20 MB");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
  it("pins the shared digest and URI scheme patterns", () => {
    expect(METADATA_DIGEST_PATTERN.test(`sha256:${"a".repeat(64)}`)).toBe(true);
    expect(METADATA_DIGEST_PATTERN.test(`sha256:${"A".repeat(64)}`)).toBe(false);
    expect(METADATA_DIGEST_PATTERN.test(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(URI_SCHEME_PATTERN.test("ipfs://bafybeigdyrzt5example")).toBe(true);
    expect(URI_SCHEME_PATTERN.test("https://example.com/metadata.json")).toBe(true);
    expect(URI_SCHEME_PATTERN.test("javascript:alert(1)")).toBe(false);
    expect(URI_SCHEME_PATTERN.test("ipfs://")).toBe(false);
    expect(URI_SCHEME_PATTERN.test("ipfs://with space")).toBe(false);
  });
});
