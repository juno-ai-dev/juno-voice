import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { BountyTransactionAccess } from "./BountyActions";
import { createBrowserTransactionAccess } from "./browserTransactions";
import { createDataSource, type VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { createRegistryDataSource, type RegistryDataSource } from "./registry";
import type { RegistryTransactionFlow } from "./registryActions";
import { createGaugeDataSource, type GaugeDataSource } from "./gauge";
import type { GaugeTransactionFlow } from "./gaugeActions";

const GaugeVoting = lazy(() =>
  import("./GaugeVoting").then((module) => ({ default: module.GaugeVoting })),
);
const LandingPage = lazy(() =>
  import("./LandingPage").then((module) => ({ default: module.LandingPage })),
);
const FAQPage = lazy(() =>
  import("./FAQPage").then((module) => ({ default: module.FAQPage })),
);
const Ledger = lazy(() =>
  import("./Ledger").then((module) => ({ default: module.Ledger })),
);
// Keep the component module name distinct from registry.ts. On case-folding
// filesystems, the old `Registry.tsx` path resolved to the data module first.
const Registry = lazy(() =>
  import("./ProjectRegistry").then((module) => ({ default: module.Registry })),
);

type TransactionAccess = BountyTransactionAccess & RegistryTransactionFlow & GaugeTransactionFlow;
type PublicView = "home" | "faq" | "bounties" | "projects" | "gauge";

const compactAddress = (address: string) => `${address.slice(0, 9)}…${address.slice(-5)}`;
const isFaqHash = () => window.location.hash === "#faq" || window.location.hash.startsWith("#faq-");

export function App({
  source: supplied,
  registrySource: suppliedRegistry,
  config,
  transactions,
  registryTransactionFlow,
  gaugeSource: suppliedGauge,
  gaugeTransactionFlow,
  walletAddress,
}: {
  source?: VoiceDataSource;
  registrySource?: RegistryDataSource;
  config: AppConfig;
  transactions?: BountyTransactionAccess;
  registryTransactionFlow?: RegistryTransactionFlow;
  gaugeSource?: GaugeDataSource;
  gaugeTransactionFlow?: GaugeTransactionFlow;
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
  const gaugeSource = useMemo(
    () => suppliedGauge ?? createGaugeDataSource(config),
    [suppliedGauge, config],
  );
  const productionTransactions = useMemo<TransactionAccess | undefined>(() => {
    if (transactions && registryTransactionFlow && gaugeTransactionFlow) return undefined;
    const browser = window as Window & { keplr?: unknown; leap?: unknown };
    const kind = browser.keplr ? "keplr" : browser.leap ? "leap" : null;
    if (!kind) return undefined;
    try {
      return createBrowserTransactionAccess(config, source, kind, registrySource, gaugeSource);
    } catch {
      return undefined;
    }
  }, [transactions, registryTransactionFlow, gaugeTransactionFlow, config, source, registrySource, gaugeSource]);
  const bountyAccess = transactions ?? productionTransactions;
  const registryAccess = registryTransactionFlow ?? productionTransactions;
  const gaugeAccess = gaugeTransactionFlow ?? productionTransactions;
  const [view, setView] = useState<PublicView>(() => isFaqHash() ? "faq" : "home");
  const [connectedAddress, setConnectedAddress] = useState<string | null>(walletAddress ?? null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const viewRegion = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (walletAddress) setConnectedAddress(walletAddress);
  }, [walletAddress]);
  useEffect(() => {
    const syncViewToLocation = () => setView((current) => isFaqHash() ? "faq" : current === "faq" ? "home" : current);
    window.addEventListener("popstate", syncViewToLocation);
    window.addEventListener("hashchange", syncViewToLocation);
    return () => {
      window.removeEventListener("popstate", syncViewToLocation);
      window.removeEventListener("hashchange", syncViewToLocation);
    };
  }, []);
  const walletConnector = productionTransactions ?? transactions ??
    (registryTransactionFlow?.connect ? registryTransactionFlow : undefined) ??
    (gaugeTransactionFlow?.connect ? gaugeTransactionFlow : undefined);
  const navigate = (next: PublicView) => {
    const pageUrl = `${window.location.pathname}${window.location.search}`;
    if (next === "faq" && !isFaqHash()) window.history.pushState(null, "", `${pageUrl}#faq`);
    if (next !== "faq" && isFaqHash()) window.history.replaceState(null, "", pageUrl);
    setView(next);
    setWalletError(null);
    window.requestAnimationFrame(() => viewRegion.current?.focus());
  };
  const connectWallet = async () => {
    if (!walletConnector?.connect || connectedAddress) return;
    setWalletBusy(true);
    setWalletError(null);
    try {
      setConnectedAddress((await walletConnector.connect()).address);
    } catch (error) {
      setWalletError(error instanceof Error ? error.message : "Wallet connection failed.");
    } finally {
      setWalletBusy(false);
    }
  };

  return (
    <div className="shell app-shell juno-grid">
      <header className="topbar app-topbar">
        <div className="topbar-inner">
          <a className="brand" href={base} onClick={(event) => { event.preventDefault(); navigate("home"); }}>
            <img src={`${base}assets/logo-salmon.svg`} alt="" />
            <img src={`${base}assets/wordmark-salmon.svg`} alt="Juno" />
            <span>VOICE</span>
          </a>
          <nav aria-label="Primary">
            <button className={view === "bounties" ? "nav-active" : ""} onClick={() => navigate("bounties")}>Bounties</button>
            <button className={view === "gauge" ? "nav-active" : ""} onClick={() => navigate("gauge")}>Gauge</button>
            <button className={view === "projects" ? "nav-active" : ""} onClick={() => navigate("projects")}>Projects</button>
          </nav>
          <div className="shell-actions">
            <span className="network-chip">JUNO MAINNET</span>
            {(walletConnector?.connect || connectedAddress) && (
              <button
                className="wallet-button"
                data-connected={Boolean(connectedAddress)}
                type="button"
                disabled={walletBusy || Boolean(connectedAddress)}
                onClick={connectWallet}
                aria-label={connectedAddress ? `Connected wallet ${connectedAddress}` : undefined}
                title={connectedAddress ?? undefined}
              >
                {connectedAddress ? compactAddress(connectedAddress) : walletBusy ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
        </div>
      </header>
      {walletError && <p className="notice danger shell-alert" role="alert">{walletError}</p>}
      <div ref={viewRegion} className="view-region" tabIndex={-1} aria-live="polite" aria-label={`${view} view`}>
      <Suspense fallback={<main className="route-loading"><p>Loading public view…</p></main>}>
      {view === "home" ? (
        <LandingPage onNavigate={navigate} />
      ) : view === "faq" ? (
        <FAQPage onNavigate={navigate} />
      ) : view === "gauge" ? (
          <GaugeVoting source={gaugeSource} config={config} transactionFlow={gaugeAccess} sender={connectedAddress ?? undefined} />
      ) : view === "projects" ? (
          <Registry source={registrySource} config={config} transactionFlow={registryAccess} sender={connectedAddress ?? undefined} />
      ) : (
          <Ledger source={source} config={config} transactions={bountyAccess} />
      )}
      </Suspense>
      </div>
      <div className="footer-wrap">
        <footer className="app-footer">
          <div className="footer-identity">
            <strong>Juno Voice</strong>
            <p>Community funding coordination, built on Juno.</p>
          </div>
          <div className="footer-network">
            <span>JUNO-1 · PUBLIC DATA</span>
            <p>Explore freely. Connect a wallet only when you are ready to act.</p>
          </div>
          <nav className="footer-links" aria-label="Footer">
            <a className="footer-link" href={`${base}#faq`} onClick={(event) => { event.preventDefault(); navigate("faq"); }}>FAQ <span aria-hidden="true">→</span></a>
            <a className="footer-link" href="https://github.com/juno-ai-dev/juno-voice">Open source · MIT <span aria-hidden="true">↗</span></a>
          </nav>
        </footer>
      </div>
    </div>
  );
}
