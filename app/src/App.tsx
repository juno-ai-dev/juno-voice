import { useEffect, useMemo, useState } from 'react';
import { createDataSource, type VoiceDataSource } from './client';
import { loadConfig, type AppConfig } from './config';
import { Detail } from './Detail';
import { Ledger } from './Ledger';

function route(): number | null { const match = window.location.pathname.match(/^\/requests\/(\d+)\/?$/); return match ? Number(match[1]) : null; }
export function App({ source: suppliedSource, config: suppliedConfig }: { source?: VoiceDataSource; config?: AppConfig }) {
  const config = suppliedConfig ?? loadConfig({ VITE_CHAIN_ID: import.meta.env.VITE_CHAIN_ID, VITE_CONTRACT_ADDRESS: import.meta.env.VITE_CONTRACT_ADDRESS, VITE_RPC_URL: import.meta.env.VITE_RPC_URL });
  const source = useMemo(() => suppliedSource ?? createDataSource(config), [suppliedSource, config]);
  const [requestId, setRequestId] = useState(route);
  useEffect(() => { const update = () => setRequestId(route()); window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update); }, []);
  const navigate = (id: number | null) => { window.history.pushState({}, '', id === null ? '/' : `/requests/${id}`); setRequestId(id); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  return <div className="shell grid"><header className="topbar"><div className="topbar-inner"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate(null); }}><img src="/assets/logo-salmon.svg" alt="" /><img src="/assets/wordmark-salmon.svg" alt="Juno" /><span>VOICE</span></a><nav aria-label="Primary"><a href="/" aria-current={requestId === null ? 'page' : undefined} onClick={(event) => { event.preventDefault(); navigate(null); }}>Signal</a><span className="testnet">TESTNET · UNI-7</span></nav></div></header>{requestId === null ? <Ledger source={source} config={config} onOpen={(id) => navigate(id)} /> : <Detail source={source} config={config} id={requestId} onBack={() => navigate(null)} />}<footer><p>Read-only direct-RPC view · No wallet or signing</p><p>Design assets and tokens © 2026 Jake Hartnell, MIT · Juno Design System <a href="https://github.com/juno-ai-dev/juno-design-system/commit/0dc0ae9">0dc0ae9</a></p></footer></div>;
}
