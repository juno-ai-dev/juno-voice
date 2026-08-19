import { sha256Digest } from "./metadataDigest";
import { MAX_DOCUMENT_BYTES } from "./metadataDocuments";

// Write side of the metadata spec: pin canonical document bytes (and optional
// images) to IPFS through the operator's presign endpoint. The on-chain digest
// is computed over the exact byte buffer that goes into the upload form —
// never re-serialize between hashing and uploading.

export const MAX_IMAGE_BYTES = 524_288;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export interface PinnedMetadata { readonly uri: string; readonly digest: string; readonly size: number }

export type MetadataUploadCode =
  | "presign_unavailable" | "presign_rejected" | "upload_rejected"
  | "too_large" | "unsupported_type" | "malformed_response";

export class MetadataUploadError extends Error {
  readonly code: MetadataUploadCode;
  constructor(message: string, code: MetadataUploadCode) { super(message); this.code = code; }
}

export interface MetadataUploader {
  pinDocument(filename: string, bytes: Uint8Array): Promise<PinnedMetadata>;
  pinImage(file: File): Promise<PinnedMetadata>;
}

const CID_PATTERN = /^baf[a-z2-7]{50,}$/;

export function createMetadataUploader(presignUrl: string, fetcher?: typeof fetch): MetadataUploader {
  const request = fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  const presign = async (kind: "document" | "image", filename: string, size: number, contentType: string): Promise<string> => {
    let response: Response;
    try {
      response = await request(presignUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, filename, size, content_type: contentType }),
      });
    } catch {
      throw new MetadataUploadError("The publishing service is unreachable. You can still link a file you published yourself.", "presign_unavailable");
    }
    if (!response.ok) throw new MetadataUploadError(`The publishing service declined the request (status ${response.status}).`, "presign_rejected");
    const payload: unknown = await response.json().catch(() => null);
    const url = (payload as { url?: unknown } | null)?.url;
    if (typeof url !== "string" || !url.startsWith("https://"))
      throw new MetadataUploadError("The publishing service returned an unexpected response.", "malformed_response");
    return url;
  };

  const upload = async (url: string, bytes: Uint8Array, filename: string, contentType: string): Promise<string> => {
    const form = new FormData();
    form.append("network", "public");
    form.append("file", new File([bytes.slice()], filename, { type: contentType }));
    let response: Response;
    try {
      response = await request(url, { method: "POST", body: form });
    } catch {
      throw new MetadataUploadError("Publishing failed while uploading the file. Nothing was signed.", "upload_rejected");
    }
    if (!response.ok) throw new MetadataUploadError(`The pinning service refused the upload (status ${response.status}).`, "upload_rejected");
    const payload: unknown = await response.json().catch(() => null);
    const cid = (payload as { data?: { cid?: unknown } } | null)?.data?.cid;
    if (typeof cid !== "string" || !CID_PATTERN.test(cid))
      throw new MetadataUploadError("The pinning service returned an unexpected file identifier.", "malformed_response");
    return cid;
  };

  return {
    async pinDocument(filename, bytes) {
      if (bytes.length > MAX_DOCUMENT_BYTES)
        throw new MetadataUploadError(`The document is ${bytes.length} bytes; the publishing limit is ${MAX_DOCUMENT_BYTES} bytes.`, "too_large");
      const digest = await sha256Digest(bytes);
      const url = await presign("document", filename, bytes.length, "application/json");
      const cid = await upload(url, bytes, filename, "application/json");
      return { uri: `ipfs://${cid}`, digest, size: bytes.length };
    },
    async pinImage(file) {
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type))
        throw new MetadataUploadError("Images must be PNG, JPEG, or WebP.", "unsupported_type");
      if (file.size > MAX_IMAGE_BYTES)
        throw new MetadataUploadError(`Images may be at most ${MAX_IMAGE_BYTES} bytes.`, "too_large");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length > MAX_IMAGE_BYTES)
        throw new MetadataUploadError(`Images may be at most ${MAX_IMAGE_BYTES} bytes.`, "too_large");
      const digest = await sha256Digest(bytes);
      const url = await presign("image", file.name, bytes.length, file.type);
      const cid = await upload(url, bytes, file.name, file.type);
      return { uri: `ipfs://${cid}`, digest, size: bytes.length };
    },
  };
}
