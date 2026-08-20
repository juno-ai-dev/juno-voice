import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useLocation, useOutletContext, useParams } from "react-router";
import type { VoiceDataSource } from "./client";
import type { AppConfig } from "./config";
import type { Bounty, BountyDetail, BountyStatus, ContractConfig, PauseState } from "./types";
import { useAsync } from "./useAsync";
import { BountyActions, type BountyTransactionAccess } from "./BountyActions";
import { loadLatestBountySubmission } from "./bountySubmissionState";
import { formatJuno } from "./junoAmount";
import { compact } from "./format";
import { Fact } from "./components/Fact";
import { State } from "./components/State";
import { Modal } from "./components/Modal";
import { PageHeader } from "./components/PageHeader";
import { PageMeta } from "./components/PageMeta";
import { SubmissionEvidenceBanner } from "./components/SubmissionEvidenceBanner";
import { MetadataPanel } from "./MetadataView";
import type { MetadataClient } from "./metadataFetch";
import type { DocumentPublisher } from "./metadataPublish";
import { NotFound } from "./routes/NotFound";
import { useCloseModal } from "./routes/useCloseModal";
const labels: Record<BountyStatus, string> = {
  open: "Open",
  single_confirmation: "Awaiting confirmation",
  ratifying: "Ratifying",
  refunding: "Refunding",
  refunded: "Refunded",
  paid: "Paid",
};
const fmt = formatJuno;
const timestampDate = (nanoseconds: string) =>
  new Date(Number(BigInt(nanoseconds) / 1_000_000n));

export interface LedgerOutletContext {
  source: VoiceDataSource;
  config: AppConfig;
  transactions?: BountyTransactionAccess;
  metadata?: MetadataClient;
  publisher?: DocumentPublisher;
  canonical: { config: ContractConfig; pause: PauseState; chainTimeNanos: string; fingerprint: string };
  stale: boolean;
}

