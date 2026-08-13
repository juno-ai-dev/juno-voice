import { useId, useRef, useState } from "react";
import { contributeIntent, createBountyIntent, type EligibilityState } from "./bountyFlows";
import type { Bounty, Contribution } from "./types";
import type { TransactionIntent, TransactionOutcome, TransactionReview } from "./transactions";
import { runtimeTransactionOutcome } from "./transactionOutcome";
import { cancelSoleFundedIntent, claimRefundIntent, confirmSolePayoutIntent, declineSolePayoutIntent,
  expireBountyIntent, finalizePayoutIntent, nominatePayoutIntent, type SettlementState,
  votePayoutIntent } from "./settlementFlows";
import { formatJuno, formatJunoCoin } from "./junoAmount";
import { DEFAULT_CHAIN_ID } from "./config";
import { bountyActionFromReview, clearBountySubmission, loadLatestBountySubmission,
  saveBountySubmission, type StoredBountySubmission } from "./bountySubmissionState";
import "./bounty.css";

export interface BountyTransactionAccess {
  connect(): Promise<{ address: string }>;
  prepare(intent: TransactionIntent): Promise<TransactionReview>;
  submit(review: TransactionReview): Promise<TransactionOutcome>;
}
type ReviewState = { review: TransactionReview; submitting: boolean } | null;
export function BountyActions({ canonical, access, stale, bountyContract, bounty, contributions = [], settlement }: {
  canonical: EligibilityState; access?: BountyTransactionAccess; stale: boolean;
  bountyContract: string;
  bounty?: Bounty; contributions?: readonly Contribution[]; settlement?: SettlementState;
}) {
  const [creating, setCreating] = useState(false);
  const [review, setReview] = useState<ReviewState>(null);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<{ hash: string; url: string; confirmed: boolean } | null>(null);
  const preparedExpectation = useRef<{ sender: string; action: string } | null>(null);
  const contractScope = { chainId: DEFAULT_CHAIN_ID, contract: bountyContract };
  const [storedSubmission, setStoredSubmission] = useState<StoredBountySubmission | null>(() => loadLatestBountySubmission(contractScope));
  const submissionLocked = storedSubmission !== null;
  const act = async (make: (sender: string) => TransactionIntent) => {
    setMessage("");
    if (submissionLocked) return setMessage("This action is locked because an earlier submission is not canonically confirmed.");
    if (!access) return setMessage("Wallet transaction support is unavailable; the public ledger remains fully readable.");
    if (stale) return setMessage("Canonical state is stale. Refresh the ledger before preparing a transaction.");
    try {
      // Re-read the extension account for every new review. The transaction
      // flow performs another identity check immediately before signing.
      const sender = (await access.connect()).address;
      const intent = make(sender), action = Object.keys(intent.executeMessage);
      if (action.length !== 1) throw new Error("Transaction preparation produced an invalid action.");
      const prepared = await access.prepare(intent);
      preparedExpectation.current = { sender, action: action[0] };
      setReview({ review: prepared, submitting: false });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction preparation failed."); }
  };
  const submit = async () => {
    if (!access || !review) return;
    setReview({ ...review, submitting: true }); setMessage("");
    const submittedReview = review.review;
    const action = bountyActionFromReview(submittedReview, contractScope);
    const scope = { sender: submittedReview.sender, ...contractScope };
    const expected = preparedExpectation.current;
    if (!action || !expected || submittedReview.sender !== expected.sender || action !== expected.action) {
      setMessage("Prepared transaction no longer matches the requested account and action. Nothing was submitted.");
      setReview(null); return;
    }
    const preSubmissionEvidence = { version: 1 as const, ...scope, action, status: "unknown" as const };
    if (!saveBountySubmission(preSubmissionEvidence)) {
      setStoredSubmission({ kind: "malformed" }); setReview(null); return;
    }
    setStoredSubmission({ kind: "uncertain", evidence: preSubmissionEvidence });
    try {
      const runtimeResult: unknown = await access.submit(submittedReview), result = runtimeTransactionOutcome(runtimeResult);
      if (!result) { setMessage("Stored submission evidence is malformed or unavailable. This action remains locked; inspect this account on Juno and do not submit again."); setReview(null); return; }
      const status = result.status;
      setMessage(result.status === "confirmed" ? `Confirmed at height ${result.height}. Canonical state ${result.refreshStatus}.` :
        result.status === "failed" ? `Raw chain error: ${result.reason} Review the canonical bounty and account state before preparing a corrected transaction.` :
          result.status === "rejected" ? result.reason : result.txHash
          ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again."
          : "Signing began and submission may have occurred, but no transaction hash is available. Do not submit again until you inspect this account on Juno.");
      if ("txHash" in result && result.txHash && result.explorerUrl)
        setReceipt({ hash: result.txHash, url: result.explorerUrl, confirmed: result.status === "confirmed" });
      if (status === "pending" || status === "unknown") {
        const uncertain = result as Extract<TransactionOutcome, { status: "pending" | "unknown" }>;
        const evidence = { ...preSubmissionEvidence, status, ...(uncertain.txHash ? { txHash: uncertain.txHash } : {}),
          ...(uncertain.explorerUrl ? { explorerUrl: uncertain.explorerUrl } : {}) };
        if (saveBountySubmission(evidence)) setStoredSubmission({ kind: "uncertain", evidence });
        else setStoredSubmission({ kind: "malformed" });
      } else if (clearBountySubmission(scope)) setStoredSubmission(null);
      setReview(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction submission failed; signing may have begun. Do not submit again."); setReview(null); }
  };
  const persistedEvidence = storedSubmission?.kind === "uncertain" ? storedSubmission.evidence : null;
  const restoredNotice = !message && storedSubmission ? (storedSubmission.kind === "malformed"
    ? "Stored submission evidence is malformed or unavailable. This action remains locked; inspect this account on Juno and do not submit again."
    : storedSubmission.evidence.txHash ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again."
    : "Signing began and submission may have occurred, but no transaction hash is available. Do not submit again until you inspect this account on Juno.") : "";
  if (!bounty && !creating) return <section className="bounty-create-launcher" aria-labelledby="create-launcher-title">
    <div>
      <p className="eyebrow">FUND A SHARED OUTCOME</p>
      <h2 id="create-launcher-title">Have work the community can rally around?</h2>
      <p>Define the outcome and fund the first contribution. You will review the exact on-chain terms before signing.</p>
    </div>
    <button className="button" type="button" aria-expanded="false" aria-controls="create-bounty-panel"
      onClick={() => setCreating(true)}>Create a bounty</button>
  </section>;
  return <section id={!bounty ? "create-bounty-panel" : undefined} className="action-panel"
    aria-labelledby={bounty ? settlement ? "settlement-title" : "contribute-title" : "create-title"}>
    {!bounty && <div className="action-panel-heading">
      <div><p className="eyebrow">CREATE BOUNTY</p><p>Complete the essentials first. Optional metadata stays out of the way until you need it.</p></div>
      <button className="button secondary" type="button" onClick={() => { setCreating(false); setReview(null); setMessage(""); }}>Close form</button>
    </div>}
    <p className="eyebrow">OPTIONAL WALLET ACTION · READ BEFORE SIGNING</p>
    {bounty ? <>{bounty.status === "open" && BigInt(canonical.chainTimeNanos) < BigInt(bounty.expires_at) &&
      <ContributeForm bounty={bounty} disabled={submissionLocked} onPrepare={(value) => act((sender) =>
        contributeIntent(bounty, value, sender, contributions.map((item) => item.contributor), canonical, bountyContract))} />}
      {settlement && <SettlementControls state={settlement} bountyContract={bountyContract} disabled={submissionLocked} onPrepare={(make) => act(make)} />}</> :
      <CreateForm canonical={canonical} disabled={submissionLocked} onPrepare={(input) => act(() => createBountyIntent(input, canonical, bountyContract))} />}
    {bounty && <p className="chain-time">Deadlines are checked against Juno network time.</p>}
    {!access && <p>Wallet actions are unavailable in this environment. Browsing does not require a wallet.</p>}
    {(message || restoredNotice) && <p role="status" className="notice">{message || restoredNotice}</p>}
    {(receipt || (persistedEvidence?.txHash && persistedEvidence.explorerUrl ? { hash: persistedEvidence.txHash, url: persistedEvidence.explorerUrl, confirmed: false } : null)) && <p><a href={(receipt ?? { hash: persistedEvidence!.txHash!, url: persistedEvidence!.explorerUrl!, confirmed: false }).url} target="_blank" rel="noopener noreferrer">
      View {(receipt ?? { hash: persistedEvidence!.txHash!, url: persistedEvidence!.explorerUrl!, confirmed: false }).confirmed ? "confirmed transaction" : "transaction evidence"} {(receipt ?? { hash: persistedEvidence!.txHash!, url: persistedEvidence!.explorerUrl!, confirmed: false }).hash}
    </a></p>}
    {review && <TransactionReviewPanel value={review.review} busy={review.submitting} onCancel={() => setReview(null)} onSubmit={submit} />}
  </section>;
}
function CreateForm({ canonical, disabled, onPrepare }: { canonical: EligibilityState; disabled: boolean; onPrepare: (input: Parameters<typeof createBountyIntent>[0]) => void }) {
  const now = BigInt(canonical.chainTimeNanos);
  const minLifetime = BigInt(canonical.config.min_lifetime_seconds);
  const maxLifetime = BigInt(canonical.config.max_lifetime_seconds);
  const nanosPerSecond = 1_000_000_000n;
  const nanosPerMillisecond = 1_000_000n;
  const minExpiry = now + minLifetime * nanosPerSecond;
  const maxExpiry = now + maxLifetime * nanosPerSecond;
  // datetime-local is only a human input affordance. Round the display bounds
  // inward so every selectable millisecond remains within the exact chain window.
  const minExpiryMillis = (minExpiry + nanosPerMillisecond - 1n) / nanosPerMillisecond;
  const maxExpiryMillis = maxExpiry / nanosPerMillisecond;
  const defaultLifetime = minLifetime + (maxLifetime - minLifetime) / 2n;
  const defaultExpiryMillis = (now + defaultLifetime * nanosPerSecond + nanosPerMillisecond - 1n) / nanosPerMillisecond;
  const [expiry, setExpiry] = useState(() => localDateTimeValue(defaultExpiryMillis));
  const [expiryError, setExpiryError] = useState("");
  const expiresAtNanos = localDateTimeToNanos(expiry);
  const expiryHintId = useId();
  return <form className="create-bounty-form" onSubmit={(event) => {
    event.preventDefault();
    const exactExpiry = localDateTimeToNanos(expiry);
    if (!exactExpiry) return setExpiryError("Choose a valid expiration date and time.");
    setExpiryError("");
    const f = new FormData(event.currentTarget); onPrepare({
    title: String(f.get("title")), summary: String(f.get("summary")), acceptanceCriteria: String(f.get("criteria")),
    contentUri: String(f.get("uri")), contentDigest: String(f.get("digest")), expiresAtNanos: exactExpiry, initialJuno: String(f.get("amount")),
    ...(["projectUri", "projectDigest"].some((name) => String(f.get(name)).trim()) ? { projectCandidate: {
      metadataUri: String(f.get("projectUri")), metadataDigest: String(f.get("projectDigest")),
    } } : {}),
  }); }}>
    <h2 id="create-title">Create a bounty</h2>
    <p className="form-intro">Describe a specific outcome and seed its escrow. Limits come from live config version {canonical.config.version}; nothing is signed on this screen.</p>
    <fieldset className="form-section">
      <legend>1. Bounty essentials</legend>
      <div className="action-grid">
        <label>Title<span className="field-hint">A short, outcome-focused name · {canonical.config.limits.max_title_bytes} bytes max</span><input name="title" placeholder="e.g. Ship a Juno developer quickstart" required /></label>
        <label>Initial funding ($JUNO)<span className="field-hint">Escrowed with the bounty · up to 6 decimal places</span><input name="amount" inputMode="decimal" pattern="(0|[1-9][0-9]*)(\.[0-9]{1,6})?" defaultValue={formatJuno(canonical.config.min_contribution).slice(6).replaceAll(",", "")} required /></label>
        <label className="wide">Summary<span className="field-hint">Give contributors enough context to understand why this matters.</span><textarea name="summary" placeholder="What should be built, researched, or delivered?" required /></label>
        <label className="wide">Acceptance criteria<span className="field-hint">Use observable conditions contributors can evaluate during settlement.</span><textarea name="criteria" placeholder="List the evidence that will count as complete." required /></label>
        <label className="wide">Expiration date and time<span className="field-hint" id={expiryHintId}>Shown in your local time. Select between {formatLocalDateTime(minExpiryMillis)} and {formatLocalDateTime(maxExpiryMillis)}.</span>
          <input name="expiryDisplay" type="datetime-local" step="1" min={localDateTimeValue(minExpiryMillis)} max={localDateTimeValue(maxExpiryMillis)}
            value={expiry} aria-describedby={expiryHintId} aria-invalid={Boolean(expiryError)} onChange={(event) => setExpiry(event.target.value)} required />
        </label>
        <div className="expiry-preview wide" aria-live="polite">
          <span>On-chain expiration</span>
          <strong>{expiresAtNanos ? `${expiresAtNanos} ns` : "Choose a valid date and time"}</strong>
          <small>Converted exactly at review time. Eligibility still uses canonical chain time, not your device clock.</small>
          {expiryError && <small className="field-error">{expiryError}</small>}
        </div>
      </div>
    </fieldset>
    <details className="form-disclosure">
      <summary>Add supporting content <span>Optional</span></summary>
      <p>Link to a brief, specification, or other stable content. The URI and its SHA-256 digest must be provided together.</p>
      <div className="action-grid">
        <label>Content URI<span className="field-hint">HTTPS or IPFS</span><input name="uri" type="url" placeholder="ipfs://… or https://…" /></label>
        <HashDigestField name="digest" label="Content SHA-256 digest" fileLabel="Calculate content digest from file" />
      </div>
    </details>
    <details className="form-disclosure">
      <summary>Propose a project candidate <span>Optional</span></summary>
      <div className="disclosure-help">
        <strong>What is a project candidate?</strong>
        <p>It links this bounty to proposed project metadata. A candidate is only a proposal: creating the bounty does not allocate a registry ID, endorse, or graduate the project. Graduation is a separate authorized action; the registry assigns the numeric ID atomically.</p>
      </div>
      <div className="action-grid">
        <label>Project metadata URI<span className="field-hint">HTTPS or IPFS; required with a candidate</span><input name="projectUri" type="url" placeholder="ipfs://… or https://…" /></label>
        <div className="wide"><HashDigestField name="projectDigest" label="Project metadata SHA-256 digest" fileLabel="Calculate project metadata digest from file" /></div>
      </div>
    </details>
    <div className="form-submit-row"><div><strong>Ready for the safety check?</strong><small>You will see the exact message, funds, fee, and consequences before signing.</small></div>
      <button className="button" type="submit" disabled={disabled}>Connect wallet and review bounty</button></div>
  </form>;
}

const localDateTimeValue = (milliseconds: bigint) => {
  const date = new Date(Number(milliseconds));
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}T${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
};

const formatLocalDateTime = (milliseconds: bigint) => new Date(Number(milliseconds)).toLocaleString([], {
  dateStyle: "medium", timeStyle: "short",
});

const localDateTimeToNanos = (value: string) => {
  if (!/^\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value)) return null;
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? (BigInt(milliseconds) * 1_000_000n).toString() : null;
};

function HashDigestField({ name, label, fileLabel }: { name: string; label: string; fileLabel: string }) {
  const [digest, setDigest] = useState("");
  const [hashStatus, setHashStatus] = useState("");
  const hashGeneration = useRef(0);
  const hintId = useId();
  const hashFile = async (file?: File) => {
    const generation = ++hashGeneration.current;
    if (!file) return setHashStatus("");
    if (file.size > 20 * 1024 * 1024) return setHashStatus("Choose a file no larger than 20 MB, or paste its digest instead.");
    if (!globalThis.crypto?.subtle) return setHashStatus("File hashing is unavailable in this browser. Paste a verified digest instead.");
    setHashStatus(`Calculating SHA-256 for ${file.name}…`);
    try {
      const bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
      if (generation !== hashGeneration.current) return;
      const value = `sha256:${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      setDigest(value);
      setHashStatus(`Digest calculated locally from ${file.name}. The file was not uploaded.`);
    } catch {
      if (generation !== hashGeneration.current) return;
      setHashStatus("This file could not be hashed. Paste a verified digest instead.");
    }
  };
  return <div className="hash-field">
    <label>{label}<span className="field-hint" id={hintId}>Paste a sha256: digest, or calculate it from the exact file published at the URI.</span>
      <input name={name} value={digest} onChange={(event) => { hashGeneration.current += 1; setDigest(event.target.value); setHashStatus(""); }}
        pattern="sha256:[0-9a-f]{64}" placeholder="sha256:…" spellCheck={false} autoComplete="off" aria-describedby={hintId} />
    </label>
    <label className="file-picker">{fileLabel}<input type="file" onChange={(event) => void hashFile(event.target.files?.[0])} /></label>
    {hashStatus && <small className="hash-status" role="status">{hashStatus}</small>}
  </div>;
}
function ContributeForm({ bounty, disabled, onPrepare }: { bounty: Bounty; disabled: boolean; onPrepare: (amount: string) => void }) {
  return <form onSubmit={(event) => { event.preventDefault(); onPrepare(String(new FormData(event.currentTarget).get("amount"))); }}>
    <h2 id="contribute-title">Contribute to bounty #{bounty.id}</h2>
    <label>Contribution ($JUNO)<input name="amount" inputMode="decimal" pattern="(0|[1-9][0-9]*)(\.[0-9]{1,6})?" required /></label>{" "}
    <button className="button" type="submit" disabled={disabled}>Connect and review contribution</button>
  </form>;
}
function SettlementControls({ state, bountyContract, disabled, onPrepare }: {
  state: SettlementState; bountyContract: string; disabled: boolean;
  onPrepare: (make: (sender: string) => TransactionIntent) => void;
}) {
  const b = state.bounty, round = state.activeRound, now = BigInt(state.chainTimeNanos);
  const closed = Boolean(round?.closes_at && now >= BigInt(round.closes_at));
  return <div aria-labelledby="settlement-title">
    <h2 id="settlement-title">Contributor-controlled settlement</h2>
    <p>All actor, state, round, and deadline checks use the canonical detail shown below and are rechecked immediately before signing.</p>
    {b.status === "open" && now < BigInt(b.expires_at) && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget);
      onPrepare((sender) => nominatePayoutIntent(state, sender, { recipient: String(f.get("recipient")),
        evidenceUri: String(f.get("evidenceUri")), evidenceDigest: String(f.get("evidenceDigest")), rationale: String(f.get("nominationRationale")) }, bountyContract)); }}>
      <h3>Nominate payout</h3><p>The public control is creator-only; no agent or governor controls are exposed.</p>
      <div className="action-grid">
        <label>Recipient Juno address<input name="recipient" required /></label>
        <label>Evidence URI (HTTPS/IPFS)<input name="evidenceUri" required /></label>
        <label className="wide">Evidence digest (sha256: + 64 lowercase hex)<input name="evidenceDigest" pattern="sha256:[0-9a-f]{64}" required /></label>
        <label className="wide">Nomination rationale<textarea name="nominationRationale" required /></label>
      </div><button className="button" type="submit" disabled={disabled}>Review payout nomination</button>
    </form>}
    {b.status === "open" && b.contributor_count === 1 && <ReasonForm label="Cancel sole-funded bounty" field="cancelReason"
      button="Review cancellation" disabled={disabled} onSubmit={(reason) => onPrepare((sender) => cancelSoleFundedIntent(state, sender, reason, bountyContract))} />}
    {b.status === "open" && now >= BigInt(b.expires_at) && <button className="button" disabled={disabled}
      onClick={() => onPrepare(() => expireBountyIntent(state, bountyContract))}>Review public expiry</button>}
    {b.status === "single_confirmation" && round && <section aria-labelledby="sole-decision-title">
      <h3 id="sole-decision-title">Sole-contributor decision · round {round.number}</h3>
      <p className="chain-time">Confirm or decline before close {round.closes_at} ns and expiry {b.expires_at} ns. Equality is closed.</p>
      {!closed && now < BigInt(b.expires_at) && <><button className="button" disabled={disabled}
        onClick={() => onPrepare((sender) => confirmSolePayoutIntent(state, sender, round.number, bountyContract))}>Review sole payout confirmation</button>
        <ReasonForm label="Decline nominated payout" field="declineReason" button="Review decline" disabled={disabled}
          onSubmit={(reason) => onPrepare((sender) => declineSolePayoutIntent(state, sender, round.number, reason, bountyContract))} /></>}
    </section>}
    {b.status === "ratifying" && round && <section aria-labelledby="ballot-title">
      <h3 id="ballot-title">Weighted ballot · round {round.number}</h3>
      <p>YES {formatJuno(round.yes_weight)} · NO {formatJuno(round.no_weight)} · {round.voter_count} voter(s).</p>
      <p className="chain-time">Ballots close at exactly {round.closes_at} ns. Equality is closed; weights are snapshotted and revisions replace the prior ballot.</p>
      {!closed && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget);
        onPrepare((sender) => votePayoutIntent(state, sender, round.number, String(f.get("vote")) as "yes" | "no", String(f.get("voteRationale")), bountyContract)); }}>
        <fieldset><legend>Ballot choice</legend><label><input type="radio" name="vote" value="yes" required /> YES</label>{" "}
          <label><input type="radio" name="vote" value="no" required /> NO</label></fieldset>
        <label>Ballot rationale (optional)<textarea name="voteRationale" /></label>
        <button className="button" type="submit" disabled={disabled}>Review or revise ballot</button>
      </form>}
    </section>}
    {(b.status === "ratifying" || b.status === "single_confirmation") && round && closed && <button className="button" disabled={disabled}
      onClick={() => onPrepare(() => finalizePayoutIntent(state, round.number, bountyContract))}>Review public finalization</button>}
    {b.status === "refunding" && <button className="button" disabled={disabled}
      onClick={() => onPrepare((sender) => claimRefundIntent(state, sender, bountyContract))}>Review contributor refund claim</button>}
    {b.status === "paid" && <p>Settlement is complete: the nominated payout was paid.</p>}
    {b.status === "refunded" && <p>Settlement is complete: all contributor refunds were claimed.</p>}
  </div>;
}
function ReasonForm({ label, field, button, disabled, onSubmit }: {
  label: string; field: string; button: string; disabled: boolean; onSubmit: (reason: string) => void;
}) {
  return <form onSubmit={(event) => { event.preventDefault(); onSubmit(String(new FormData(event.currentTarget).get(field))); }}>
    <label>{label}<textarea name={field} required /></label>
    <button className="button" type="submit" disabled={disabled}>{button}</button>
  </form>;
}
function TransactionReviewPanel({ value, busy, onCancel, onSubmit }: { value: TransactionReview; busy: boolean; onCancel: () => void; onSubmit: () => void }) {
  return <section className="review" role="dialog" aria-modal="true" aria-labelledby="review-title">
    <h2 id="review-title">Exact transaction review</h2><p>Nothing is signed until you select the final button.</p>
    <dl><dt>Sender</dt><dd>{value.sender}</dd><dt>Contract</dt><dd>{value.contract}</dd><dt>Message</dt><dd><code>{JSON.stringify(value.executeMessage)}</code></dd>
      <dt>Attached funds</dt><dd>{value.funds.length ? value.funds.map(formatJunoCoin).join(", ") : "None"}</dd><dt>Estimated fee</dt><dd>{value.fee.amount.map(formatJunoCoin).join(", ")} · gas {value.fee.gas}</dd><dt>Canonical height</dt><dd>{value.canonicalState.height}</dd></dl>
    <ul>{value.consequences.map((item) => <li key={item}>{item}</li>)}</ul>
    <button className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button>{" "}<button className="button" onClick={onSubmit} disabled={busy}>{busy ? "Checking canonical state…" : "Recheck state, then sign"}</button>
  </section>;
}
