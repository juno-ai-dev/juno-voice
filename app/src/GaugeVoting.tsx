import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Outlet, useLocation, useNavigate, useOutletContext } from "react-router";
import type { AppConfig } from "./config";
import type { Epoch, GaugeData, GaugeDataSource } from "./gauge";
import { buildGaugeIntent, gaugeEligibility, type GaugeAction, type GaugeTransactionFlow, type PreferenceInput } from "./gaugeActions";
import { clearGaugeSubmission, gaugeActionFromReview, loadGaugeSubmission, loadLatestGaugeSubmission, markGaugeSubmissionUnavailable, saveGaugeSubmission, type StoredGaugeSubmission } from "./gaugeSubmissionState";
import type { TransactionOutcome, TransactionReview } from "./transactions";
import { useAsync } from "./useAsync";
import { formatJuno, userFacingTransactionAmounts } from "./junoAmount";
import { compact } from "./format";
import { Fact } from "./components/Fact";
import { State } from "./components/State";
import { VerifiedName } from "./MetadataView";
import type { MetadataClient } from "./metadataFetch";
import { Modal } from "./components/Modal";
import { PageHeader } from "./components/PageHeader";
import { PageMeta } from "./components/PageMeta";
import { SubmissionEvidenceBanner } from "./components/SubmissionEvidenceBanner";
import { useCloseModal } from "./routes/useCloseModal";
import "./registry-gauge.css";

const utc = (seconds: number) => new Date(seconds * 1000).toISOString();
const juno = formatJuno;
const percent = (part: string, total: string) => BigInt(total) === 0n ? "0.00%" : `${(BigInt(part) * 10_000n / BigInt(total) / 100n).toString()}.${(BigInt(part) * 10_000n / BigInt(total) % 100n).toString().padStart(2, "0")}%`;
const outcome = (epoch: Epoch) => epoch.outcome === "open" ? "Voting open" : epoch.outcome === "distributed" ? `Distributed · ${epoch.messageCount} message${epoch.messageCount === 1 ? "" : "s"}` : epoch.outcome === "no_distribution_turnout" ? "No distribution · turnout" : epoch.outcome === "no_distribution_zero_participation" ? "No distribution · zero participation" : epoch.outcome === "no_eligible_options" ? "No distribution · no eligible options" : epoch.outcome === "insufficient_funds" ? "No distribution · insufficient funds" : epoch.outcome === "expired" ? "Expired" : "Aborted";
const actionLabel = (action: GaugeAction) => action === "open_epoch" ? "Open epoch" : action === "place_votes" ? "Place votes" : action === "remove_votes" ? "Remove votes" : action === "expire_epoch" ? "Expire epoch" : "Execute";
const actionEpoch = (action: GaugeAction, data: GaugeData) => action === "open_epoch" ? (data.gauge.currentEpoch ?? 0) + 1 : data.current?.epochId;
const projectForOption = (option: string, data: GaugeData) => {
  const match = /^project:([1-9]\d*)$/.exec(option), id = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(id) ? data.registryProjects.find((project) => project.id === id) ?? null : null;
};
const OptionName = ({ option, data, metadata }: { option: string; data: GaugeData; metadata?: MetadataClient }) => {
  if (option === data.gauge.snapshotPolicy.retainedOption) return <><strong>Retain in Program Vault</strong><small>{option}</small></>;
  const project = projectForOption(option, data);
  return project
    ? <><strong><VerifiedName client={metadata} uri={project.metadata_uri} digest={project.metadata_digest} /></strong><small>Project #{project.id}</small></>
    : <><strong>Historical project option</strong><small>{option}</small></>;
};
const runtimeTransactionStatus = (value: unknown): TransactionOutcome["status"] | null => {
  if (typeof value !== "object" || value === null) return null;
  const status = (value as { status?: unknown }).status;
  return status === "confirmed" || status === "failed" || status === "rejected" || status === "pending" || status === "unknown" ? status : null;
};

export interface GaugeOutletContext {
  data: GaugeData;
  source: GaugeDataSource;
  config: AppConfig;
  transactionFlow?: GaugeTransactionFlow;
  activeSender: string | null;
  setConnected: (address: string) => void;
  metadata?: MetadataClient;
}

