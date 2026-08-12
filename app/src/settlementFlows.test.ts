import { toBech32 } from "@cosmjs/encoding";
import { describe, expect, it } from "vitest";
import { bounty, ledger } from "./test/bountyFixtures";
import type { BountyDetail, PayoutRound } from "./types";
import { cancelSoleFundedIntent, claimRefundIntent, confirmSolePayoutIntent, declineSolePayoutIntent,
  expireBountyIntent, finalizePayoutIntent, nominatePayoutIntent, votePayoutIntent } from "./settlementFlows";

const creator = toBech32("juno", new Uint8Array(20).fill(1));
const other = toBech32("juno", new Uint8Array(20).fill(2));
const recipient = toBech32("juno", new Uint8Array(20).fill(3));
const digest = `sha256:${"ab".repeat(32)}`;
const open = (): BountyDetail => ({ bounty: { ...bounty, creator }, config: ledger.config, pause: ledger.pause,
  activeRound: null, rounds: [], receipts: [], moderation: null, graduation: null,
  contributions: [{ bounty_id: 1, contributor: creator, contributor_index: 1, current_amount: "2500000", weight_at_round: null }],
  claims: [], history: [], observationHeight: 10, chainTimeNanos: "1700000000000000000", fingerprint: "open:v1" });
const payoutRound = (overrides: Partial<PayoutRound> = {}): PayoutRound => ({ bounty_id: 1, number: 1,
  nomination: { nominator: creator, recipient, evidence_uri: "ipfs://evidence", evidence_digest: digest, rationale: "Shipped" },
  rule: "contribution_weighted_majority", total_weight: "1000", contributor_count: 2,
  opens_at: "1700000000000000000", closes_at: "1750000000000000000", yes_weight: "600", no_weight: "400",
  voter_count: 2, outcome: "pending", finalized_at: null, ...overrides });
const ratifying = (round = payoutRound()): BountyDetail => { const base = open(); return { ...base,
  bounty: { ...base.bounty, status: "ratifying", contributor_count: 2, total_contribution: "1000", active_round: round.number },
  activeRound: round, rounds: [round], contributions: [
    { bounty_id: 1, contributor: creator, contributor_index: 1, current_amount: "900", weight_at_round: "600" },
    { bounty_id: 1, contributor: other, contributor_index: 2, current_amount: "100", weight_at_round: "400" },
  ], fingerprint: "round:v1" }; };

