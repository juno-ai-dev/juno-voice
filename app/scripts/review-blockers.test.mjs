import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("full-tree and production dependency audits are enforced locally and in CI", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const workflow = await read("../.github/workflows/frontend.yml");

  assert.equal(packageJson.scripts["audit:all"], "npm audit --audit-level=high");
  assert.match(packageJson.scripts.verify, /npm run audit:all/);
  assert.match(packageJson.scripts.verify, /npm run audit:production/);
  assert.match(workflow, /Full dependency tree audit[\s\S]*npm run audit:all/);
  assert.match(workflow, /Production dependency audit[\s\S]*npm run audit:production/);
});

test("browser smoke builds and exercises the deployable Pages artifact", async () => {
  const config = await read("playwright.config.ts");
  const spec = await read("e2e/production.spec.ts");

  assert.match(config, /VITE_BASE_PATH:\s*"\/juno-voice\/"/);
  assert.doesNotMatch(config, /VITE_RELEASE_COMMIT:\s*"a{40}"/);
  assert.match(config, /rev-parse/);
  assert.match(config, /url:\s*"http:\/\/127\.0\.0\.1:4173\/juno-voice\/"/);
  assert.match(spec, /page\.goto\(projectPath\)/);
  assert.match(spec, /page\.reload\(\)/);
  assert.match(spec, /resourceType\(\)/);
  assert.match(spec, /\["script", "stylesheet", "image"\]/);
});
