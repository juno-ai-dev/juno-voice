import meta from "./routeMeta.json";

// Single source of truth for per-route page metadata. Consumed at runtime by
// PageMeta (React 19 head tags) and at build time by
// scripts/generate-static-routes.mjs, which bakes the same values into a
// static HTML file per route for crawlers, unfurlers, and rewrite-free hosts.

export interface RouteMeta {
  path: string;
  title: string;
  description: string;
  prerender: boolean;
  index: boolean;
}

export const SITE_NAME: string = meta.siteName;
export const routeMetaList: readonly RouteMeta[] = meta.routes;

export function metaForRoute(path: string): RouteMeta {
  const route = meta.routes.find((entry) => entry.path === path);
  if (!route) throw new Error(`No route metadata is defined for "${path}".`);
  return route;
}
