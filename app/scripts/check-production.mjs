import { gzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

export const limits = Object.freeze({
  ".js": { raw: 310_000, gzip: 90_000 },
  ".css": { raw: 15_000, gzip: 5_000 },
});

export const forbiddenSigningSymbols = [
  "SigningCosmWasmClient",
  "SigningStargateClient",
  "OfflineSigner",
  "DirectSecp256k1",
  "signAndBroadcast",
  "window.keplr",
];

async function files(root, current = root) {
  const output = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) output.push(...(await files(root, path)));
    else output.push({ path, name: relative(root, path) });
  }
  return output;
}

export async function checkProduction(root = "dist") {
  const entries = await files(root);
  if (!entries.some(({ name }) => name === "index.html"))
    throw new Error(`${root}/index.html is missing; run the production build first.`);

  for (const entry of entries) {
    const policy = limits[extname(entry.name)];
    if (!policy) continue;
    const body = await readFile(entry.path);
    const raw = (await stat(entry.path)).size;
    const gzip = gzipSync(body).length;
    if (raw > policy.raw || gzip > policy.gzip)
      throw new Error(
        `${entry.name} exceeds its bundle budget: ${raw}/${policy.raw} raw bytes, ${gzip}/${policy.gzip} gzip bytes.`,
      );
    if (extname(entry.name) === ".js") {
      const text = body.toString("utf8");
      const symbol = forbiddenSigningSymbols.find((candidate) =>
        text.includes(candidate),
      );
      if (symbol)
        throw new Error(
          `${entry.name} contains forbidden wallet/signing symbol ${symbol}.`,
        );
    }
  }
  return entries.map(({ name }) => name).sort();
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const checked = await checkProduction(process.argv[2] ?? "dist");
  console.log(`Production artifact policy passed (${checked.length} files).`);
}
