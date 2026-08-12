import { Suspense, lazy, useMemo, useState } from "react";
import type { BountyTransactionAccess } from "./BountyActions";
import { createBrowserTransactionAccess } from "./browserTransactions";
import { createDataSource, type VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { Ledger } from "./Ledger";
import { createRegistryDataSource, type RegistryDataSource } from "./registry";
import type { RegistryTransactionFlow } from "./registryActions";

const Registry = lazy(() =>
  import("./Registry").then((module) => ({ default: module.Registry })),
);

type TransactionAccess = BountyTransactionAccess & RegistryTransactionFlow;

export function App({
  source: supplied,
  registrySource: suppliedRegistry,
  config,
  transactions,
  registryTransactionFlow,
  walletAddress,
}: {
  source?: VoiceDataSource;
  registrySource?: RegistryDataSource;
  config: AppConfig;
  transactions?: BountyTransactionAccess;
  registryTransactionFlow?: RegistryTransactionFlow;
  walletAddress?: string;
}) {
  const base = import.meta.env.BASE_URL;
  const source = useMemo(
    () => supplied ?? createDataSource(config),
    [supplied, config],
  );
  const registrySource = useMemo(
    () => suppliedRegistry ?? createRegistryDataSource(config),
    [suppliedRegistry, config],
  );
  const productionTransactions = useMemo<TransactionAccess | undefined>(() => {
    if (transactions && registryTransactionFlow) return undefined;
    const browser = window as Window & { keplr?: unknown; leap?: unknown };
    const kind = browser.keplr ? "keplr" : browser.leap ? "leap" : null;
    if (!kind) return undefined;
    try {
      return createBrowserTransactionAccess(config, source, kind, registrySource);
    } catch {
      return undefined;
    }
  }, [transactions, registryTransactionFlow, config, source, registrySource]);
  const bountyAccess = transactions ?? productionTransactions;
  const registryAccess = registryTransactionFlow ?? productionTransactions;
  const [view, setView] = useState<"bounties" | "projects">("bounties");

  return (
    <div className="shell juno-grid">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={base}>
            <img src={`${base}assets/logo-salmon.svg`} alt="" />
            <img src={`${base}assets/wordmark-salmon.svg`} alt="Juno" />
            <span>VOICE</span>
          </a>
          <nav aria-label="Primary">
            <button className={view === "projects" ? "nav-active" : ""} onClick={() => setView("projects")}>Projects</button>
            <button className={view === "bounties" ? "nav-active" : ""} onClick={() => setView("bounties")}>Bounties</button>
          </nav>
          <span className="mainnet">JUNO-1 · PUBLIC LEDGER</span>
        </div>
      </header>
      {view === "projects" ? (
        <Suspense fallback={<main><p>Loading project registry…</p></main>}>
          <Registry source={registrySource} config={config} transactionFlow={registryAccess} sender={walletAddress} />
        </Suspense>
      ) : (
        <Ledger source={source} config={config} transactions={bountyAccess} />
      )}
      <footer>
        <p>Public mainnet observation · Read-only access never requires a wallet · Supported wallet actions use exact review before signing</p>
        <p>Juno Design System{" "}<a href="https://github.com/juno-ai-dev/juno-design-system/commit/0dc0ae9ae80e0378b61fc9f67cbf417f291d6f16">0dc0ae9</a>{" "}· MIT</p>
      </footer>
    </div>
  );
}
