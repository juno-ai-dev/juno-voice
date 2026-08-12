export function normalizeBase(value = "/") {
  if (
    value !== "/" &&
    (!/^\/[A-Za-z0-9._/-]+\/$/.test(value) || value.includes("//"))
  )
    throw new Error("VITE_BASE_PATH must be an absolute path ending in one slash.");
  return value;
}