export function Ledger({
  source,
  config,
  transactions,
  metadata,
  publisher,
}: {
  source: VoiceDataSource;
  config: AppConfig;
  transactions?: BountyTransactionAccess;
  metadata?: MetadataClient;
  publisher?: DocumentPublisher;
}) {
  const load = useMemo(() => () => source.loadLedger(), [source]);
  const [state, retry] = useAsync(load, "bounties");
  const [status, setStatus] = useState<"all" | BountyStatus>("all");
  const [search, setSearch] = useState("");
  const [clock, setClock] = useState(Date.now);
  // Child modal routes own the document title while they are open.
  const pageMeta = useLocation().pathname === "/bounties" ? <PageMeta route="bounties" /> : null;
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
        {pageMeta}
        <State
          title="Loading mainnet bounty ledger…"
          detail="Verifying deployment provenance, then querying Juno mainnet directly."
        />
      </main>
    );
  if (state.kind === "error")
    return (
      <main>
        {pageMeta}
        <State title="Mainnet data unavailable" detail={state.message}>
          <button className="button primary" onClick={retry}>
            Retry query
          </button>
        </State>
      </main>
    );
  const d = state.data,
    stale = clock - d.refreshedAt.getTime() > 60_000;
  const submissionLocked = loadLatestBountySubmission({ chainId: config.chainId, contract: config.contract }) !== null;
  const outletContext: LedgerOutletContext = {
    source, config, transactions, metadata, publisher, stale,
    canonical: { config: d.config, pause: d.pause, chainTimeNanos: d.chainTimeNanos, fingerprint: d.fingerprint },
  };
  const rows = d.bounties.filter(
    (b) =>
      (status === "all" || b.status === status) &&
      `${b.terms.title} ${b.terms.summary} ${b.creator}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <main>
      {pageMeta}
      <PageHeader
        eyebrow="JUNO VOICE · JUNO-1 MAINNET"
        title="Public bounty ledger"
        titleId="page-title"
        lede="Authoritative bounty state queried directly from the verified Juno Voice contract. Read-only access is always available; wallet actions use an exact pre-sign review when transaction support is present."
        actions={<Link className="button" to="create">Create a bounty</Link>}
        stats={[
          { label: "Bounties", value: String(d.bounties.length) },
          { label: "New activity", value: d.pause.paused ? "Paused" : "Open" },
          { label: "Solvency", value: d.health.fully_backed ? "Fully backed" : "Degraded" },
        ]}
        statsLabel="Protocol summary"
      />
      {submissionLocked && <SubmissionEvidenceBanner to="create" />}
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
                <BountyRow key={b.id} bounty={b} />
              ))}
            </div>
          )}
        </div>
      </section>
      <Outlet context={outletContext} />
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
          weakly consistent and do not include a query height. Linked bounty
          and project documents are fetched from the configured public IPFS
          gateway, which can observe the documents this browser requests.
        </p>
      </details>
    </main>
  );
}

export function CreateBountyRoute() {
  const { canonical, stale, transactions, config, publisher } = useOutletContext<LedgerOutletContext>();
  const close = useCloseModal("/bounties");
  return (
    <Modal titleId="create-title" onClose={close}>
      <PageMeta route="bounties/create" />
      <BountyActions access={transactions} bountyContract={config.contract} stale={stale} canonical={canonical} publisher={publisher} />
    </Modal>
  );
}

export function BountyDetailRoute() {
  const context = useOutletContext<LedgerOutletContext>();
  const close = useCloseModal("/bounties");
  const params = useParams();
  const bountyId = params.bountyId ?? "";
  if (!/^[1-9]\d*$/.test(bountyId)) return <NotFound />;
  return <BountyDetailLoader context={context} id={Number(bountyId)} onClose={close} />;
}

function BountyDetailLoader({ context, id, onClose }: { context: LedgerOutletContext; id: number; onClose: () => void }) {
  const { source, config, transactions, metadata, publisher } = context;
  const load = useMemo(() => async () => {
    if (!source.loadBountyDetail) throw new Error("Canonical bounty detail is unavailable in this environment.");
    return source.loadBountyDetail(id);
  }, [source, id]);
  const [state, retry] = useAsync(load, `bounty ${id}`);
  return (
    <Modal variant="panel" titleId="detail-title" onClose={onClose} closeLabel="Close detail">
      <PageMeta route="bounties" titleOverride={`Bounty #${id} · Juno Voice`} />
      {state.kind === "loading" && <State titleId="detail-title" title="Loading canonical bounty detail…" detail="Querying all detail records directly from the contract." />}
      {state.kind === "error" && <State titleId="detail-title" title="Bounty detail unavailable" detail={state.message}>
        <button className="button" onClick={retry}>Retry detail</button>
      </State>}
      {state.kind === "ready" && <BountyDetailBody d={state.data} bountyContract={config.contract}
        transactions={transactions} metadata={metadata} publisher={publisher} gateway={config.ipfsGateway} />}
    </Modal>
  );
}

