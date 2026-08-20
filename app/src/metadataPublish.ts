import { sha256Digest } from "./metadataDigest";
import { canonicalDocumentBytes, type MetadataDocument } from "./metadataDocuments";
import type { MetadataUploader, PinnedMetadata } from "./metadataUpload";

export interface DocumentPublisher {
  publishDocument(filename: string, doc: MetadataDocument): Promise<PinnedMetadata>;
  publishImage(file: File): Promise<PinnedMetadata>;
}

// Re-opening a cancelled review must not pin a duplicate: publishes are
// memoized by content digest for the life of the page.
export function createDocumentPublisher(uploader: MetadataUploader): DocumentPublisher {
  const published = new Map<string, PinnedMetadata>();
  const memoized = async (bytesDigest: string, pin: () => Promise<PinnedMetadata>) => {
    const cached = published.get(bytesDigest);
    if (cached) return cached;
    const pinned = await pin();
    published.set(bytesDigest, pinned);
    return pinned;
  };
  return {
    async publishDocument(filename, doc) {
      const bytes = canonicalDocumentBytes(doc);
      return memoized(await sha256Digest(bytes), () => uploader.pinDocument(filename, bytes));
    },
    async publishImage(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return memoized(await sha256Digest(bytes), () => uploader.pinImage(file));
    },
  };
}
