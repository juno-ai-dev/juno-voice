import { fromBech32 } from "@cosmjs/encoding";
import type { BountyDetail, PayoutRound, PayoutVote } from "./types";
import type { TransactionIntent } from "./transactions";
import { formatJuno } from "./junoAmount";
import { METADATA_DIGEST_PATTERN, URI_SCHEME_PATTERN } from "./metadataDigest";

const U64_MAX = 18446744073709551615n;
const utf8 = (value: string) => new TextEncoder().encode(value).length;
export type SettlementState = Pick<BountyDetail, "bounty" | "pause" | "activeRound" | "contributions" | "claims" | "receipts" | "chainTimeNanos" | "fingerprint">;

function chainNow(state: SettlementState): bigint {
  if (!/^\d+$/.test(state.chainTimeNanos) || BigInt(state.chainTimeNanos) > U64_MAX)
    throw new Error("Canonical chain time is unavailable.");
  return BigInt(state.chainTimeNanos);
}
function required(value: string, max: number, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (utf8(normalized) > max) throw new Error(`${label} exceeds the snapshotted ${max}-byte limit.`);
  return normalized;
}
function digest(value: string): string {
  const normalized = value.trim();
  if (!METADATA_DIGEST_PATTERN.test(normalized))
    throw new Error("Evidence digest must use sha256:<64 lowercase hex characters>.");
  return normalized;
}
function junoAddress(value: string, label: string): string {
  const normalized = value.trim();
  try {
    const decoded = fromBech32(normalized);
    if (normalized !== normalized.toLowerCase() || decoded.prefix !== "juno" || decoded.data.length !== 20) throw new Error();
  } catch { throw new Error(`${label} must be a valid Juno account address.`); }
  return normalized;
}
function base(state: SettlementState, bountyContract: string, executeMessage: Record<string, unknown>, consequences: string[]): TransactionIntent {
  return { chainId: "juno-1", contract: bountyContract, executeMessage, funds: [], consequences,
    expectedStateFingerprint: state.fingerprint };
}
function active(state: SettlementState, round: number): PayoutRound {
  if (!Number.isSafeInteger(round) || round < 0 || state.bounty.active_round !== round || state.activeRound?.number !== round)
    throw new Error("Wrong payout round. Refresh canonical bounty detail.");
  return state.activeRound;
}
function contributor(state: SettlementState, sender: string) {
  const item = state.contributions.find((value) => value.contributor === sender);
  if (!item || item.weight_at_round === null || BigInt(item.weight_at_round) === 0n)
    throw new Error("Only a contributor snapshotted for this round may take this action.");
  return item;
}
function beforeClose(state: SettlementState, round: PayoutRound, includeExpiry: boolean) {
  const now = chainNow(state);
  if (round.closes_at === null || now >= BigInt(round.closes_at) || (includeExpiry && now >= BigInt(state.bounty.expires_at)))
    throw new Error("This action's canonical chain deadline has closed.");
}

export function nominatePayoutIntent(state: SettlementState, sender: string, input: {
  recipient: string; evidenceUri: string; evidenceDigest: string; rationale: string;
}, bountyContract: string): TransactionIntent {
  const b = state.bounty;
  if (state.pause.paused) throw new Error("New payout nominations are paused on chain.");
  if (sender !== b.creator) throw new Error("Only the bounty creator may use this public nomination control.");
  if (b.status !== "open" || b.active_round !== null) throw new Error("This bounty is not open for a payout nomination.");
  if (chainNow(state) >= BigInt(b.expires_at)) throw new Error("This bounty has expired according to canonical chain time.");
  if (b.next_round > b.terms.max_rounds) throw new Error("This bounty has reached its snapshotted round limit.");
  const recipient = junoAddress(input.recipient, "Recipient");
  const evidenceUri = required(input.evidenceUri, b.terms.max_evidence_uri_bytes, "Evidence URI");
  if (!URI_SCHEME_PATTERN.test(evidenceUri))
    throw new Error("Evidence URI must be a bounded HTTPS or IPFS URI.");
  const evidenceDigest = digest(input.evidenceDigest);
  const rationale = required(input.rationale, b.terms.max_rationale_bytes, "Nomination rationale");
  const rule = b.contributor_count === 1 ? "sole-contributor confirmation" : "revisable contribution-weighted voting";
  return base(state, bountyContract, { nominate_payout: { bounty_id: b.id, recipient, evidence_uri: evidenceUri,
    evidence_digest: evidenceDigest, rationale } }, [
    `Nominate ${recipient} to receive the entire ${formatJuno(b.total_contribution)} escrow for bounty #${b.id}.`,
    `This opens round ${b.next_round} under ${rule}; contribution weights are snapshotted when the contract accepts the nomination.`,
    "No funds are attached. A later contributor decision, public finalization, or refund path determines where escrow goes.",
  ]);
}

export function confirmSolePayoutIntent(state: SettlementState, sender: string, roundNumber: number, bountyContract: string): TransactionIntent {
  const round = active(state, roundNumber);
  if (state.bounty.status !== "single_confirmation" || state.bounty.contributor_count !== 1 || round.rule !== "sole_confirmation")
    throw new Error("This bounty is not awaiting a sole-contributor decision.");
  contributor(state, sender); beforeClose(state, round, true);
  return base(state, bountyContract, { confirm_sole_payout: { bounty_id: state.bounty.id, round: roundNumber } }, [
    `Irreversibly approve payment of ${formatJuno(round.total_weight)} to ${round.nomination.recipient}.`,
    `This must land before both close ${round.closes_at} ns and bounty expiry ${state.bounty.expires_at} ns.`,
    "No funds are attached; the contract sends the escrow to the nominated recipient.",
  ]);
}