function BountyRow({ bounty: b }: { bounty: Bounty }) {
  return (
    <article className="bounty-row">
      <span className="rank">#{b.id}</span>
      <div>
        <h3><Link className="detail-link" to={String(b.id)}>{b.terms.title}</Link></h3>
        <p>{b.terms.summary}</p>
        <small>Creator {compact(b.creator)}</small>
        {b.project_candidate && (
          <small className="project-badge">
            Project candidate metadata attached
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
function BountyDetailBody({ d, transactions, bountyContract, metadata, publisher, gateway }: {
  d: BountyDetail; transactions?: BountyTransactionAccess; bountyContract: string;
  metadata?: MetadataClient; publisher?: DocumentPublisher; gateway: string;
}) {
  const action = (value: string | Record<string, unknown>) =>
    typeof value === "string" ? value : Object.keys(value)[0]?.replaceAll("_", " ") ?? "event";
  return <div className="bounty-detail">
    <p className="eyebrow">CANONICAL BOUNTY #{d.bounty.id} · HEIGHT {d.observationHeight}</p>
    <h2 id="detail-title">{d.bounty.terms.title}</h2><p>{d.bounty.terms.summary}</p>
    <div className="detail-grid">
      <section><h3>Terms</h3><p><strong>Acceptance criteria</strong><br />{d.bounty.terms.acceptance_criteria}</p>
        <Fact label="Creator" value={compact(d.bounty.creator)} title={d.bounty.creator} />
        <Fact label="Expires" value={timestampDate(d.bounty.expires_at).toISOString()} />
        <Fact label="Total / cap" value={`${fmt(d.bounty.total_contribution)} / ${fmt(d.bounty.terms.max_bounty_total)}`} />
        <Fact label="Config snapshot" value={String(d.bounty.terms.config_version)} />
        {d.bounty.terms.content_uri && d.bounty.terms.content_digest && <MetadataPanel client={metadata} gateway={gateway}
          uri={d.bounty.terms.content_uri} digest={d.bounty.terms.content_digest} expected="juno-voice/bounty-content" />}
      </section>
      <section><h3>Project candidate</h3>{d.bounty.project_candidate ? <>
        <MetadataPanel client={metadata} gateway={gateway} uri={d.bounty.project_candidate.metadata_uri}
          digest={d.bounty.project_candidate.metadata_digest} expected="juno-voice/project" />
        <small>Candidate only; this is not a registry listing until a separate authorized graduation.</small></> : <p>None attached.</p>}
        <h3>Active round</h3>{d.activeRound ? <><p><strong>Round {d.activeRound.number} · {d.activeRound.rule.replaceAll("_", " ")}</strong></p>
          <p>Recipient {compact(d.activeRound.nomination.recipient)} · outcome {d.activeRound.outcome.replaceAll("_", " ")}</p>
          <p>YES {fmt(d.activeRound.yes_weight)} · NO {fmt(d.activeRound.no_weight)} · total snapshot {fmt(d.activeRound.total_weight)}</p>
          <p>Opens {d.activeRound.opens_at} ns · closes {d.activeRound.closes_at} ns</p>
          <MetadataPanel client={metadata} gateway={gateway} uri={d.activeRound.nomination.evidence_uri}
            digest={d.activeRound.nomination.evidence_digest} expected="juno-voice/evidence" />
          <p>{d.activeRound.nomination.rationale}</p></> : <p>No active round</p>}
        <h3>Moderation / graduation</h3><pre>{JSON.stringify({ moderation: d.moderation, graduation: d.graduation }, null, 2)}</pre></section>
      <section><h3>Contributions ({d.contributions.length})</h3>{d.contributions.map((x) => <p key={x.contributor_index}>{compact(x.contributor)} · current {fmt(x.current_amount)}
        {x.weight_at_round !== null && <> · round snapshot {fmt(x.weight_at_round)}</>}</p>)}</section>
      <section><h3>Claims ({d.claims.length})</h3>{d.claims.length ? d.claims.map((x) => <p key={x.contributor}>{compact(x.contributor)} · {fmt(x.amount)}</p>) : <p>No completed claims.</p>}</section>
    </div>
    <h3>Settlement rounds ({d.rounds.length})</h3>{d.rounds.length ? <ol>{d.rounds.map((x) => <li key={x.number}>Round {x.number}: <strong>{x.outcome.replaceAll("_", " ")}</strong> · YES {fmt(x.yes_weight)} / NO {fmt(x.no_weight)} · {x.voter_count} vote(s)</li>)}</ol> : <p>No payout rounds.</p>}
    <h3>Ballot receipts ({d.receipts.length})</h3>{d.receipts.length ? <ul>{d.receipts.map((x) => <li key={`${x.round}:${x.voter}`}>Round {x.round} · {compact(x.voter)} · {x.vote.toUpperCase()} · immutable weight {fmt(x.weight)} · revisions {x.revisions}</li>)}</ul> : <p>No ballots recorded.</p>}
    <h3>History ({d.history.length} of {d.bounty.history_count})</h3><ol className="history">{d.history.map((x) => <li key={x.sequence}><strong>{action(x.action)}</strong> · {compact(x.actor)} · <time dateTime={timestampDate(x.at).toISOString()}>{timestampDate(x.at).toLocaleString()}</time></li>)}</ol>
    <p className="chain-time">Eligibility reference: canonical chain time {d.chainTimeNanos} ns. Browser time is display-only.</p>
    <BountyActions bounty={d.bounty} contributions={d.contributions} settlement={d} access={transactions}
      bountyContract={bountyContract} stale={false} publisher={publisher}
      canonical={{ config: d.config, pause: d.pause, chainTimeNanos: d.chainTimeNanos, fingerprint: d.fingerprint }} />
  </div>;
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
