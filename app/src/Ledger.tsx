import { useEffect, useMemo, useState } from 'react';
import type { VoiceDataSource } from './client';
import { filterRequests, type StatusFilter } from './filter';
import { compactAddress, formatPower, netPower, statusLabels } from './format';
import type { AppConfig } from './config';
import { useAsync } from './useAsync';
import type { Request } from './types';
import type { PublicTransactions, TransactionReceipt } from './wallet';
import { SubmitAction } from './WalletActions';

interface Props { source: VoiceDataSource; config: AppConfig; onOpen: (id: number) => void; account?:string|null; transactions?:PublicTransactions; onSuccess?:(receipt:TransactionReceipt)=>void; refreshToken?:number }
const filters: StatusFilter[] = ['all', 'open', 'qualified', 'not_prioritized', 'duplicate', 'spam', 'building', 'review', 'blocked', 'archived', 'shipped'];
export function Ledger({ source, config, onOpen, account=null, transactions, onSuccess=()=>undefined, refreshToken=0 }: Props) {
  const load = useMemo(() => { void refreshToken; return () => source.loadLedger(); }, [source,refreshToken]);
  const [state, retry] = useAsync(load, 'ledger');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(timer); }, []);
  if (state.kind === 'loading') return <main><State title="Receiving uni-7 signal…" detail="Querying the contract directly by RPC." /></main>;
  if (state.kind === 'error') return <main><State title="RPC signal unavailable" detail={state.message}><button className="button primary" onClick={retry}>Retry query</button></State></main>;
  const age = now - state.data.refreshedAt.getTime();
  const stale = age > 60_000;
  const loaded = filter === 'all' ? state.data.requests : state.data.ranked[filter];
  const rows = filterRequests(loaded, 'all', search);
  return <main>
    <section className="hero" aria-labelledby="page-title"><div><p className="eyebrow">UNI-7 · LIVE CONTRACT · SMOKE DEPLOYMENT</p><h1 id="page-title">What should the network build next?</h1><p>Authoritative testnet requests, priorities, lifecycle, and delivery evidence queried from Juno Voice. Current records are protocol smoke evidence, not production demand.</p></div>
      <aside className="facts" aria-label="Live chain facts"><Fact label="Network" value="TESTNET / UNI-7" /><Fact label="Chain ID" value={config.chainId} /><Fact label="Contract" value={compactAddress(config.contract)} title={config.contract} href={`${config.explorer}/address/${encodeURIComponent(config.contract)}`} /><Fact label="Code ID" value={String(config.codeId)} /><Fact label="RPC height" value={state.data.queryHeight.toLocaleString()} /><div className="fact"><span>Refreshed</span><strong><time dateTime={state.data.refreshedAt.toISOString()}>{state.data.refreshedAt.toLocaleTimeString()}</time></strong></div><span className={`freshness ${stale ? 'stale' : ''}`} role="status">{stale ? 'Stale · refresh recommended' : 'Fresh direct-RPC data'}</span><small>Multi-query snapshot · heights may differ slightly.</small></aside>
    </section>
    <section className="overview" aria-label="Protocol configuration"><Fact label="Native denom" value={state.data.config.native_denom} /><Fact label="Submission bond" value={formatPower(state.data.config.submission_bond)} /><Fact label="Locked bonds" value={formatPower(state.data.bonds.locked)} /><Fact label="Refundable" value={formatPower(state.data.bonds.refundable)} /><Fact label="Submissions" value={state.data.config.submissions_paused ? 'Paused' : 'Open'} /></section>
    {transactions&&<SubmitAction account={account} transactions={transactions} live={state.data.config} onSuccess={onSuccess}/>}<section aria-labelledby="ledger-title"><div className="toolbar"><div><h2 id="ledger-title">Signal ledger</h2><div className="tabs" aria-label="Filter requests">{filters.map((value) => <button key={value} className={`tab ${filter === value ? 'active' : ''}`} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === 'all' ? 'All requests' : statusLabels[value]}</button>)}</div></div><label className="search-label">Filter loaded results ({loaded.length})<input className="search" type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Title, category, author…" /></label></div>
      <div className="ledger"><div className="ledger-head" aria-hidden="true"><span>ID</span><span>Request</span><span>State</span><span>Net signal</span><span>Voters</span></div>{rows.length === 0 ? <State title={loaded.length === 0 && filter === 'all' ? 'No on-chain requests yet' : 'No matching signal'} detail={loaded.length === 0 && filter === 'all' ? 'The contract returned no requests.' : 'Adjust the status filter or search.'} /> : rows.map((request) => <RequestRow key={request.id} request={request} onOpen={onOpen} />)}</div>
    </section>
  </main>;
}
function RequestRow({ request, onOpen }: { request: Request; onOpen: (id: number) => void }) { const net = netPower(request); return <button className="request-row" onClick={() => onOpen(request.id)} aria-label={`Open request ${request.id}: ${request.title}; ${statusLabels[request.status]}; category ${request.category}; net signal ${net.toString()}; ${request.voter_count} voters`}><span className="rank">{String(request.id).padStart(3, '0')}</span><span><strong className="request-title">{request.title}</strong><small>{request.summary}</small></span><span><b className="badge">{statusLabels[request.status]}</b><em>#{request.category}</em></span><span className={net >= 0 ? 'positive' : ''}>{net >= 0 ? '+' : ''}{formatPower(net.toString())}<small>{formatPower(request.support_power)} support</small></span><span>{request.voter_count.toLocaleString()}</span></button>; }
function Fact({ label, value, title, href }: { label: string; value: string; title?: string; href?: string }) { return <div className="fact"><span>{label}</span><strong title={title}>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{value}</a> : value}</strong></div>; }
function State({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) { return <div className="state" role="status"><h2>{title}</h2><p>{detail}</p>{children}</div>; }