export function GaugeVoting({ source, config, transactionFlow, sender, metadata }: { source: GaugeDataSource; config: AppConfig; transactionFlow?: GaugeTransactionFlow; sender?: string; metadata?: MetadataClient }) {
  const [connected, setConnected] = useState<string | null>(sender ?? null), activeSender = sender ?? connected;
  const load = useMemo(() => () => source.loadGauge(activeSender ?? undefined), [source, activeSender]);
  const [state, retry] = useAsync(load, `gauge ${activeSender ?? "public"}`);
  const [selectedEpoch, setSelectedEpoch] = useState<number | null>(null);
  const contractScope = useMemo(() => ({ chainId: config.chainId, contract: config.gaugeContract, gaugeId: 0 as const }), [config.chainId, config.gaugeContract]);
  const persistedSubmissionPresent = (activeSender
    ? loadGaugeSubmission({ sender: activeSender, ...contractScope })
    : loadLatestGaugeSubmission(contractScope)) !== null;
  const navigate = useNavigate();
  const location = useLocation();
  const modalOpen = location.pathname !== "/gauge";
  // Persisted submission evidence must surface on arrival: open the workbench
  // modal once per page mount, exactly like the old force-open behavior. The
  // one-shot ref lets the user close the modal and stay on the page.
  const lockRedirected = useRef(false);
  useEffect(() => {
    if (lockRedirected.current || !persistedSubmissionPresent) return;
    lockRedirected.current = true;
    if (location.pathname === "/gauge") void navigate("vote", { replace: true });
  }, [persistedSubmissionPresent, location.pathname, navigate]);
  // Child modal routes own the document title while they are open.
  const pageMeta = modalOpen ? null : <PageMeta route="gauge" />;
  if (state.kind === "loading") return <main>{pageMeta}<State title="Loading gauge state…" detail="Verifying the gauge, voting module, Program Vault, registry, fixed epochs, and chain time." /></main>;
  if (state.kind === "error") return <main>{pageMeta}<State title="Gauge unavailable" detail={state.message}><button className="button" onClick={retry}>Retry gauge query</button></State></main>;
  const data = state.data, selected = data.epochs.find((epoch) => epoch.epochId === selectedEpoch) ?? data.current ?? data.previous;
  const outletContext: GaugeOutletContext = { data, source, config, transactionFlow, activeSender, setConnected, metadata };
  return <main>
    {pageMeta}
    <PageHeader
      eyebrow="HACK JUNO · EPOCH GAUGE"
      title="Weighted allocation"
      titleId="gauge-title"
      lede="Follow each fixed funding epoch from snapshot to outcome. Eligible Juno voting power can express project preferences while the epoch is open."
      actions={<Link className="button" to="vote">Open voting workbench</Link>}
      stats={[
        { label: "Gauge", value: "#0" },
        { label: "State", value: data.gauge.isStopped ? "Stopped" : data.current?.outcome === "open" ? "Epoch open" : "Ready" },
        { label: "Vault", value: juno(data.vaultBalance) },
      ]}
      statsLabel="Gauge summary"
    />
    {persistedSubmissionPresent && !modalOpen && <SubmissionEvidenceBanner to="vote" />}
    {data.gauge.isStopped ? <section className="notice danger" role="alert"><strong>Gauge stop is active.</strong> Opening, voting, and all epoch execution are disabled.</section> : data.adapterStopped ? <section className="notice danger" role="alert"><strong>Registry adapter stop is active.</strong> Opening, voting, and distribution-producing execution are disabled. No-turnout or no-candidate terminalization may remain available.</section> : null}
    <details className="concept-disclosure"><summary>How retained value and fixed options work</summary><div><p><code>do-not-distribute</code> intentionally keeps its share in the Program Vault. Unused preference weight, capped or unselected power, ineligible projects, failed turnout, and no-eligible-option outcomes also stay in the Vault.</p><p>Options and voting power are fixed at the epoch snapshot. Nothing shown here implies an automatic rollover or lets current registry state rewrite history.</p></div></details>
    <section className="epoch-index" aria-labelledby="epoch-history"><div className="toolbar"><div><p className="eyebrow">CANONICAL HISTORY</p><h2 id="epoch-history">Current and previous epochs</h2></div>{data.epochs.length > 0 && <label className="control-label">Epoch detail<select value={selected?.epochId ?? ""} onChange={(event) => setSelectedEpoch(Number(event.target.value))}>{[...data.epochs].reverse().map((epoch) => <option key={epoch.epochId} value={epoch.epochId}>Epoch {epoch.epochId} · {outcome(epoch)}</option>)}</select></label>}</div>
      {!selected ? <State title="No epoch has opened" detail="The verified mainnet gauge has no historical epoch. A public open is shown only when observed chain time, funding, and stop state permit it." /> : <EpochDetail epoch={selected} data={data} metadata={metadata} />}
    </section>
    {data.ballot && <section className="ballot-summary" aria-labelledby="ballot-summary-title"><div className="toolbar"><div><p className="eyebrow">YOUR CANONICAL RECORD</p><h2 id="ballot-summary-title">Current ballot</h2></div><span className="badge">{data.ballot.revisions ? `${data.ballot.revisions} revision${data.ballot.revisions === 1 ? "" : "s"}` : "Original ballot"}</span></div><div className="ballot-summary-grid"><Fact label="Snapshot power" value={juno(data.ballot.power)} /><Fact label="Cast" value={utc(data.ballot.castAt)} /><Fact label="Last revised" value={utc(data.ballot.revisedAt)} /></div><div className="allocation-list" aria-label="Your current gauge preferences">{data.ballot.votes.map((vote) => <div className="allocation-row" key={vote.option}><div><OptionName option={vote.option} data={data} metadata={metadata} /></div><span>{vote.weight} of 1.0 preference weight</span></div>)}</div></section>}
    <Outlet context={outletContext} />
    <details className="network-details"><summary>Gauge provenance <span>Direct RPC · fail closed</span></summary><div className="network-grid"><Fact label="Gauge contract" value={compact(config.gaugeContract)} /><Fact label="Gauge code ID" value={String(config.gaugeCodeId)} /><Fact label="Voting module" value={compact(config.votingContract)} /><Fact label="Program Vault" value={compact(config.vaultContract)} /><Fact label="Registry adapter" value={compact(data.gauge.adapter)} /><Fact label="Observation height" value={data.observationHeight.toLocaleString()} /></div><p>Epoch options and tallies come only from the epoch-scoped snapshot. Current registry records are never used to rewrite historical facts. Project names are fetched from the configured public IPFS gateway, which can observe the documents this browser requests.</p></details>
  </main>;
}

