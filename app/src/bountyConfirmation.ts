import type { Bounty, BountyDetail } from "./types";
export interface CanonicalEvent { type: string; attributes: readonly { key: string; value: string }[] }
const attrs = (event: CanonicalEvent) => new Map(event.attributes.map((item) => [item.key, item.value]));
export function confirmBountyMutation(options: {
  action: "create_bounty" | "contribute"; events: readonly CanonicalEvent[]; refreshed: Bounty;
  sender: string; amount: string; priorTotal?: string;
}): { bountyId: number; eventType: string } {
  const eventType = options.action === "create_bounty"
    ? "juno_voice_bounties.bounty_created" : "juno_voice_bounties.contributed";
  // DeliverTx prefixes CosmWasm custom events with `wasm-`, while contract
  // response tests expose the declared type without that transport prefix.
  const matches = options.events.filter((event) => event.type === eventType || event.type === `wasm-${eventType}`);
  if (matches.length !== 1) throw new Error("Canonical transaction event is missing or ambiguous.");
  const values = attrs(matches[0]), id = values.get("bounty_id");
  if (!id || !/^\d+$/.test(id) || Number(id) !== options.refreshed.id || values.get("amount") !== options.amount)
    throw new Error("Canonical event does not match refreshed bounty state.");
  if (options.action === "create_bounty") {
    if (values.get("creator") !== options.sender || options.refreshed.creator !== options.sender ||
      options.refreshed.total_contribution !== options.amount)
      throw new Error("Created bounty was not confirmed by refreshed canonical state.");
  } else {
    if (values.get("contributor") !== options.sender || values.get("bounty_total") !== options.refreshed.total_contribution ||
      options.priorTotal === undefined || BigInt(options.priorTotal) + BigInt(options.amount) !== BigInt(options.refreshed.total_contribution))
      throw new Error("Contribution was not confirmed by refreshed canonical state.");
  }
  return { bountyId: options.refreshed.id, eventType };
}

export type SettlementAction = "nominate_payout" | "confirm_sole_payout" | "decline_sole_payout" |
  "vote_payout" | "finalize_payout" | "cancel_sole_funded" | "expire" | "claim_refund";
