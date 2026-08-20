import { metaForRoute } from "../routeMeta";

// React 19 hoists <title> and <meta> into <head>. The baked static tags carry
// data-static-head and are removed once at boot (main.tsx), so these runtime
// tags own the live document.
export function PageMeta({ route, titleOverride }: { route: string; titleOverride?: string }) {
  const meta = metaForRoute(route);
  return <>
    <title>{titleOverride ?? meta.title}</title>
    <meta name="description" content={meta.description} />
    {!meta.index && <meta name="robots" content="noindex" />}
  </>;
}