export function GaugeVoteRoute() {
  const { data, source, config, transactionFlow, activeSender, setConnected, metadata } = useOutletContext<GaugeOutletContext>();
  const close = useCloseModal("/gauge");
  return <Modal titleId="gauge-actions" onClose={close}>
    <PageMeta route="gauge/vote" />
    <GaugeWorkbench key={`${data.current?.epochId ?? "none"}:${data.ballot?.revisedAt ?? "none"}`} data={data} source={source}
      config={config} transactionFlow={transactionFlow} activeSender={activeSender} setConnected={setConnected} metadata={metadata} />
  </Modal>;
}

function EpochDetail({ epoch, data, metadata }: { epoch: Epoch; data: GaugeData; metadata?: MetadataClient }) {
  const isCurrent = data.current?.epochId === epoch.epochId, isPrevious = data.previous?.epochId === epoch.epochId;
  const options = isCurrent ? data.options : isPrevious ? data.previousOptions : [];
  return <article className="epoch-detail"><div className="epoch-heading"><div><span className="badge">{outcome(epoch)}</span><h3>Epoch {epoch.epochId}</h3></div><strong className="epoch-number">{String(epoch.epochId).padStart(2, "0")}</strong></div><div className="network-grid"><Fact label="Snapshot height" value={epoch.snapshotHeight.toLocaleString()} /><Fact label="Snapshot power" value={juno(epoch.snapshotTotalPower)} /><Fact label="Participating power" value={`${juno(epoch.participatingPower)} · ${percent(epoch.participatingPower, epoch.snapshotTotalPower)}`} /><Fact label="Allocated power" value={juno(epoch.allocatedPower)} /><Fact label="Unallocated power" value={juno(epoch.unallocatedPower)} /><Fact label="Retained-option power" value={juno(epoch.retainedOptionPower)} /><Fact label="Selected project power" value={juno(epoch.selectedProjectPower)} /><Fact label="Turnout floor" value={`${epoch.minTurnoutBps / 100}%`} /><Fact label="Fixed budget" value={juno(epoch.epochBudget)} /><Fact label="Emitted value" value={juno(epoch.emittedValue)} /><Fact label="Retained value" value={juno(epoch.retainedValue)} /><Fact label="Policy version" value={String(epoch.policyVersion)} /><Fact label="Opened" value={utc(epoch.opensAt)} /><Fact label="Closes" value={utc(epoch.closesAt)} /><Fact label="Execution deadline" value={utc(epoch.executionDeadline)} /><Fact label="Voters" value={String(epoch.voterCount)} /><Fact label="Fixed options" value={String(epoch.optionCount)} /></div>
    {options.length > 0 ? <div className="allocation-list" aria-label="Fixed epoch allocation tallies">{options.map(({ option, power }) => <div className="allocation-row" key={option}><div><OptionName option={option} data={data} metadata={metadata} /></div><span>{juno(power)} power · {percent(power, epoch.participatingPower)}</span></div>)}</div> : null}
    {options.length < epoch.optionCount && (epoch.cleanup.phase === "options" || epoch.cleanup.complete) ? <p className="notice" role="status">Bounded canonical cleanup removed {epoch.optionCount - options.length} fixed option/tally entr{epoch.optionCount - options.length === 1 ? "y" : "ies"}. Current registry options are intentionally not substituted.</p> : !isCurrent && !isPrevious ? <p className="notice" role="status">Only canonical current and previous epoch option snapshots are loaded. Historical summary facts remain fixed and authoritative.</p> : null}
    {epoch.outcome === "no_distribution_turnout" && <p className="notice">Turnout did not reach the fixed {epoch.minTurnoutBps / 100}% floor. The full budget remained in the Program Vault.</p>}
    {epoch.outcome === "no_distribution_zero_participation" && <p className="notice">No account cast a ballot in this epoch. The full budget remained in the Program Vault.</p>}
    {epoch.outcome === "no_eligible_options" && <p className="notice">No voted option survived execution-time eligibility and selection rules, or no positive ballot allocation existed. The full budget remained in the Program Vault.</p>}
    {epoch.outcome === "insufficient_funds" && epoch.insufficientFunds && <p className="notice danger">Execution required {juno(epoch.insufficientFunds.required)}, but only {juno(epoch.insufficientFunds.available)} was available. The epoch terminalized without sending funds; later top-ups cannot retry it.</p>}
    {epoch.outcome === "expired" && <p className="notice">The public execution deadline passed before terminal execution. The full budget remained in the Program Vault.</p>}
    {epoch.outcome === "aborted" && <p className="notice danger">The governor terminally aborted this epoch: {epoch.abortReason}</p>}
    {epoch.outcome === "distributed" && <p className="notice">Canonical state records {epoch.messageCount} distribution message{epoch.messageCount === 1 ? "" : "s"}, {juno(epoch.emittedValue)} emitted, and {juno(epoch.retainedValue)} retained.</p>}
  </article>;
}