const settlementEvents: Record<SettlementAction, string> = {
  nominate_payout: "juno_voice_bounties.payout_nominated",
  confirm_sole_payout: "juno_voice_bounties.payout_completed",
  decline_sole_payout: "juno_voice_bounties.sole_payout_declined",
  vote_payout: "juno_voice_bounties.payout_vote_recorded",
  finalize_payout: "juno_voice_bounties.ratification_finalized",
  cancel_sole_funded: "juno_voice_bounties.bounty_cancelled",
  expire: "juno_voice_bounties.bounty_expired",
  claim_refund: "juno_voice_bounties.refund_claimed",
};
export function confirmSettlementMutation(options: {
  action: SettlementAction; events: readonly CanonicalEvent[]; before: BountyDetail; refreshed: BountyDetail;
  sender: string; message: Record<string, unknown>;
}): { bountyId: number; eventType: string } {
  const eventType = settlementEvents[options.action];
  const matches = options.events.filter((event) => event.type === eventType || event.type === `wasm-${eventType}`);
  if (matches.length !== 1) throw new Error("Canonical settlement event is missing or ambiguous.");
  const values = attrs(matches[0]), body = options.message[options.action] as Record<string, unknown>;
  const bountyId = body.bounty_id;
  if (typeof bountyId !== "number" || !Number.isSafeInteger(bountyId) || values.get("bounty_id") !== String(bountyId) || options.refreshed.bounty.id !== bountyId)
    throw new Error("Canonical settlement event identifies a different bounty.");
  const roundNumber = "round" in body ? body.round : undefined;
  if (roundNumber !== undefined && values.get("round") !== String(roundNumber))
    throw new Error("Canonical settlement event identifies a different round.");
  const round = typeof roundNumber === "number" ? options.refreshed.rounds.find((item) => item.number === roundNumber) : undefined;
  switch (options.action) {
    case "nominate_payout":
      if (!options.refreshed.activeRound || options.refreshed.activeRound.number !== options.before.bounty.next_round ||
        options.refreshed.bounty.active_round !== options.refreshed.activeRound.number ||
        values.get("round") !== String(options.refreshed.activeRound.number) ||
        values.get("nominator") !== options.sender || values.get("recipient") !== body.recipient ||
        values.get("contributor_count") !== String(options.refreshed.activeRound.contributor_count) ||
        values.get("total_weight") !== options.refreshed.activeRound.total_weight ||
        values.get("closes_at") !== options.refreshed.activeRound.closes_at ||
        options.refreshed.activeRound.nomination.recipient !== body.recipient ||
        options.refreshed.activeRound.nomination.evidence_uri !== body.evidence_uri ||
        options.refreshed.activeRound.nomination.evidence_digest !== body.evidence_digest ||
        options.refreshed.activeRound.nomination.rationale !== body.rationale)
        throw new Error("Payout nomination was not confirmed by refreshed canonical state.");
      break;
    case "confirm_sole_payout":
      if (values.get("mode") !== "sole_confirmation" || !round || round.outcome !== "paid" ||
        options.refreshed.bounty.status !== "paid" || values.get("recipient") !== options.refreshed.bounty.paid_recipient ||
        values.get("amount") !== options.refreshed.bounty.paid_amount)
        throw new Error("Sole payout was not confirmed by refreshed canonical state.");
      break;
    case "decline_sole_payout":
      if (!round || round.outcome !== "declined" || values.get("contributor") !== options.sender || values.get("reason") !== body.reason ||
        options.refreshed.bounty.active_round !== null || values.get("next_status") !== options.refreshed.bounty.status)
        throw new Error("Sole payout decline was not confirmed by refreshed canonical state.");
      break;
    case "vote_payout": { const receipt = options.refreshed.receipts.find((item) => item.round === roundNumber && item.voter === options.sender);
      if (!round || !receipt || receipt.vote !== body.vote || values.get("voter") !== options.sender || values.get("vote") !== receipt.vote ||
        receipt.rationale !== (body.rationale ?? null) ||
        values.get("weight") !== receipt.weight || values.get("yes_weight") !== round.yes_weight ||
        values.get("no_weight") !== round.no_weight || values.get("revisions") !== String(receipt.revisions))
        throw new Error("Payout ballot was not confirmed by refreshed canonical state.");
      break; }
    case "finalize_payout":
      if (!round || round.outcome === "pending" || values.get("outcome") !== round.outcome ||
        values.get("yes_weight") !== round.yes_weight || values.get("no_weight") !== round.no_weight ||
        values.get("participating_weight") !== (BigInt(round.yes_weight) + BigInt(round.no_weight)).toString() ||
        values.get("next_status") !== options.refreshed.bounty.status)
        throw new Error("Payout finalization was not confirmed by refreshed canonical state.");
      if (round.outcome === "paid" && (options.refreshed.bounty.paid_recipient !== round.nomination.recipient ||
        options.refreshed.bounty.paid_amount !== round.total_weight))
        throw new Error("Finalized payment does not match the canonical nomination.");
      break;
    case "cancel_sole_funded":
      if (values.get("creator") !== options.sender || values.get("reason") !== body.reason ||
        values.get("refundable") !== options.refreshed.bounty.total_contribution ||
        options.refreshed.bounty.status !== "refunding" || !options.refreshed.bounty.refund_reason ||
        typeof options.refreshed.bounty.refund_reason !== "object" || !("cancelled" in options.refreshed.bounty.refund_reason) ||
        options.refreshed.bounty.refund_reason.cancelled.reason !== body.reason)
        throw new Error("Cancellation was not confirmed by refreshed canonical state.");
      break;
    case "expire":
      if (values.get("actor") !== options.sender || values.get("refundable") !== options.refreshed.bounty.total_contribution ||
        options.refreshed.bounty.status !== "refunding" ||
        options.refreshed.bounty.refund_reason !== "expired")
        throw new Error("Expiry was not confirmed by refreshed canonical state.");
      break;
    case "claim_refund": { const claim = options.refreshed.claims.find((item) => item.contributor === options.sender);
      if (!claim || options.before.claims.some((item) => item.contributor === options.sender) ||
        values.get("contributor") !== options.sender || values.get("amount") !== claim.amount ||
        BigInt(options.refreshed.bounty.refunded_amount) !== BigInt(options.before.bounty.refunded_amount) + BigInt(claim.amount) ||
        values.get("fully_refunded") !== String(options.refreshed.bounty.status === "refunded"))
        throw new Error("Refund was not confirmed by refreshed canonical state.");
      break; }
  }
  return { bountyId, eventType };
}
