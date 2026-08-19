import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, NavLink, Route, Routes, useLocation } from "react-router";
import type { BountyTransactionAccess } from "./BountyActions";
import { createBrowserTransactionAccess } from "./browserTransactions";
import { createDataSource, type VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { createRegistryDataSource, type RegistryDataSource } from "./registry";
import type { RegistryTransactionFlow } from "./registryActions";
import { createGaugeDataSource, type GaugeDataSource } from "./gauge";
import type { GaugeTransactionFlow } from "./gaugeActions";
import { createMetadataClient, type MetadataClient } from "./metadataFetch";
import { createMetadataUploader } from "./metadataUpload";
import { createDocumentPublisher, type DocumentPublisher } from "./metadataPublish";
import { NotFound } from "./routes/NotFound";

const GaugeVoting = lazy(() =>
  import("./GaugeVoting").then((module) => ({ default: module.GaugeVoting })),
);
const GaugeVoteRoute = lazy(() =>
  import("./GaugeVoting").then((module) => ({ default: module.GaugeVoteRoute })),
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
const CreateBountyRoute = lazy(() =>
  import("./Ledger").then((module) => ({ default: module.CreateBountyRoute })),
);
const BountyDetailRoute = lazy(() =>
  import("./Ledger").then((module) => ({ default: module.BountyDetailRoute })),
);
// Keep the component module name distinct from registry.ts. On case-folding
// filesystems, the old `Registry.tsx` path resolved to the data module first.
const Registry = lazy(() =>
  import("./ProjectRegistry").then((module) => ({ default: module.Registry })),
);
const ProjectManageRoute = lazy(() =>
  import("./ProjectRegistry").then((module) => ({ default: module.ProjectManageRoute })),
);
const ProjectDetailRoute = lazy(() =>
  import("./ProjectRegistry").then((module) => ({ default: module.ProjectDetailRoute })),
);

type TransactionAccess = BountyTransactionAccess & RegistryTransactionFlow & GaugeTransactionFlow;

const compactAddress = (address: string) => `${address.slice(0, 9)}…${address.slice(-5)}`;

// Pre-router builds deep-linked the FAQ as /#faq or /#faq-<section>. Keep
// those links working by redirecting them onto the /faq route.
function LegacyFaqRedirect() {
  const { pathname, hash } = useLocation();
  if (pathname !== "/faq" && (hash === "#faq" || hash.startsWith("#faq-"))) {
    return <Navigate replace to={{ pathname: "/faq", hash: hash === "#faq" ? "" : hash }} />;
  }
  return null;
}

export function App({
  source: supplied,
  registrySource: suppliedRegistry,
  config,
  transactions,
  registryTransactionFlow,
  gaugeSource: suppliedGauge,
  gaugeTransactionFlow,
  walletAddress,
  metadataClient: suppliedMetadata,
  documentPublisher: suppliedPublisher,
}: {
  source?: VoiceDataSource;
  registrySource?: RegistryDataSource;
  config: AppConfig;
  transactions?: BountyTransactionAccess;
  registryTransactionFlow?: RegistryTransactionFlow;
  gaugeSource?: GaugeDataSource;
  gaugeTransactionFlow?: GaugeTransactionFlow;
  walletAddress?: string;
  metadataClient?: MetadataClient;
  documentPublisher?: DocumentPublisher;
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
  const metadata = useMemo(
    () => suppliedMetadata ?? createMetadataClient({ gatewayBase: config.ipfsGateway }),
    [suppliedMetadata, config.ipfsGateway],
  );
  const publisher = useMemo(
    () => suppliedPublisher ?? (config.presignUrl ? createDocumentPublisher(createMetadataUploader(config.presignUrl)) : undefined),
    [suppliedPublisher, config.presignUrl],
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
  const [connectedAddress, setConnectedAddress] = useState<string | null>(walletAddress ?? null);
  const [walletBusy, setWalletBusy] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const viewRegion = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const segment = location.pathname.split("/").filter(Boolean)[0] ?? "";
  const viewName = segment || "home";
  const previousSegment = useRef<string | null>(null);
  useEffect(() => {
    if (walletAddress) setConnectedAddress(walletAddress);
  }, [walletAddress]);
  // Move focus to the view region only when the page (first path segment)
  // changes: never on initial load, and never when a nested route such as a
  // modal opens or closes within the same page.
  useEffect(() => {
    if (previousSegment.current !== null && previousSegment.current !== segment) {
      setWalletError(null);
      window.scrollTo(0, 0);
      window.requestAnimationFrame(() => viewRegion.current?.focus());
    }
    previousSegment.current = segment;
  }, [segment]);
  const walletConnector = productionTransactions ?? transactions ??
    (registryTransactionFlow?.connect ? registryTransactionFlow : undefined) ??
    (gaugeTransactionFlow?.connect ? gaugeTransactionFlow : undefined);
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
  const navClass = ({ isActive }: { isActive: boolean }) => isActive ? "nav-active" : "";

  return (
    <div className="shell app-shell juno-grid">
      <header className="topbar app-topbar">
        <div className="topbar-inner">
          <Link className="brand" to="/">
            <img src={`${base}assets/logo-salmon.svg`} alt="" />
            <img src={`${base}assets/wordmark-salmon.svg`} alt="Juno" />
            <span>VOICE</span>
          </Link>
          <nav aria-label="Primary">
            <NavLink to="/bounties" className={navClass}>Bounties</NavLink>
            <NavLink to="/gauge" className={navClass}>Gauge</NavLink>
            <NavLink to="/projects" className={navClass}>Projects</NavLink>
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
      <div ref={viewRegion} className="view-region" tabIndex={-1} aria-live="polite" aria-label={`${viewName} view`}>
      <Suspense fallback={<main className="route-loading"><p>Loading public view…</p></main>}>
      <LegacyFaqRedirect />
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/faq" element={<FAQPage />} />
        <Route path="/bounties" element={<Ledger source={source} config={config} transactions={bountyAccess} metadata={metadata} publisher={publisher} />}>
          <Route path="create" element={<CreateBountyRoute />} />
          <Route path=":bountyId" element={<BountyDetailRoute />} />
        </Route>
        <Route path="/gauge" element={<GaugeVoting source={gaugeSource} config={config} transactionFlow={gaugeAccess} sender={connectedAddress ?? undefined} metadata={metadata} />}>
          <Route path="vote" element={<GaugeVoteRoute />} />
        </Route>
        <Route path="/projects" element={<Registry source={registrySource} config={config} transactionFlow={registryAccess} sender={connectedAddress ?? undefined} metadata={metadata} publisher={publisher} />}>
          <Route path="manage" element={<ProjectManageRoute />} />
          <Route path=":projectId" element={<ProjectDetailRoute />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Routes>
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
            <Link className="footer-link" to="/faq">FAQ <span aria-hidden="true">→</span></Link>
            <a className="footer-link" href="https://github.com/juno-ai-dev/juno-voice">Open source · MIT <span aria-hidden="true">↗</span></a>
          </nav>
        </footer>
      </div>
    </div>
  );
}
