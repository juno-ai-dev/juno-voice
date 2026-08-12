import { useState } from "react";
import { contributeIntent, createBountyIntent, type EligibilityState } from "./bountyFlows";
import type { Bounty, Contribution } from "./types";
import type { TransactionIntent, TransactionOutcome, TransactionReview } from "./transactions";
import { cancelSoleFundedIntent, claimRefundIntent, confirmSolePayoutIntent, declineSolePayoutIntent,
  expireBountyIntent, finalizePayoutIntent, nominatePayoutIntent, type SettlementState,
  votePayoutIntent } from "./settlementFlows";

export interface BountyTransactionAccess {
  connect(): Promise<{ address: string }>;
  prepare(intent: TransactionIntent): Promise<TransactionReview>;
  submit(review: TransactionReview): Promise<TransactionOutcome>;
}
type ReviewState = { review: TransactionReview; submitting: boolean } | null;

export function BountyActions({ canonical, access, stale, bounty, contributions = [], settlement }: {
  canonical: EligibilityState; access?: BountyTransactionAccess; stale: boolean;
  bounty?: Bounty; contributions?: readonly Contribution[]; settlement?: SettlementState;
}) {
  const [address, setAddress] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewState>(null);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<{ hash: string; url: string; confirmed: boolean } | null>(null);
  const [submissionLocked, setSubmissionLocked] = useState(false);
  const act = async (make: (sender: string) => TransactionIntent) => {
    setMessage("");
    if (submissionLocked) return setMessage("This action is locked because an earlier submission is not canonically confirmed.");
    if (!access) return setMessage("Wallet transaction support is unavailable; the public ledger remains fully readable.");
    if (stale) return setMessage("Canonical state is stale. Refresh the ledger before preparing a transaction.");
    try {
      const sender = address ?? (await access.connect()).address;
      setAddress(sender);
      setReview({ review: await access.prepare(make(sender)), submitting: false });
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction preparation failed."); }
  };
  const submit = async () => {
    if (!access || !review) return;
    setReview({ ...review, submitting: true }); setMessage("");
    try {
      const result = await access.submit(review.review);
      setMessage(result.status === "confirmed" ? `Confirmed at height ${result.height}. Canonical state ${result.refreshStatus}.` :
        result.status === "failed" ? `Raw chain error: ${result.reason} Review the canonical bounty and account state before preparing a corrected transaction.` :
          result.status === "rejected" ? result.reason : result.txHash
          ? "Submission is not canonically confirmed. Use the transaction evidence below and do not submit again."
          : "Signing began and submission may have occurred, but no transaction hash is available. Do not submit again until you inspect this account on Juno.");
      if ("txHash" in result && result.txHash && result.explorerUrl)
        setReceipt({ hash: result.txHash, url: result.explorerUrl, confirmed: result.status === "confirmed" });
      if (result.status === "pending" || result.status === "unknown") setSubmissionLocked(true);
      setReview(null);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Transaction was blocked before signing."); setReview(null); }
  };
  return <section className="action-panel" aria-labelledby={bounty ? settlement ? "settlement-title" : "contribute-title" : "create-title"}>
    <p className="eyebrow">OPTIONAL WALLET ACTION · READ BEFORE SIGNING</p>
    {bounty ? <>{bounty.status === "open" && BigInt(canonical.chainTimeNanos) < BigInt(bounty.expires_at) &&
      <ContributeForm bounty={bounty} disabled={submissionLocked} onPrepare={(value) => act((sender) =>
        contributeIntent(bounty, value, sender, contributions.map((item) => item.contributor), canonical))} />}
      {settlement && <SettlementControls state={settlement} disabled={submissionLocked} onPrepare={(make) => act(make)} />}</> :
      <CreateForm canonical={canonical} disabled={submissionLocked} onPrepare={(input) => act(() => createBountyIntent(input, canonical))} />}
    <p className="chain-time">Eligibility uses canonical chain time {canonical.chainTimeNanos} ns, never browser time.</p>
    {!access && <p>Wallet actions are unavailable in this environment. Browsing does not require a wallet.</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {receipt && <p><a href={receipt.url} target="_blank" rel="noopener noreferrer">
      View {receipt.confirmed ? "confirmed transaction" : "transaction evidence"} {receipt.hash}
    </a></p>}
    {review && <TransactionReviewPanel value={review.review} busy={review.submitting} onCancel={() => setReview(null)} onSubmit={submit} />}
  </section>;
}
function CreateForm({ canonical, disabled, onPrepare }: { canonical: EligibilityState; disabled: boolean; onPrepare: (input: Parameters<typeof createBountyIntent>[0]) => void }) {
  const now = BigInt(canonical.chainTimeNanos);
  const minLifetime = BigInt(canonical.config.min_lifetime_seconds);
  const maxLifetime = BigInt(canonical.config.max_lifetime_seconds);
  // Avoid producing a value that falls below the minimum while the user is
  // completing the form, while retaining an exact nanosecond timestamp.
  const defaultLifetime = minLifetime + (maxLifetime - minLifetime) / 2n;
  const defaultExpiry = (now + defaultLifetime * 1_000_000_000n).toString();
  return <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget); onPrepare({
    title: String(f.get("title")), summary: String(f.get("summary")), acceptanceCriteria: String(f.get("criteria")),
    contentUri: String(f.get("uri")), contentDigest: String(f.get("digest")), expiresAtNanos: String(f.get("expiry")), initialUjuno: String(f.get("amount")),
    ...(["projectId", "projectUri", "projectDigest"].some((name) => String(f.get(name)).trim()) ? { projectCandidate: {
      projectId: String(f.get("projectId")), metadataUri: String(f.get("projectUri")), metadataDigest: String(f.get("projectDigest")),
    } } : {}),
  }); }}>
    <h2 id="create-title">Create a bounty</h2><p>All limits come from live config version {canonical.config.version}. Amounts are exact ujuno.</p>
    <div className="action-grid">
      <label>Title<input name="title" required /></label><label>Initial contribution (ujuno)<input name="amount" inputMode="numeric" pattern="[1-9][0-9]*" defaultValue={canonical.config.min_contribution} required /></label>
      <label className="wide">Summary<textarea name="summary" required /></label><label className="wide">Acceptance criteria<textarea name="criteria" required /></label>
      <label>Content URI (HTTPS/IPFS, optional pair)<input name="uri" /></label><label>Digest (sha256: + 64 lowercase hex, optional pair)<input name="digest" pattern="sha256:[0-9a-f]{64}" /></label>
      <fieldset className="wide"><legend>Project candidate (optional)</legend>
        <p>Attaching a candidate does not register or graduate a project.</p>
        <label>Project ID<input name="projectId" /></label>
        <label>Metadata URI (HTTPS/IPFS)<input name="projectUri" /></label>
        <label>Metadata digest (sha256: + 64 lowercase hex)<input name="projectDigest" pattern="sha256:[0-9a-f]{64}" /></label>
      </fieldset>
      <label className="wide">Expiration (exact Unix nanoseconds)<input name="expiry" inputMode="numeric" pattern="[0-9]+" defaultValue={defaultExpiry} required /></label>
    </div><button className="button" type="submit" disabled={disabled}>Prepare bounty review</button>
  </form>;
}
function ContributeForm({ bounty, disabled, onPrepare }: { bounty: Bounty; disabled: boolean; onPrepare: (amount: string) => void }) {
  return <form onSubmit={(event) => { event.preventDefault(); onPrepare(String(new FormData(event.currentTarget).get("amount"))); }}>
    <h2 id="contribute-title">Contribute to bounty #{bounty.id}</h2>
    <label>Contribution (exact ujuno)<input name="amount" inputMode="numeric" pattern="[1-9][0-9]*" required /></label>{" "}
    <button className="button" type="submit" disabled={disabled}>Connect and review contribution</button>
  </form>;
}
function SettlementControls({ state, disabled, onPrepare }: {
  state: SettlementState; disabled: boolean; onPrepare: (make: (sender: string) => TransactionIntent) => void;
}) {
  const b = state.bounty, round = state.activeRound, now = BigInt(state.chainTimeNanos);
  const closed = Boolean(round?.closes_at && now >= BigInt(round.closes_at));
  return <div aria-labelledby="settlement-title">
    <h2 id="settlement-title">Contributor-controlled settlement</h2>
    <p>All actor, state, round, and deadline checks use the canonical detail shown below and are rechecked immediately before signing.</p>
    {b.status === "open" && now < BigInt(b.expires_at) && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget);
      onPrepare((sender) => nominatePayoutIntent(state, sender, { recipient: String(f.get("recipient")),
        evidenceUri: String(f.get("evidenceUri")), evidenceDigest: String(f.get("evidenceDigest")), rationale: String(f.get("nominationRationale")) })); }}>
      <h3>Nominate payout</h3><p>The public control is creator-only; no agent or governor controls are exposed.</p>
      <div className="action-grid">
        <label>Recipient Juno address<input name="recipient" required /></label>
        <label>Evidence URI (HTTPS/IPFS)<input name="evidenceUri" required /></label>
        <label className="wide">Evidence digest (sha256: + 64 lowercase hex)<input name="evidenceDigest" pattern="sha256:[0-9a-f]{64}" required /></label>
        <label className="wide">Nomination rationale<textarea name="nominationRationale" required /></label>
      </div><button className="button" type="submit" disabled={disabled}>Review payout nomination</button>
    </form>}
    {b.status === "open" && b.contributor_count === 1 && <ReasonForm label="Cancel sole-funded bounty" field="cancelReason"
      button="Review cancellation" disabled={disabled} onSubmit={(reason) => onPrepare((sender) => cancelSoleFundedIntent(state, sender, reason))} />}
    {b.status === "open" && now >= BigInt(b.expires_at) && <button className="button" disabled={disabled}
      onClick={() => onPrepare(() => expireBountyIntent(state))}>Review public expiry</button>}
    {b.status === "single_confirmation" && round && <section aria-labelledby="sole-decision-title">
      <h3 id="sole-decision-title">Sole-contributor decision · round {round.number}</h3>
      <p className="chain-time">Confirm or decline before close {round.closes_at} ns and expiry {b.expires_at} ns. Equality is closed.</p>
      {!closed && now < BigInt(b.expires_at) && <><button className="button" disabled={disabled}
        onClick={() => onPrepare((sender) => confirmSolePayoutIntent(state, sender, round.number))}>Review sole payout confirmation</button>
        <ReasonForm label="Decline nominated payout" field="declineReason" button="Review decline" disabled={disabled}
          onSubmit={(reason) => onPrepare((sender) => declineSolePayoutIntent(state, sender, round.number, reason))} /></>}
    </section>}
    {b.status === "ratifying" && round && <section aria-labelledby="ballot-title">
      <h3 id="ballot-title">Weighted ballot · round {round.number}</h3>
      <p>YES {round.yes_weight} ujuno · NO {round.no_weight} ujuno · {round.voter_count} voter(s).</p>
      <p className="chain-time">Ballots close at exactly {round.closes_at} ns. Equality is closed; weights are snapshotted and revisions replace the prior ballot.</p>
      {!closed && <form onSubmit={(event) => { event.preventDefault(); const f = new FormData(event.currentTarget);
        onPrepare((sender) => votePayoutIntent(state, sender, round.number, String(f.get("vote")) as "yes" | "no", String(f.get("voteRationale")))); }}>
        <fieldset><legend>Ballot choice</legend><label><input type="radio" name="vote" value="yes" required /> YES</label>{" "}
          <label><input type="radio" name="vote" value="no" required /> NO</label></fieldset>
        <label>Ballot rationale (optional)<textarea name="voteRationale" /></label>
        <button className="button" type="submit" disabled={disabled}>Review or revise ballot</button>
      </form>}
    </section>}
    {(b.status === "ratifying" || b.status === "single_confirmation") && round && closed && <button className="button" disabled={disabled}
      onClick={() => onPrepare(() => finalizePayoutIntent(state, round.number))}>Review public finalization</button>}
    {b.status === "refunding" && <button className="button" disabled={disabled}
      onClick={() => onPrepare((sender) => claimRefundIntent(state, sender))}>Review contributor refund claim</button>}
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
      <dt>Attached funds</dt><dd>{value.funds.length ? value.funds.map((x) => `${x.amount} ${x.denom}`).join(", ") : "None"}</dd><dt>Estimated fee</dt><dd>{value.fee.amount.map((x) => `${x.amount} ${x.denom}`).join(", ")} · gas {value.fee.gas}</dd><dt>Canonical height</dt><dd>{value.canonicalState.height}</dd></dl>
    <ul>{value.consequences.map((item) => <li key={item}>{item}</li>)}</ul>
    <button className="button secondary" onClick={onCancel} disabled={busy}>Cancel</button>{" "}<button className="button" onClick={onSubmit} disabled={busy}>{busy ? "Checking canonical state…" : "Recheck state, then sign"}</button>
  </section>;
}
