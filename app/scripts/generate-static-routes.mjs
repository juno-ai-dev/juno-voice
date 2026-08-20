import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import meta from "../src/routeMeta.json" with { type: "json" };

// Post-build generator: bakes per-route titles, descriptions, and OG tags into
// a static HTML file per prerendered route (dist/<route>/index.html), so
// crawlers, social unfurlers, and rewrite-free static hosts see correct
// metadata. The live SPA removes every data-static-head tag at boot and owns
// the document head from then on (src/main.tsx).

const escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function renderRouteHtml(template, route, { siteName, ogImage, base, origin }) {
  if (!/<title data-static-head>[^<]*<\/title>/.test(template) || !/<meta\s+data-static-head\s+name="description"/.test(template)) {
    throw new Error("dist/index.html is missing its data-static-head markers; refusing to inject route metadata.");
  }
  let html = template
    .replace(/<title data-static-head>[^<]*<\/title>/, `<title data-static-head>${escapeHtml(route.title)}</title>`)
    .replace(/(<meta\s+data-static-head\s+name="description"\s+content=")[^"]*(")/, `$1${escapeHtml(route.description)}$2`);
  const tags = [
    `<meta data-static-head property="og:title" content="${escapeHtml(route.title)}" />`,
    `<meta data-static-head property="og:description" content="${escapeHtml(route.description)}" />`,
    `<meta data-static-head property="og:type" content="website" />`,
    `<meta data-static-head property="og:site_name" content="${escapeHtml(siteName)}" />`,
  ];
  if (!route.index) tags.push(`<meta data-static-head name="robots" content="noindex" />`);
  if (origin) {
    const url = route.path ? `${origin}${base}${route.path}/` : `${origin}${base}`;
    tags.push(`<link data-static-head rel="canonical" href="${url}" />`);
    tags.push(`<meta data-static-head property="og:url" content="${url}" />`);
    tags.push(`<meta data-static-head property="og:image" content="${origin}${base}${ogImage}" />`);
    tags.push(`<meta data-static-head name="twitter:card" content="summary_large_image" />`);
  }
  return html.replace("</head>", `    ${tags.join("\n    ")}\n  </head>`);
}

export async function generateStaticRoutes(distDir, env = process.env) {
  const base = env.VITE_BASE_PATH?.trim() || "/";
  if (base !== "/" && !/^\/[A-Za-z0-9._/-]+\/$/.test(base)) {
    throw new Error(`Invalid VITE_BASE_PATH "${base}". Generation failed closed.`);
  }
  const origin = env.VITE_CANONICAL_ORIGIN?.trim() || null;
  if (origin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/.test(origin)) {
    throw new Error(`Invalid VITE_CANONICAL_ORIGIN "${origin}". Generation failed closed.`);
  }
  const template = await readFile(join(distDir, "index.html"), "utf8");
  const prerendered = meta.routes.filter((route) => route.prerender);
  for (const route of prerendered) {
    const html = renderRouteHtml(template, route, { siteName: meta.siteName, ogImage: meta.ogImage, base, origin });
    if (route.path === "") {
      await writeFile(join(distDir, "index.html"), html);
    } else {
      const directory = join(distDir, ...route.path.split("/"));
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "index.html"), html);
    }
  }
  if (origin) {
    await writeFile(join(distDir, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${origin}${base}sitemap.xml\n`);
    const urls = prerendered.filter((route) => route.index)
      .map((route) => `  <url><loc>${route.path ? `${origin}${base}${route.path}/` : `${origin}${base}`}</loc></url>`);
    await writeFile(join(distDir, "sitemap.xml"),
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`);
  }
  return { routes: prerendered.length, canonical: Boolean(origin) };
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  const result = await generateStaticRoutes(process.argv[2] ?? "dist");
  console.log(`Baked route metadata for ${result.routes} routes${result.canonical ? " with canonical origin artifacts" : " (no canonical origin configured; robots.txt and sitemap.xml skipped)"}.`);
}
