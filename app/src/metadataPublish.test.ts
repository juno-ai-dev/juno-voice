import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateProjectDocument } from "./metadataDocuments";
import { createDocumentPublisher } from "./metadataPublish";
import type { MetadataUploader } from "./metadataUpload";

const doc = validateProjectDocument({ doc: "juno-voice/project", version: 1, name: "Alpha", summary: "A project." });
const pinned = { uri: `ipfs://bafy${"b".repeat(55)}`, digest: `sha256:${"c".repeat(64)}`, size: 10 };

describe("document publisher", () => {
  beforeEach(() => vi.stubGlobal("crypto", webcrypto));
  afterEach(() => vi.unstubAllGlobals());

  it("memoizes publishes by content digest so a re-review never double-pins", async () => {
    const uploader: MetadataUploader = { pinDocument: vi.fn(async () => pinned), pinImage: vi.fn(async () => pinned) };
    const publisher = createDocumentPublisher(uploader);
    const first = await publisher.publishDocument("project.json", doc);
    const second = await publisher.publishDocument("project.json", doc);
    expect(first).toBe(second);
    expect(uploader.pinDocument).toHaveBeenCalledTimes(1);
    const changed = validateProjectDocument({ ...doc, summary: "A changed project." });
    await publisher.publishDocument("project.json", changed);
    expect(uploader.pinDocument).toHaveBeenCalledTimes(2);
  });

  it("memoizes image publishes by file bytes", async () => {
    const uploader: MetadataUploader = { pinDocument: vi.fn(async () => pinned), pinImage: vi.fn(async () => pinned) };
    const publisher = createDocumentPublisher(uploader);
    const file = new File([new Uint8Array([1, 2, 3])], "logo.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new Uint8Array([1, 2, 3]).buffer });
    await publisher.publishImage(file);
    await publisher.publishImage(file);
    expect(uploader.pinImage).toHaveBeenCalledTimes(1);
  });
});