describe("settlement intent actor, state, schema, and time boundaries", () => {
  it("builds the exact creator nomination with recipient/evidence/digest/rationale and no funds", () => {
    expect(nominatePayoutIntent(open(), creator, { recipient, evidenceUri: "ipfs://evidence", evidenceDigest: digest, rationale: "Shipped" }))
      .toMatchObject({ executeMessage: { nominate_payout: { bounty_id: 1, recipient, evidence_uri: "ipfs://evidence",
        evidence_digest: digest, rationale: "Shipped" } }, funds: [], expectedStateFingerprint: "open:v1" });
  });
  it.each([
    ["wrong actor", (s: BountyDetail) => nominatePayoutIntent(s, other, { recipient, evidenceUri: "ipfs://evidence", evidenceDigest: digest, rationale: "x" })],
    ["paused", (s: BountyDetail) => nominatePayoutIntent({ ...s, pause: { ...s.pause, paused: true } }, creator, { recipient, evidenceUri: "ipfs://evidence", evidenceDigest: digest, rationale: "x" })],
    ["expired equality", (s: BountyDetail) => nominatePayoutIntent({ ...s, chainTimeNanos: s.bounty.expires_at }, creator, { recipient, evidenceUri: "ipfs://evidence", evidenceDigest: digest, rationale: "x" })],
    ["round limit", (s: BountyDetail) => nominatePayoutIntent({ ...s, bounty: { ...s.bounty, next_round: s.bounty.terms.max_rounds + 1 } }, creator, { recipient, evidenceUri: "ipfs://evidence", evidenceDigest: digest, rationale: "x" })],
    ["unsafe evidence", (s: BountyDetail) => nominatePayoutIntent(s, creator, { recipient, evidenceUri: "javascript:bad", evidenceDigest: digest, rationale: "x" })],
  ])("rejects nomination boundary: %s", (_, run) => expect(() => run(open())).toThrow());

  it("enforces sole actor, exact round, and strict close/expiry deadlines", () => {
    const round = payoutRound({ rule: "sole_confirmation", contributor_count: 1, total_weight: "2500000",
      yes_weight: "0", no_weight: "0", voter_count: 0 });
    const base = open(), sole = { ...base, bounty: { ...base.bounty, status: "single_confirmation" as const, active_round: 1 },
      activeRound: round, rounds: [round], contributions: base.contributions.map((x) => ({ ...x, weight_at_round: "2500000" })) };
    expect(confirmSolePayoutIntent(sole, creator, 1).executeMessage).toEqual({ confirm_sole_payout: { bounty_id: 1, round: 1 } });
    expect(declineSolePayoutIntent(sole, creator, 1, "Not complete").executeMessage)
      .toEqual({ decline_sole_payout: { bounty_id: 1, round: 1, reason: "Not complete" } });
    expect(() => confirmSolePayoutIntent(sole, other, 1)).toThrow(/contributor/);
    expect(() => confirmSolePayoutIntent(sole, creator, 2)).toThrow(/Wrong payout round/);
    expect(() => confirmSolePayoutIntent({ ...sole, chainTimeNanos: round.closes_at! }, creator, 1)).toThrow(/closed/);
    expect(() => declineSolePayoutIntent({ ...sole, chainTimeNanos: sole.bounty.expires_at }, creator, 1, "x")).toThrow(/closed/);
  });

  it("uses immutable snapshot weight, permits revisions, and does not substitute expiry for the multi-vote close", () => {
    const base = ratifying();
    const revised = { ...base, bounty: { ...base.bounty, expires_at: "1710000000000000000" },
      chainTimeNanos: "1710000000000000000", receipts: [{ bounty_id: 1, round: 1, voter: creator,
      weight: "600", vote: "no" as const, rationale: null, cast_at: "1", revised_at: "1", revisions: 0, voter_index: 1 }] };
    const intent = votePayoutIntent(revised, creator, 1, "yes", "Changed after review");
    expect(intent.executeMessage).toEqual({ vote_payout: { bounty_id: 1, round: 1, vote: "yes", rationale: "Changed after review" } });
    expect(intent.funds).toEqual([]);
    expect(intent.consequences[0]).toMatch(/Revise.*weight \$JUNO 0.0006/);
    expect(intent.consequences.join(" ")).not.toContain("$JUNO 0.0009");
    expect(() => votePayoutIntent({ ...base, chainTimeNanos: base.activeRound!.closes_at! }, creator, 1, "no", "")).toThrow(/closed/);
    expect(() => votePayoutIntent(base, toBech32("juno", new Uint8Array(20).fill(9)), 1, "yes", "")).toThrow(/snapshotted/);
  });

  it.each([
    ["paid", payoutRound({ yes_weight: "501", no_weight: "499", voter_count: 2 }), /predict paid/],
    ["no-majority", payoutRound({ yes_weight: "499", no_weight: "501", voter_count: 2 }), /predict no-majority/],
    ["tie", payoutRound({ yes_weight: "500", no_weight: "500", voter_count: 2 }), /predict tie/],
    ["no-votes", payoutRound({ yes_weight: "0", no_weight: "0", voter_count: 0 }), /predict no-votes/],
  ])("predicts and discloses finalization outcome %s only after close", (_, round, expected) => {
    const state = { ...ratifying(round), chainTimeNanos: round.closes_at! };
    expect(finalizePayoutIntent(state, 1).consequences[0]).toMatch(expected);
    expect(finalizePayoutIntent(state, 1).funds).toEqual([]);
    expect(() => finalizePayoutIntent({ ...state, chainTimeNanos: (BigInt(round.closes_at!) - 1n).toString() }, 1)).toThrow(/still open/);
  });

  it("supports public expiry at equality, scoped cancellation, and exactly-once refunds", () => {
    const base = open();
    expect(expireBountyIntent({ ...base, chainTimeNanos: base.bounty.expires_at }).executeMessage).toEqual({ expire: { bounty_id: 1 } });
    expect(() => expireBountyIntent({ ...base, chainTimeNanos: (BigInt(base.bounty.expires_at) - 1n).toString() })).toThrow(/not expired/);
    expect(cancelSoleFundedIntent(base, creator, "No longer needed").executeMessage)
      .toEqual({ cancel_sole_funded: { bounty_id: 1, reason: "No longer needed" } });
    expect(() => cancelSoleFundedIntent(base, other, "x")).toThrow(/creator/);
    const refundable = { ...base, bounty: { ...base.bounty, status: "refunding" as const, refund_reason: "expired" as const } };
    expect(claimRefundIntent(refundable, creator).executeMessage).toEqual({ claim_refund: { bounty_id: 1 } });
    expect(() => claimRefundIntent({ ...refundable, claims: [{ bounty_id: 1, contributor: creator, amount: "2500000", claimed_at: "2" }] }, creator))
      .toThrow(/already claimed/);
  });
});
