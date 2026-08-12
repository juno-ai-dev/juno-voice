import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkProduction, limits } from "./check-production.mjs";

async function artifact(js = "console.log('read only')") {
  const root = await mkdtemp(join(tmpdir(), "juno-voice-build-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<main></main>");
  await writeFile(join(root, "assets", "app.js"), js);
  await writeFile(join(root, "assets", "app.css"), "body{}", "utf8");
  return root;
}

test("accepts an application artifact within explicit budgets", async () => {
  const root = await artifact();
  assert.deepEqual(await checkProduction(root), [
    "assets/app.css",
    "assets/app.js",
    "index.html",
  ]);
});


test("rejects an oversized bundle", async () => {
  const root = await artifact();
  await writeFile(
    join(root, "assets", "app.js"),
    Buffer.alloc(limits[".js"].raw + 1, 120),
  );
  await assert.rejects(checkProduction(root), /exceeds its bundle budget/);
});
