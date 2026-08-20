export const METADATA_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const URI_SCHEME_PATTERN = /^(https:\/\/|ipfs:\/\/)[^\s]+$/;
export const MAX_HASH_FILE_BYTES = 20 * 1024 * 1024;

export async function sha256Digest(data: BufferSource): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure browser hashing is unavailable. Enter a SHA-256 digest from a trusted tool.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function digestMetadataFile(file: File): Promise<string> {
  if (file.size > MAX_HASH_FILE_BYTES) {
    throw new Error("Choose a file no larger than 20 MB, or paste its digest instead.");
  }
  return sha256Digest(await file.arrayBuffer());
}
