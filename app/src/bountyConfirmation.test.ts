import { describe, expect, it } from "vitest";
import { confirmBountyMutation, confirmSettlementMutation } from "./bountyConfirmation";
import { bounty, ledger } from "./test/bountyFixtures";
import type { BountyDetail, PayoutRound } from "./types";
const sender = bounty.creator;
describe("canonical event plus refreshed-state confirmation", () => {
  it("confirms creation only when event and refreshed state agree", () => {
    const refreshed = { ...bounty, total_contribution: "1000000" };
    expect(confirmBountyMutation({ action: "create_bounty", sender, amount: "1000000", refreshed,
      events: [{ type: "juno_voice_bounties.bounty_created", attributes: [
        { key: "bounty_id", value: "1" }, { key: "creator", value: sender }, { key: "amount", value: "1000000" }] }] }))
      .toEqual({ bountyId: 1, eventType: "juno_voice_bounties.bounty_created" });
  });
  it("accepts the CosmWasm DeliverTx prefix on the exact contract event", () => {
    const refreshed = { ...bounty, total_contribution: "1000000" };
    expect(confirmBountyMutation({ action: "create_bounty", sender, amount: "1000000", refreshed,
      events: [{ type: "wasm-juno_voice_bounties.bounty_created", attributes: [
        { key: "bounty_id", value: "1" }, { key: "creator", value: sender }, { key: "amount", value: "1000000" }] }] }))
      .toMatchObject({ bountyId: 1 });
  });
  it("confirms contribution against canonical bounty total", () => {
    const refreshed = { ...bounty, total_contribution: "3500000" };
    expect(confirmBountyMutation({ action: "contribute", sender, amount: "1000000", priorTotal: "2500000", refreshed,
      events: [{ type: "juno_voice_bounties.contributed", attributes: [
        { key: "bounty_id", value: "1" }, { key: "contributor", value: sender }, { key: "amount", value: "1000000" },
        { key: "bounty_total", value: "3500000" }] }] })).toMatchObject({ bountyId: 1 });
  });
  it("fails closed for missing, ambiguous, or mismatched confirmation", () => {
    const event = { type: "juno_voice_bounties.contributed", attributes: [
      { key: "bounty_id", value: "1" }, { key: "contributor", value: sender }, { key: "amount", value: "1" },
      { key: "bounty_total", value: "2500001" }] };
    expect(() => confirmBountyMutation({ action: "contribute", sender, amount: "1", priorTotal: "2500000", refreshed: bounty, events: [event] })).toThrow();
    expect(() => confirmBountyMutation({ action: "contribute", sender, amount: "1", priorTotal: "2500000", refreshed: bounty, events: [] })).toThrow();
  });
});

const digest = `sha256:${"ab".repeat(32)}`;
const round: PayoutRound = { bounty_id: 1, number: 1, nomination: { nominator: sender, recipient: sender,
  evidence_uri: "ipfs://evidence", evidence_digest: digest, rationale: "done" },
  rule: "contribution_weighted_majority", total_weight: "2500000", contributor_count: 1,
  opens_at: "1", closes_at: "2", yes_weight: "2500000", no_weight: "0", voter_count: 1,
  outcome: "pending", finalized_at: null };
const detail = (overrides: Partial<BountyDetail> = {}): BountyDetail => ({ bounty, config: ledger.config, pause: ledger.pause,
  activeRound: round, rounds: [round], receipts: [], moderation: null, graduation: null,
  contributions: [], claims: [], history: [], observationHeight: 1, chainTimeNanos: "1", fingerprint: "x", ...overrides });
const event = (type: string, attributes: Record<string, string>) => ({ type, attributes: Object.entries(attributes).map(([key, value]) => ({ key, value })) });

