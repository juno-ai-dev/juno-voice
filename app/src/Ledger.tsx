import { useEffect, useMemo, useState } from "react";
import type { VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import type { Bounty, BountyDetail, BountyStatus } from "./types";
import { useAsync } from "./useAsync";
const labels: Record<BountyStatus, string> = {
  open: "Open",
  single_confirmation: "Awaiting confirmation",
  ratifying: "Ratifying",
  refunding: "Refunding",
  refunded: "Refunded",
  paid: "Paid",
};
const fmt = (amount: string) => {
  const value = BigInt(amount),
    whole = value / 1_000_000n,
    fraction = (value % 1_000_000n)
      .toString()
      .padStart(6, "0")
      .replace(/0+$/, "");
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ""} JUNO`;
};
const compact = (v: string) => `${v.slice(0, 12)}…${v.slice(-6)}`;
const timestampDate = (nanoseconds: string) =>
  new Date(Number(BigInt(nanoseconds) / 1_000_000n));
export function Ledger({
  source,
  config,
}: {
  source: VoiceDataSource;
  config: AppConfig;
}) {
  const load = useMemo(() => () => source.loadLedger(), [source]);
  const [state, retry] = useAsync(load, "bounties");
  const [status, setStatus] = useState<"all" | BountyStatus>("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<{ kind: "closed" | "loading" | "error" | "ready"; data?: BountyDetail; message?: string }>({ kind: "closed" });
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    if (state.kind !== "ready") return;
    const remaining = Math.max(
      0,
      60_001 - (Date.now() - state.data.refreshedAt.getTime()),
    );
    const timer = window.setTimeout(() => setClock(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [state]);
  if (state.kind === "loading")
    return (
      <main>
        <State
          title="Loading mainnet bounty ledger…"
          detail="Verifying deployment provenance, then querying Juno mainnet directly."
        />
      </main>
    );
  if (state.kind === "error")
    return (
      <main>
        <State title="Mainnet data unavailable" detail={state.message}>
          <button className="button primary" onClick={retry}>
            Retry query
          </button>
        </State>
      </main>
    );
  const d = state.data,
    stale = clock - d.refreshedAt.getTime() > 60_000;
  const rows = d.bounties.filter(
    (b) =>
      (status === "all" || b.status === status) &&
      `${b.terms.title} ${b.terms.summary} ${b.creator}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <main>
      <section className="hero" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">JUNO VOICE · JUNO-1 MAINNET</p>
          <h1 id="page-title">Public bounty ledger</h1>
          <p>
            Authoritative, read-only bounty state queried directly from the
            verified Juno Voice contract. This interface cannot connect a
            wallet, sign, or execute transactions.
          </p>
        </div>
        <aside className="hero-summary" aria-label="Protocol summary">
          <Fact label="Bounties" value={String(d.bounties.length)} />
          <Fact
            label="New activity"
            value={d.pause.paused ? "Paused" : "Open"}
          />
          <Fact
            label="Solvency"
            value={d.health.fully_backed ? "Fully backed" : "Degraded"}
          />
        </aside>
      </section>
      {d.pause.paused && (
        <section className="notice" role="status">
          <strong>New activity is paused.</strong>
          {d.pause.reason && ` ${d.pause.reason}`}
        </section>
      )}
      {!d.health.fully_backed && (
        <section className="notice danger" role="alert">
          <strong>Accounting degraded.</strong> Reported liabilities exceed
          verified backing.
        </section>
      )}
      <section aria-labelledby="ledger-title">
        <div className="toolbar">
          <div>
            <p className="eyebrow">ON-CHAIN RECORDS</p>
            <h2 id="ledger-title">Bounties</h2>
          </div>
          <div className="filters">
            <label className="control-label">
              Status
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="all">All statuses</option>
                {Object.entries(labels).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="control-label">
              Search
              <input
                className="search"
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Title, summary, creator…"
              />
            </label>
          </div>
        </div>
        <div className="ledger">
          {rows.length === 0 ? (
            <State
              title={
                d.bounties.length === 0
                  ? "No on-chain bounties yet"
                  : "No matching bounties"
              }
              detail={
                d.bounties.length === 0
                  ? "The verified mainnet contract returned an empty first page. No sample or demo records are shown."
                  : "Adjust the status filter or search."
              }
            />
          ) : (
            <div className="bounty-list">
              {rows.map((b) => (
                <BountyRow key={b.id} bounty={b} onOpen={async () => {
                  if (!source.loadBountyDetail) return;
                  setDetail({ kind: "loading" });
                  try { setDetail({ kind: "ready", data: await source.loadBountyDetail(b.id) }); }
                  catch (error) { setDetail({ kind: "error", message: error instanceof Error ? error.message : "Detail unavailable" }); }
                }} />
              ))}
            </div>
          )}
        </div>
      </section>
      {detail.kind !== "closed" && <BountyDetailPanel state={detail} onClose={() => setDetail({ kind: "closed" })} />}
      <section className="facts-panel" aria-labelledby="economics">
        <h2 id="economics">Protocol economics</h2>
        <div className="network-grid">
          <Fact
            label="Minimum contribution"
            value={fmt(d.config.min_contribution)}
          />
          <Fact label="Maximum bounty" value={fmt(d.config.max_bounty_total)} />
          <Fact
            label="Lifetime range"
            value={`${d.config.min_lifetime_seconds}s – ${d.config.max_lifetime_seconds}s`}
          />
          <Fact
            label="Maximum contributors"
            value={String(d.config.max_contributors)}
          />
          <Fact label="Maximum rounds" value={String(d.config.max_rounds)} />
          <Fact
            label="Active escrow"
            value={fmt(d.health.accounting.active_escrow)}
          />
          <Fact
            label="Outstanding refunds"
            value={fmt(d.health.accounting.outstanding_refunds)}
          />
          <Fact
            label="Pending payouts"
            value={fmt(d.health.accounting.pending_payout_liabilities)}
          />
          <Fact
            label="Actual balance"
            value={fmt(d.health.actual_native_balance)}
          />
          <Fact label="Liabilities" value={fmt(d.health.liabilities)} />
        </div>
      </section>
      <details className="network-details" open>
        <summary>
          Network and provenance{" "}
          <span className={stale ? "stale" : ""}>
            {stale
              ? "Stale · retry recommended"
              : "Fresh direct-RPC observation"}
          </span>
        </summary>
        <div className="network-grid">
          <Fact label="Chain ID" value={config.chainId} />
          <Fact
            label="Contract"
            value={compact(config.contract)}
            href={`${config.explorer}/address/${config.contract}`}
          />
          <Fact label="Code ID" value={String(config.codeId)} />
          <Fact
            label="Wasm checksum"
            value={`${config.codeChecksum.slice(0, 12)}…`}
            title={config.codeChecksum}
          />
          <Fact
            label="Observation height"
            value={d.observationHeight.toLocaleString()}
          />
          <Fact label="Observed" value={d.refreshedAt.toISOString()} />
          <Fact
            label="Release commit"
            value={
              config.releaseCommit === "local-uncommitted"
                ? config.releaseCommit
                : `${config.releaseCommit.slice(0, 12)}…`
            }
            title={config.releaseCommit}
          />
        </div>
        <p>
          The height is a separate observation. Paginated contract queries are
          weakly consistent and do not include a query height.
        </p>
      </details>
    </main>
  );
}
function BountyRow({ bounty: b, onOpen }: { bounty: Bounty; onOpen: () => void }) {
  return (
    <article className="bounty-row">
      <span className="rank">#{b.id}</span>
      <div>
        <h3><button className="detail-link" onClick={onOpen}>{b.terms.title}</button></h3>
        <p>{b.terms.summary}</p>
        <small>Creator {compact(b.creator)}</small>
        {b.project_candidate && (
          <small className="project-badge">
            Project candidate · {b.project_candidate.project_id}
          </small>
        )}
        {b.refund_reason && (
          <small>Refund: {refundLabel(b.refund_reason)}</small>
        )}
      </div>
      <span className="badge">{labels[b.status]}</span>
      <div>
        <strong>{fmt(b.total_contribution)}</strong>
        <small>
          {b.contributor_count} contributor
          {b.contributor_count === 1 ? "" : "s"}
        </small>
      </div>
      <div>
        <small>Expires</small>
        <time dateTime={timestampDate(b.expires_at).toISOString()}>
          {timestampDate(b.expires_at).toLocaleDateString()}
        </time>
      </div>
    </article>
  );
}
function BountyDetailPanel({ state, onClose }: {
  state: { kind: string; data?: BountyDetail; message?: string }; onClose: () => void;
}) {
  const d = state.data;
  const action = (value: string | Record<string, unknown>) =>
    typeof value === "string" ? value : Object.keys(value)[0]?.replaceAll("_", " ") ?? "event";
  return <section className="detail-panel" aria-labelledby="detail-title">
    <button className="button close" onClick={onClose}>Close detail</button>
    {state.kind === "loading" && <State title="Loading canonical bounty detail…" detail="Querying all detail records directly from the contract." />}
    {state.kind === "error" && <State title="Bounty detail unavailable" detail={state.message ?? "Query failed."} />}
    {d && <>
      <p className="eyebrow">CANONICAL BOUNTY #{d.bounty.id} · HEIGHT {d.observationHeight}</p>
      <h2 id="detail-title">{d.bounty.terms.title}</h2><p>{d.bounty.terms.summary}</p>
      <div className="detail-grid">
        <section><h3>Terms</h3><p><strong>Acceptance criteria</strong><br />{d.bounty.terms.acceptance_criteria}</p>
          <Fact label="Creator" value={compact(d.bounty.creator)} title={d.bounty.creator} />
          <Fact label="Expires" value={timestampDate(d.bounty.expires_at).toISOString()} />
          <Fact label="Total / cap" value={`${fmt(d.bounty.total_contribution)} / ${fmt(d.bounty.terms.max_bounty_total)}`} />
          <Fact label="Config snapshot" value={String(d.bounty.terms.config_version)} />
          {d.bounty.terms.content_uri && <p>Metadata <SafeUri uri={d.bounty.terms.content_uri} /> <code>{d.bounty.terms.content_digest}</code></p>}
        </section>
        <section><h3>Project candidate</h3>{d.bounty.project_candidate ? <><p>{d.bounty.project_candidate.project_id}</p>
          <p><SafeUri uri={d.bounty.project_candidate.metadata_uri} /> <code>{d.bounty.project_candidate.metadata_digest}</code></p>
          <small>Candidate only; this is not a registry listing until a separate authorized graduation.</small></> : <p>None attached.</p>}
          <h3>Active round</h3><pre>{d.activeRound ? JSON.stringify(d.activeRound, null, 2) : "No active round"}</pre>
          <h3>Moderation / graduation</h3><pre>{JSON.stringify({ moderation: d.moderation, graduation: d.graduation }, null, 2)}</pre></section>
        <section><h3>Contributions ({d.contributions.length})</h3>{d.contributions.map((x) => <p key={x.contributor_index}>{compact(x.contributor)} · {fmt(x.current_amount)}</p>)}</section>
        <section><h3>Claims ({d.claims.length})</h3>{d.claims.length ? d.claims.map((x) => <p key={x.contributor}>{compact(x.contributor)} · {fmt(x.amount)}</p>) : <p>No completed claims.</p>}</section>
      </div>
      <h3>History ({d.history.length} of {d.bounty.history_count})</h3><ol className="history">{d.history.map((x) => <li key={x.sequence}><strong>{action(x.action)}</strong> · {compact(x.actor)} · <time dateTime={timestampDate(x.at).toISOString()}>{timestampDate(x.at).toLocaleString()}</time></li>)}</ol>
      <p className="chain-time">Eligibility reference: canonical chain time {d.chainTimeNanos} ns. Browser time is display-only.</p>
    </>}
  </section>;
}
function SafeUri({ uri }: { uri: string }) {
  const safe = /^(https:\/\/|ipfs:\/\/)[^\s]+$/.test(uri);
  if (!safe) return <code title={uri}>Unsafe URI withheld</code>;
  const href = uri.startsWith("ipfs://") ? `https://ipfs.io/ipfs/${encodeURIComponent(uri.slice(7))}` : uri;
  return <a href={href} target="_blank" rel="noopener noreferrer">Open metadata</a>;
}
function refundLabel(reason: Bounty["refund_reason"]) {
  if (reason === null) return "";
  if (reason === "expired") return "Expired";
  if (reason === "sole_confirmation_timeout")
    return "Sole confirmation timed out";
  if (reason === "round_limit") return "Round limit reached";
  if ("cancelled" in reason) return `Cancelled · ${reason.cancelled.reason}`;
  return `Moderated (${reason.moderated.outcome.replaceAll("_", " ")}) · ${reason.moderated.reason}`;
}
function Fact({
  label,
  value,
  title,
  href,
}: {
  label: string;
  value: string;
  title?: string;
  href?: string;
}) {
  return (
    <div className="fact">
      <span>{label}</span>
      <strong title={title}>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          value
        )}
      </strong>
    </div>
  );
}
function State({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="state" role="status">
      <h2>{title}</h2>
      <p>{detail}</p>
      {children}
    </div>
  );
}
