import { Suspense, lazy, useMemo, useState } from "react";
import { createDataSource, type VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { Ledger } from "./Ledger";
import { createRegistryDataSource, type RegistryDataSource } from "./registry";
const Registry = lazy(() => import("./Registry").then((module) => ({ default: module.Registry })));
export function App({ source: supplied, registrySource: suppliedRegistry, config }: { source?: VoiceDataSource; registrySource?: RegistryDataSource; config: AppConfig }) {
  const base = import.meta.env.BASE_URL;
  const source = useMemo(() => supplied ?? createDataSource(config), [supplied, config]);
  const registrySource = useMemo(() => suppliedRegistry ?? createRegistryDataSource(config), [suppliedRegistry, config]);
  const [view, setView] = useState<"bounties" | "projects">("bounties");
  return <div className="shell juno-grid">
    <header className="topbar"><div className="topbar-inner"><a className="brand" href={base}><img src={`${base}assets/logo-salmon.svg`} alt="" /><img src={`${base}assets/wordmark-salmon.svg`} alt="Juno" /><span>VOICE</span></a><nav aria-label="Primary"><button className={view === "projects" ? "nav-active" : ""} onClick={() => setView("projects")}>Projects</button><button className={view === "bounties" ? "nav-active" : ""} onClick={() => setView("bounties")}>Bounties</button></nav><span className="mainnet">JUNO-1 · DIRECT RPC</span></div></header>
    {view === "projects" ? <Suspense fallback={<main><p>Loading project registry…</p></main>}><Registry source={registrySource} config={config} /></Suspense> : <Ledger source={source} config={config} />}
    <footer><p>Direct mainnet observation · Unsigned review only · Nothing signed or broadcast</p><p>Juno Design System <a href="https://github.com/juno-ai-dev/juno-design-system/commit/0dc0ae9ae80e0378b61fc9f67cbf417f291d6f16">0dc0ae9</a> · MIT</p></footer>
  </div>;
}
