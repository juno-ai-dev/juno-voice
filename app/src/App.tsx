import { useEffect, useMemo, useState } from 'react';
import { createDataSource, type VoiceDataSource } from './client';
import type { AppConfig } from './config';
import { Detail } from './Detail';
import { Ledger } from './Ledger';
import { PublicTransactions, WalletConnection, type TransactionReceipt } from './wallet';
import { TransactionReceiptView, WalletButton } from './WalletActions';

function route(): number | null { const match = window.location.pathname.match(/^\/requests\/(\d+)\/?$/); return match ? Number(match[1]) : null; }
export function App({ source: suppliedSource, config }: { source?: VoiceDataSource; config: AppConfig }) {
  const source = useMemo(() => suppliedSource ?? createDataSource(config), [suppliedSource, config]);
  const wallet = useMemo(() => new WalletConnection(config), [config]);
  const transactions = useMemo(() => new PublicTransactions(config, { config: () => source.loadContractConfig ? source.loadContractConfig() : Promise.reject(new Error('Write queries unavailable.')), request: (id) => source.loadRequest ? source.loadRequest(id) : Promise.reject(new Error('Write queries unavailable.')) }, wallet), [config, source, wallet]);
  const [account, setAccount] = useState<string|null>(null);
  const [refresh, setRefresh] = useState(0);
  const [receipt, setReceipt] = useState<TransactionReceipt|null>(null);
  useEffect(() => {
    const unsubscribe=wallet.onChange(() => setAccount(null));
    return () => {unsubscribe();wallet.disconnect()};
  }, [wallet]);
  const [requestId, setRequestId] = useState(route);
  useEffect(() => { const update = () => setRequestId(route()); window.addEventListener('popstate', update); return () => window.removeEventListener('popstate', update); }, []);
  const navigate = (id: number | null) => { window.history.pushState({}, '', id === null ? '/' : `/requests/${id}`); setRequestId(id); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const accepted=(value:TransactionReceipt)=>{setReceipt(value);setRefresh(current=>current+1)};
  return <div className="shell grid"><header className="topbar"><div className="topbar-inner"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate(null); }}><img src="/assets/logo-salmon.svg" alt="" /><img src="/assets/wordmark-salmon.svg" alt="Juno" /><span>VOICE</span></a><nav aria-label="Primary"><a href="/" aria-current={requestId === null ? 'page' : undefined} onClick={(event) => { event.preventDefault(); navigate(null); }}>Signal</a><span className="testnet">TESTNET · UNI-7</span><WalletButton wallet={wallet} account={account} onAccount={setAccount}/></nav></div></header>{receipt&&<div className="durable-receipt"><TransactionReceiptView receipt={receipt}/></div>}{requestId === null ? <Ledger refreshToken={refresh} source={source} config={config} account={account} transactions={transactions} onSuccess={accepted} onOpen={(id) => navigate(id)} /> : <Detail refreshToken={refresh} source={source} config={config} id={requestId} account={account} transactions={transactions} onSuccess={accepted} onBack={() => navigate(null)} />}<footer><p>Direct-RPC reading works without a wallet · Public submission and eligible refund signing only · Voting safety-gated</p><p>Design assets and tokens © 2026 Jake Hartnell, MIT · Juno Design System <a href="https://github.com/juno-ai-dev/juno-design-system/commit/0dc0ae9">0dc0ae9</a></p></footer></div>;
}
