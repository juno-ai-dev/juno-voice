import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateStaticRoutes, renderRouteHtml } from "./generate-static-routes.mjs";

const template = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta data-static-head name="description" content="Default description." />
    <title data-static-head>Default title</title>
    <link rel="icon" href="/assets/logo-salmon.svg" />
  </head>
  <body><div id="root"></div></body>
</html>`;

const makeDist = async () => {
  const dist = await mkdtemp(join(tmpdir(), "static-routes-"));
  await writeFile(join(dist, "index.html"), template);
  return dist;
};

test("renderRouteHtml replaces marked tags and appends OG metadata", () => {
  const html = renderRouteHtml(template, { path: "bounties", title: "Bounties & more", description: 'Say "hi"', prerender: true, index: true },
    { siteName: "Juno Voice", ogImage: "assets/og-card.png", base: "/juno-voice/", origin: null });
  assert.match(html, /<title data-static-head>Bounties &amp; more<\/title>/);
  assert.match(html, /name="description" content="Say &quot;hi&quot;"/);
  assert.match(html, /property="og:title" content="Bounties &amp; more"/);
  assert.ok(!html.includes("rel=\"canonical\""));
  assert.ok(!html.includes("robots"));
});

test("noindex routes gain a robots tag and markers are required", () => {
  const html = renderRouteHtml(template, { path: "bounties/create", title: "Create", description: "D", prerender: true, index: false },
    { siteName: "Juno Voice", ogImage: "assets/og-card.png", base: "/", origin: null });
  assert.match(html, /name="robots" content="noindex"/);
  assert.throws(() => renderRouteHtml("<html><head></head></html>", { path: "", title: "T", description: "D", index: true },
    { siteName: "s", ogImage: "o", base: "/", origin: null }), /data-static-head markers/);
});

test("generates per-route files; canonical artifacts only with an origin", async () => {
  const dist = await makeDist();
  const summary = await generateStaticRoutes(dist, { VITE_BASE_PATH: "/juno-voice/" });
  assert.ok(summary.routes >= 8);
  assert.equal(summary.canonical, false);
  const bounties = await readFile(join(dist, "bounties", "index.html"), "utf8");
  assert.match(bounties, /<title data-static-head>Public bounty ledger · Juno Voice<\/title>/);
  const create = await readFile(join(dist, "bounties", "create", "index.html"), "utf8");
  assert.match(create, /noindex/);
  const root = await readFile(join(dist, "index.html"), "utf8");
  assert.match(root, /Community funding on Juno/);
  await assert.rejects(readFile(join(dist, "robots.txt")), /ENOENT/);

  const withOrigin = await makeDist();
  await generateStaticRoutes(withOrigin, { VITE_BASE_PATH: "/juno-voice/", VITE_CANONICAL_ORIGIN: "https://voice.example" });
  const robots = await readFile(join(withOrigin, "robots.txt"), "utf8");
  assert.match(robots, /Sitemap: https:\/\/voice\.example\/juno-voice\/sitemap\.xml/);
  const sitemap = await readFile(join(withOrigin, "sitemap.xml"), "utf8");
  assert.match(sitemap, /<loc>https:\/\/voice\.example\/juno-voice\/bounties\/<\/loc>/);
  assert.ok(!sitemap.includes("bounties/create"));
  const canonical = await readFile(join(withOrigin, "faq", "index.html"), "utf8");
  assert.match(canonical, /rel="canonical" href="https:\/\/voice\.example\/juno-voice\/faq\/"/);
  assert.match(canonical, /og:image" content="https:\/\/voice\.example\/juno-voice\/assets\/og-card\.png"/);
});

test("fails closed on malformed base path or canonical origin", async () => {
  const dist = await makeDist();
  await assert.rejects(generateStaticRoutes(dist, { VITE_BASE_PATH: "juno-voice/" }), /Invalid VITE_BASE_PATH/);
  await assert.rejects(generateStaticRoutes(dist, { VITE_CANONICAL_ORIGIN: "http://voice.example" }), /Invalid VITE_CANONICAL_ORIGIN/);
});
