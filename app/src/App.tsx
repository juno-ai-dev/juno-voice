import { useMemo } from "react";
import { createDataSource, type VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import { Ledger } from "./Ledger";
export function App({
  source: supplied,
  config,
}: {
  source?: VoiceDataSource;
  config: AppConfig;
}) {
  const base = import.meta.env.BASE_URL;
  const source = useMemo(
    () => supplied ?? createDataSource(config),
    [supplied, config],
  );
  return (
    <div className="shell juno-grid">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={base}>
            <img src={`${base}assets/logo-salmon.svg`} alt="" />
            <img src={`${base}assets/wordmark-salmon.svg`} alt="Juno" />
            <span>VOICE</span>
          </a>
          <span className="mainnet">JUNO-1 · READ ONLY</span>
        </div>
      </header>
      <Ledger source={source} config={config} />
      <footer>
        <p>
          Read-only mainnet observation · No wallet or transaction capabilities
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