function GaugeWorkbench({ data, source, config, transactionFlow, activeSender, setConnected, metadata }: { data: GaugeData; source: GaugeDataSource; config: AppConfig; transactionFlow?: GaugeTransactionFlow; activeSender: string | null; setConnected: (address: string) => void; metadata?: MetadataClient }) {
  const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries((data.ballot?.votes ?? []).map((vote) => [vote.option, vote.weight]))), [review, setReview] = useState<TransactionReview | null>(null), [reviewEvidence, setReviewEvidence] = useState<{ action: GaugeAction; epoch: number } | null>(null), [outcomeState, setOutcome] = useState<TransactionOutcome | null>(null), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const contractScope = useMemo(() => ({ chainId: config.chainId, contract: config.gaugeContract, gaugeId: 0 as const }), [config.chainId, config.gaugeContract]);
  const scope = useMemo(() => activeSender ? { sender: activeSender, ...contractScope } : null, [activeSender, contractScope]);
  const [storedSubmission, setStoredSubmission] = useState<StoredGaugeSubmission | null>(() => scope ? loadGaugeSubmission(scope) : loadLatestGaugeSubmission(contractScope));
  useEffect(() => setStoredSubmission(scope ? loadGaugeSubmission(scope) : loadLatestGaugeSubmission(contractScope)), [scope, contractScope]);
  const locked = storedSubmission !== null;
  const eligibility = gaugeEligibility({ data, fingerprint: "display" });
  const connect = async () => { if (!transactionFlow?.connect) return; setBusy(true); setError(null); try { setConnected((await transactionFlow.connect()).address); } catch (cause) { setError(cause instanceof Error ? cause.message : "Wallet connection failed."); } finally { setBusy(false); } };
  const prepare = async (action: GaugeAction) => { if (!transactionFlow || !activeSender || locked) return; setBusy(true); setError(null); setReview(null); setReviewEvidence(null); setOutcome(null); try { const context = await source.loadActionContext(activeSender), epoch = actionEpoch(action, context.data); if (!epoch || !Number.isSafeInteger(epoch)) throw new Error("Canonical gauge action epoch is unavailable."); const preferences: PreferenceInput[] = Object.entries(weights).filter(([, weight]) => weight.trim()).map(([option, weight]) => ({ option, weight: weight.trim() })); const prepared = await transactionFlow.prepare(buildGaugeIntent(config, activeSender, context, action, preferences)); setReview(prepared); setReviewEvidence({ action, epoch }); } catch (cause) { setError(cause instanceof Error ? cause.message : "Gauge transaction preparation failed."); } finally { setBusy(false); } };
  const submit = async () => { if (!transactionFlow || !review || !reviewEvidence || !scope) return; setBusy(true); setError(null); try { const submittedReview = review, submittedEvidence = reviewEvidence; const reviewedAction = gaugeActionFromReview(submittedReview.executeMessage); if (submittedReview.sender !== scope.sender || submittedReview.chainId !== scope.chainId || submittedReview.contract !== scope.contract || reviewedAction !== submittedEvidence.action || !Number.isSafeInteger(submittedEvidence.epoch) || submittedEvidence.epoch < 1) { markGaugeSubmissionUnavailable(scope); setStoredSubmission({ kind: "malformed" }); setReview(null); setReviewEvidence(null); return; } const preSubmissionEvidence = { version: 1 as const, ...scope, action: reviewedAction, epoch: submittedEvidence.epoch, status: "unknown" as const }; if (!saveGaugeSubmission(preSubmissionEvidence)) { setStoredSubmission({ kind: "malformed" }); setReview(null); setReviewEvidence(null); return; } setStoredSubmission({ kind: "uncertain", evidence: preSubmissionEvidence }); const runtimeResult: unknown = await transactionFlow.submit(submittedReview), status = runtimeTransactionStatus(runtimeResult); if (!status) { setOutcome(null); setStoredSubmission({ kind: "malformed" }); } else { const result = runtimeResult as TransactionOutcome; setOutcome(result); if (status === "pending" || status === "unknown") { const pendingResult = result as Extract<TransactionOutcome, { status: "pending" | "unknown" }>, evidence = { ...preSubmissionEvidence, status, ...(pendingResult.txHash ? { txHash: pendingResult.txHash } : {}), ...(pendingResult.explorerUrl ? { explorerUrl: pendingResult.explorerUrl } : {}) }; if (saveGaugeSubmission(evidence)) setStoredSubmission({ kind: "uncertain", evidence }); else { setStoredSubmission({ kind: "malformed" }); setOutcome(null); } } else if ((status === "confirmed" || status === "failed" || status === "rejected") && clearGaugeSubmission(scope)) setStoredSubmission(null); else { setStoredSubmission({ kind: "malformed" }); setOutcome(null); } } setReview(null); setReviewEvidence(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "Gauge transaction submission failed."); setReview(null); setReviewEvidence(null); } finally { setBusy(false); } };
  const persistedEvidence = storedSubmission?.kind === "uncertain" ? storedSubmission.evidence : null;
  const visibleEvidence = outcomeState && "txHash" in outcomeState && outcomeState.txHash && outcomeState.explorerUrl ? { txHash: outcomeState.txHash, explorerUrl: outcomeState.explorerUrl } : persistedEvidence?.txHash && persistedEvidence.explorerUrl ? { txHash: persistedEvidence.txHash, explorerUrl: persistedEvidence.explorerUrl } : null;
  const restoredNotice = !outcomeState && storedSubmission ? <p className="notice" role="status">{storedSubmission.kind === "malformed" ? "Stored gauge submission evidence is malformed or unavailable. Preparation remains locked; inspect this account and pinned gauge on Juno and do not submit again." : storedSubmission.evidence.txHash ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again." : "Submission was invoked and signing may have begun, but no transaction hash is available. Do not submit again until you inspect this account and pinned gauge on Juno."}</p> : null;
  return <section id="gauge-workbench" className="workbench protocol-workbench gauge-workbench" aria-labelledby="gauge-actions"><div className="workbench-heading"><div><p className="eyebrow">GAUGE ACTIONS · REVIEW BEFORE SIGNING</p><h2 id="gauge-actions">Choose a gauge action</h2></div><span className="step-marker">01 · CHOOSE</span></div><p>Choose how you want to participate. Juno Voice checks the current epoch, your snapshot power, and the fixed funding rules before showing a wallet review.</p>
    {activeSender && <p className="notice" role="status">Connected account: {compact(activeSender)}{data.current && <> · snapshot power {data.votingPower ? juno(data.votingPower.power) : "unavailable"}</>}</p>}
    {data.current?.outcome === "open" && <fieldset className="preference-editor" disabled={locked || busy || !eligibility.vote}><legend>Complete weighted ballot</legend><p className="editor-intro">Use decimals between 0 and 1. For example, <strong>0.25 means 25%</strong>. The combined total may not exceed 1.0.</p>{data.options.map(({ option }) => <label key={option}><span><OptionName option={option} data={data} metadata={metadata} /></span><span className="weight-input"><input inputMode="decimal" aria-label={`Weight for ${option}`} placeholder="0.00" value={weights[option] ?? ""} onChange={(event) => { setWeights((current) => ({ ...current, [option]: event.target.value })); setReview(null); }} /><small>of 1.0</small></span></label>)}<p>Positive unique weights · maximum 18 decimal places · total ≤ 1 · every weighted power allocation must be nonzero.</p></fieldset>}
    <details className="workbench-help"><summary>How are preferences turned into allocations?</summary><p>Your fixed snapshot power is split by these weights. Turnout, option eligibility, caps, and execution rules determine the final outcome; a preference is not a promised project payout.</p></details>
    {!transactionFlow ? <p className="notice" role="status">Supported Keplr or Leap transaction support is unavailable in this browser. Gauge history remains public.</p> : !activeSender ? <button className="button" disabled={busy || !transactionFlow.connect} onClick={connect}>{busy ? "Connecting wallet…" : "Connect wallet"}</button> : <div className="gauge-actions">{eligibility.open && <button className="button" disabled={busy || locked} onClick={() => prepare("open_epoch")}>Prepare open epoch</button>}{data.current?.outcome === "open" && <button className="button" disabled={busy || locked || !eligibility.vote} onClick={() => prepare("place_votes")}>{data.ballot ? "Prepare ballot revision" : "Prepare ballot"}</button>}{data.ballot && eligibility.vote && <button className="button secondary" disabled={busy || locked} onClick={() => prepare("remove_votes")}>Prepare ballot removal</button>}{eligibility.execute && <button className="button" disabled={busy || locked} onClick={() => prepare("execute")}>Prepare epoch execution</button>}{eligibility.expire && <button className="button" disabled={busy || locked} onClick={() => prepare("expire_epoch")}>Prepare epoch expiry</button>}{!eligibility.open && !eligibility.vote && !eligibility.execute && !eligibility.expire && <p className="notice">No public gauge action is eligible in the observed chain state and time.</p>}</div>}
    {error && <p className="notice danger" role="alert">{error}</p>}
    {review && <Modal titleId="gauge-review-title" onClose={() => setReview(null)} closeDisabled={busy} closeLabel="Cancel review"><h3 id="gauge-review-title">Exact transaction review</h3><p>No wallet signature has been requested. Verify the exact message and empty funds before continuing.</p><pre>{JSON.stringify({ sender: review.sender, chainId: review.chainId, contract: review.contract, msg: review.executeMessage, ...userFacingTransactionAmounts(review), consequences: review.consequences, canonicalState: review.canonicalState }, null, 2)}</pre><div className="gauge-actions"><button className="button" disabled={busy} onClick={submit}>{busy ? "Rechecking canonical state…" : "Recheck state, then sign"}</button></div></Modal>}
    {persistedEvidence && <p className="notice" role="status"><strong>Action: {actionLabel(persistedEvidence.action)} · Epoch {persistedEvidence.epoch}</strong></p>}
    {outcomeState && <p className="notice" role="status">{outcomeState.status === "confirmed" ? `Confirmed at height ${outcomeState.height}. Canonical state ${outcomeState.refreshStatus}.` : outcomeState.status === "failed" || outcomeState.status === "rejected" ? outcomeState.reason : outcomeState.txHash ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again." : "Submission was invoked and signing may have begun, but no transaction hash is available. Do not submit again until you inspect this account and pinned gauge on Juno."}</p>}
    {restoredNotice}
    {visibleEvidence && <p><a href={visibleEvidence.explorerUrl} target="_blank" rel="noopener noreferrer">View transaction evidence {visibleEvidence.txHash}</a></p>}
  </section>;
}
export default GaugeVoting;