export function declineSolePayoutIntent(state: SettlementState, sender: string, roundNumber: number, reason: string, bountyContract: string): TransactionIntent {
  const round = active(state, roundNumber);
  if (state.bounty.status !== "single_confirmation" || state.bounty.contributor_count !== 1 || round.rule !== "sole_confirmation")
    throw new Error("This bounty is not awaiting a sole-contributor decision.");
  contributor(state, sender); beforeClose(state, round, true);
  const value = required(reason, state.bounty.terms.max_reason_bytes, "Decline reason");
  return base(state, bountyContract, { decline_sole_payout: { bounty_id: state.bounty.id, round: roundNumber, reason: value } }, [
    `Decline payout round ${roundNumber}; the nominated recipient will not be paid by this round.`,
    "The contract reopens another round when time and the round limit permit, otherwise contributor refunds become available.",
    "No funds are attached.",
  ]);
}

export function votePayoutIntent(state: SettlementState, sender: string, roundNumber: number, vote: PayoutVote, rationale: string,
  bountyContract: string): TransactionIntent {
  const round = active(state, roundNumber);
  if (state.bounty.status !== "ratifying" || round.rule !== "contribution_weighted_majority")
    throw new Error("This bounty is not in contribution-weighted voting.");
  const snapshot = contributor(state, sender); beforeClose(state, round, false);
  const normalized = rationale.trim();
  if (normalized && utf8(normalized) > state.bounty.terms.max_rationale_bytes)
    throw new Error(`Vote rationale exceeds the snapshotted ${state.bounty.terms.max_rationale_bytes}-byte limit.`);
  const previous = state.receipts.find((item) => item.round === roundNumber && item.voter === sender);
  return base(state, bountyContract, { vote_payout: { bounty_id: state.bounty.id, round: roundNumber, vote,
    rationale: normalized || null } }, [
    `${previous ? "Revise" : "Cast"} a ${vote.toUpperCase()} ballot with immutable round-${roundNumber} weight ${formatJuno(snapshot.weight_at_round!)}.`,
    `Ballots remain revisable until the exact canonical close ${round.closes_at} ns; this submission replaces any prior choice from this account.`,
    "No funds are attached. Finalization, not this ballot alone, determines payment.",
  ]);
}

export function finalizePayoutIntent(state: SettlementState, roundNumber: number, bountyContract: string): TransactionIntent {
  const round = active(state, roundNumber), now = chainNow(state);
  if (state.bounty.status !== "ratifying" && state.bounty.status !== "single_confirmation")
    throw new Error("This bounty has no finalizable payout round.");
  if (round.closes_at === null || now < BigInt(round.closes_at))
    throw new Error("Ratification is still open according to canonical chain time.");
  const participating = BigInt(round.yes_weight) + BigInt(round.no_weight);
  const yes = BigInt(round.yes_weight), no = BigInt(round.no_weight);
  const outcome = round.rule === "sole_confirmation" || participating === 0n ? "no-votes"
    : yes === no ? "tie" : yes > no ? "paid" : "no-majority";
  return base(state, bountyContract, { finalize_payout: { bounty_id: state.bounty.id, round: roundNumber } }, [
    `Publicly finalize closed round ${roundNumber}; current canonical weights predict ${outcome}.`,
    outcome === "paid" ? `The contract will send ${formatJuno(round.total_weight)} to ${round.nomination.recipient}.`
      : "No payout occurs; the contract reopens nomination or enters refunds according to expiry and the round limit.",
    "No funds are attached. The contract's canonical state at execution is authoritative.",
  ]);
}

export function cancelSoleFundedIntent(state: SettlementState, sender: string, reason: string, bountyContract: string): TransactionIntent {
  const b = state.bounty;
  if (sender !== b.creator) throw new Error("Only the bounty creator may cancel a sole-funded bounty.");
  if (b.status !== "open" || b.contributor_count !== 1 || b.active_round !== null)
    throw new Error("Public cancellation is allowed only while a sole-funded bounty is open.");
  const value = required(reason, b.terms.max_reason_bytes, "Cancellation reason");
  return base(state, bountyContract, { cancel_sole_funded: { bounty_id: b.id, reason: value } }, [
    `Cancel bounty #${b.id} and move its entire ${formatJuno(b.total_contribution)} escrow into contributor refunds.`,
    "No funds are attached. The contributor must separately claim the refund exactly once.",
  ]);
}

export function expireBountyIntent(state: SettlementState, bountyContract: string): TransactionIntent {
  const b = state.bounty;
  if (b.status !== "open") throw new Error("Only an open bounty can be publicly expired.");
  if (chainNow(state) < BigInt(b.expires_at)) throw new Error("This bounty has not expired according to canonical chain time.");
  return base(state, bountyContract, { expire: { bounty_id: b.id } }, [
    `Publicly mark bounty #${b.id} expired and move ${formatJuno(b.total_contribution)} into contributor refunds.`,
    "No funds are attached. Each contributor must separately claim exactly once.",
  ]);
}

export function claimRefundIntent(state: SettlementState, sender: string, bountyContract: string): TransactionIntent {
  const b = state.bounty, contribution = state.contributions.find((item) => item.contributor === sender);
  if (b.status !== "refunding") throw new Error("This bounty is not currently refundable.");
  if (!contribution || BigInt(contribution.current_amount) === 0n) throw new Error("Only a contributor may claim this refund.");
  if (state.claims.some((item) => item.contributor === sender))
    throw new Error("This contributor refund was already claimed; do not submit again.");
  return base(state, bountyContract, { claim_refund: { bounty_id: b.id } }, [
    `Claim exactly ${formatJuno(contribution.current_amount)} back to the connected contributor account.`,
    "This refund can be claimed exactly once. No funds are attached to the request.",
  ]);
}
