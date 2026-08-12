export async function digestMetadataFile(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure browser hashing is unavailable. Enter a SHA-256 digest from a trusted tool.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
