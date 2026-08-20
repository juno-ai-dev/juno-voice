import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalDocumentBytes, MAX_DOCUMENT_BYTES, validateProjectDocument } from "./metadataDocuments";
import { createMetadataUploader, MAX_IMAGE_BYTES, MetadataUploadError } from "./metadataUpload";

const presignUrl = "https://presign.test/sign";
const cid = `bafy${"b".repeat(55)}`;
const bytes = canonicalDocumentBytes(validateProjectDocument({ doc: "juno-voice/project", version: 1, name: "Alpha", summary: "A project." }));
const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const happyFetcher = () => vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
  void init;
  if (String(url) === presignUrl) return new Response(JSON.stringify({ url: "https://uploads.pinata.cloud/v3/files/signed-token" }), { status: 200 });
  return new Response(JSON.stringify({ data: { cid } }), { status: 200 });
});

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; }
  catch (error) { return (error as MetadataUploadError).code; }
};

describe("metadata upload pipeline", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it("pins document bytes and computes the digest over the exact uploaded buffer", async () => {
    const fetcher = happyFetcher();
    const uploader = createMetadataUploader(presignUrl, fetcher as unknown as typeof fetch);
    const pinned = await uploader.pinDocument("project.json", bytes);
    expect(pinned).toEqual({ uri: `ipfs://${cid}`, digest: expectedDigest, size: bytes.length });
    const [presignCall, uploadCall] = fetcher.mock.calls;
    expect(JSON.parse((presignCall[1] as RequestInit | undefined)?.body as string)).toEqual({
      kind: "document", filename: "project.json", size: bytes.length, content_type: "application/json",
    });
    expect(String(uploadCall[0])).toBe("https://uploads.pinata.cloud/v3/files/signed-token");
    const form = (uploadCall[1] as RequestInit | undefined)?.body as FormData;
    expect(form.get("network")).toBe("public");
    const file = form.get("file") as File;
    expect(file.name).toBe("project.json");
    expect(file.size).toBe(bytes.length);
    expect(file.type).toBe("application/json");
  });

  it("pins images with type and size caps enforced before any request", async () => {
    const fetcher = happyFetcher();
    const uploader = createMetadataUploader(presignUrl, fetcher as unknown as typeof fetch);
    const image = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    Object.defineProperty(image, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
    const pinned = await uploader.pinImage(image);
    expect(pinned.uri).toBe(`ipfs://${cid}`);

    const wrongType = new File([""], "note.txt", { type: "text/plain" });
    expect(await codeOf(uploader.pinImage(wrongType))).toBe("unsupported_type");
    const huge = new File([""], "big.png", { type: "image/png" });
    Object.defineProperty(huge, "size", { value: MAX_IMAGE_BYTES + 1 });
    expect(await codeOf(uploader.pinImage(huge))).toBe("too_large");
  });

  it("refuses oversized documents without contacting the publishing service", async () => {
    const fetcher = vi.fn();
    const uploader = createMetadataUploader(presignUrl, fetcher as unknown as typeof fetch);
    expect(await codeOf(uploader.pinDocument("big.json", new Uint8Array(MAX_DOCUMENT_BYTES + 1)))).toBe("too_large");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uploads to a same-origin signed URL but never to a protocol-relative one", async () => {
    const local = "/api/presign/sign";
    const fetcher = vi.fn(async (url: RequestInfo | URL) =>
      String(url) === local
        ? new Response(JSON.stringify({ url: "/api/dev-ipfs/upload?token=abc" }), { status: 200 })
        : new Response(JSON.stringify({ data: { cid } }), { status: 200 }));
    const uploader = createMetadataUploader(local, fetcher as unknown as typeof fetch);
    expect((await uploader.pinDocument("project.json", bytes)).uri).toBe(`ipfs://${cid}`);
    expect(String(fetcher.mock.calls[1][0])).toBe("/api/dev-ipfs/upload?token=abc");

    const offOrigin = createMetadataUploader(presignUrl, vi.fn(async () =>
      new Response(JSON.stringify({ url: "//uploads.evil.example/x" }), { status: 200 })) as unknown as typeof fetch);
    expect(await codeOf(offOrigin.pinDocument("a.json", bytes))).toBe("malformed_response");
  });

  it("maps presign and upload failures to a typed, honest error taxonomy", async () => {
    const down = createMetadataUploader(presignUrl, vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    expect(await codeOf(down.pinDocument("a.json", bytes))).toBe("presign_unavailable");

    const declined = createMetadataUploader(presignUrl, vi.fn(async () => new Response("{}", { status: 403 })) as unknown as typeof fetch);
    expect(await codeOf(declined.pinDocument("a.json", bytes))).toBe("presign_rejected");

    const malformedPresign = createMetadataUploader(presignUrl, vi.fn(async () => new Response(JSON.stringify({ url: "http://insecure" }), { status: 200 })) as unknown as typeof fetch);
    expect(await codeOf(malformedPresign.pinDocument("a.json", bytes))).toBe("malformed_response");

    const uploadFails = createMetadataUploader(presignUrl, vi.fn(async (url: RequestInfo | URL) =>
      String(url) === presignUrl
        ? new Response(JSON.stringify({ url: "https://uploads.pinata.cloud/x" }), { status: 200 })
        : new Response("{}", { status: 500 })) as unknown as typeof fetch);
    expect(await codeOf(uploadFails.pinDocument("a.json", bytes))).toBe("upload_rejected");

    const badCid = createMetadataUploader(presignUrl, vi.fn(async (url: RequestInfo | URL) =>
      String(url) === presignUrl
        ? new Response(JSON.stringify({ url: "https://uploads.pinata.cloud/x" }), { status: 200 })
        : new Response(JSON.stringify({ data: { cid: "not-a-cid" } }), { status: 200 })) as unknown as typeof fetch);
    expect(await codeOf(badCid.pinDocument("a.json", bytes))).toBe("malformed_response");
  });
});