describe("canonical settlement event plus refreshed-state confirmation", () => {
  it("confirms nomination and rejects ambiguous or mismatched canonical evidence", () => {
    const before = detail({ bounty: { ...bounty, active_round: null }, activeRound: null, rounds: [] });
    const refreshed = detail({ bounty: { ...bounty, status: "ratifying", active_round: 1 } });
    const options = { action: "nominate_payout" as const, before, refreshed, sender,
      message: { nominate_payout: { bounty_id: 1, recipient: sender, evidence_uri: "ipfs://evidence", evidence_digest: digest, rationale: "done" } },
      events: [event("wasm-juno_voice_bounties.payout_nominated", { bounty_id: "1", round: "1", nominator: sender, recipient: sender })] };
    expect(confirmSettlementMutation(options)).toMatchObject({ bountyId: 1 });
    expect(() => confirmSettlementMutation({ ...options, events: [...options.events, ...options.events] })).toThrow(/ambiguous/);
    expect(() => confirmSettlementMutation({ ...options, refreshed: detail({ bounty: { ...refreshed.bounty, active_round: 2 } }) })).toThrow();
  });

  it("confirms revised weighted ballots against exact receipt and round totals", () => {
    const receipt = { bounty_id: 1, round: 1, voter: sender, weight: "2500000", vote: "yes" as const,
      rationale: null, cast_at: "1", revised_at: "2", revisions: 1, voter_index: 1 };
    expect(confirmSettlementMutation({ action: "vote_payout", before: detail(), refreshed: detail({ receipts: [receipt] }), sender,
      message: { vote_payout: { bounty_id: 1, round: 1, vote: "yes", rationale: null } }, events: [event("juno_voice_bounties.payout_vote_recorded",
        { bounty_id: "1", round: "1", voter: sender, vote: "yes", weight: "2500000", yes_weight: "2500000", no_weight: "0", revisions: "1" })] }))
      .toMatchObject({ eventType: "juno_voice_bounties.payout_vote_recorded" });
  });

  it.each(["paid", "no_majority", "tie", "no_votes"] as const)("confirms finalized %s outcome from event and refreshed round", (outcome) => {
    const finalRound = { ...round, outcome, finalized_at: "3" };
    const status = outcome === "paid" ? "paid" as const : "open" as const;
    const refreshed = detail({ bounty: { ...bounty, status, active_round: null,
      ...(outcome === "paid" ? { paid_recipient: sender, paid_amount: "2500000" } : {}) }, activeRound: null, rounds: [finalRound] });
    expect(confirmSettlementMutation({ action: "finalize_payout", before: detail(), refreshed, sender,
      message: { finalize_payout: { bounty_id: 1, round: 1 } }, events: [event("juno_voice_bounties.ratification_finalized",
        { bounty_id: "1", round: "1", outcome, yes_weight: finalRound.yes_weight, no_weight: finalRound.no_weight,
          participating_weight: (BigInt(finalRound.yes_weight) + BigInt(finalRound.no_weight)).toString(), next_status: status })] })).toMatchObject({ bountyId: 1 });
  });

  it("confirms sole payment, decline, cancellation, expiry, and refund state transitions", () => {
    const sole = { ...round, rule: "sole_confirmation" as const };
    const before = detail({ activeRound: sole, rounds: [sole] });
    const paidRound = { ...sole, outcome: "paid" as const, finalized_at: "3" };
    expect(confirmSettlementMutation({ action: "confirm_sole_payout", before,
      refreshed: detail({ bounty: { ...bounty, status: "paid", active_round: null, paid_recipient: sender, paid_amount: "2500000" }, activeRound: null, rounds: [paidRound] }),
      sender, message: { confirm_sole_payout: { bounty_id: 1, round: 1 } }, events: [event("juno_voice_bounties.payout_completed",
        { bounty_id: "1", round: "1", mode: "sole_confirmation", recipient: sender, amount: "2500000" })] })).toMatchObject({ bountyId: 1 });
    const declined = { ...sole, outcome: "declined" as const, finalized_at: "3" };
    expect(confirmSettlementMutation({ action: "decline_sole_payout", before,
      refreshed: detail({ bounty: { ...bounty, status: "open", active_round: null }, activeRound: null, rounds: [declined] }), sender,
      message: { decline_sole_payout: { bounty_id: 1, round: 1, reason: "no" } }, events: [event("juno_voice_bounties.sole_payout_declined",
        { bounty_id: "1", round: "1", contributor: sender, reason: "no", next_status: "open" })] })).toMatchObject({ bountyId: 1 });
    const cancelled = detail({ bounty: { ...bounty, status: "refunding", refund_reason: { cancelled: { reason: "no" } } }, activeRound: null });
    expect(confirmSettlementMutation({ action: "cancel_sole_funded", before: detail(), refreshed: cancelled, sender,
      message: { cancel_sole_funded: { bounty_id: 1, reason: "no" } }, events: [event("juno_voice_bounties.bounty_cancelled",
        { bounty_id: "1", creator: sender, reason: "no", refundable: "2500000" })] })).toMatchObject({ bountyId: 1 });
    const expired = detail({ bounty: { ...bounty, status: "refunding", refund_reason: "expired" }, activeRound: null });
    expect(confirmSettlementMutation({ action: "expire", before: detail(), refreshed: expired, sender,
      message: { expire: { bounty_id: 1 } }, events: [event("juno_voice_bounties.bounty_expired",
        { bounty_id: "1", actor: sender, refundable: "2500000" })] })).toMatchObject({ bountyId: 1 });
    const claimed = detail({ bounty: { ...expired.bounty, refunded_amount: "2500000", status: "refunded" }, activeRound: null,
      claims: [{ bounty_id: 1, contributor: sender, amount: "2500000", claimed_at: "4" }] });
    expect(confirmSettlementMutation({ action: "claim_refund", before: expired, refreshed: claimed, sender,
      message: { claim_refund: { bounty_id: 1 } }, events: [event("juno_voice_bounties.refund_claimed",
        { bounty_id: "1", contributor: sender, amount: "2500000", fully_refunded: "true" })] })).toMatchObject({ bountyId: 1 });
  });
});
