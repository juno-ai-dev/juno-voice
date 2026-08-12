import { useMemo } from "react";
import { createDataSource, type VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { Ledger } from "./Ledger";
import type { BountyTransactionAccess } from "./BountyActions";
import { createBrowserTransactionAccess } from "./browserTransactions";
export function App({
  source: supplied,
  config,
  transactions,
}: {
  source?: VoiceDataSource;
  config: AppConfig;
  transactions?: BountyTransactionAccess;
}) {
  const base = import.meta.env.BASE_URL;
  const source = useMemo(
    () => supplied ?? createDataSource(config),
    [supplied, config],
  );
  const transactionAccess = useMemo(() => {
    if (transactions) return transactions;
    const browser = window as Window & { keplr?: unknown; leap?: unknown };
    const kind = browser.keplr ? "keplr" : browser.leap ? "leap" : null;
    if (!kind) return undefined;
    try { return createBrowserTransactionAccess(config, source, kind); }
    catch { return undefined; }
  }, [transactions, config, source]);
  return (
    <div className="shell juno-grid">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={base}>
            <img src={`${base}assets/logo-salmon.svg`} alt="" />
            <img src={`${base}assets/wordmark-salmon.svg`} alt="Juno" />
            <span>VOICE</span>
          </a>
          <span className="mainnet">JUNO-1 · PUBLIC LEDGER</span>
        </div>
      </header>
      <Ledger source={source} config={config} transactions={transactionAccess} />
      <footer>
        <p>
          Public mainnet observation · Read-only access never requires a wallet
        </p>
        <p>
          Juno Design System{" "}
          <a href="https://github.com/juno-ai-dev/juno-design-system/commit/0dc0ae9ae80e0378b61fc9f67cbf417f291d6f16">
            0dc0ae9
          </a>{" "}
          · MIT
        </p>
      </footer>
    </div>
  );
}
