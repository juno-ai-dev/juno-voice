import { describe, expect, it } from "vitest";
import { confirmGaugeMutation, type GaugeEvent } from "./gaugeConfirmation";
import type { GaugeActionContext } from "./gauge";
import { gaugeContext, gaugeData, voter } from "./test/gaugeFixtures";

const event = (action: string, extra: Record<string, string> = {}): GaugeEvent => ({ type: "wasm", attributes: Object.entries({ action, sender: voter, gauge_id: "0", epoch_id: "2", ...extra }).map(([key, value]) => ({ key, value })) });
const voteEvent = (context: GaugeActionContext, optionCount: number, extra: Record<string, string> = {}) => event("place_snapshot_vote", {
  snapshot_height: String(context.data.current!.snapshotHeight),
  voting_power: context.data.votingPower!.power,
  option_count: String(optionCount),
  participating_power: context.data.current!.participatingPower,
  total_cast: context.data.current!.totalCast,
  ...extra,
});
const mutation = (action: "place_votes" | "remove_votes", before: GaugeActionContext, refreshed: GaugeActionContext, votes: unknown) => ({
  action, events: [voteEvent(refreshed, Array.isArray(votes) ? votes.length : 0)], before, refreshed, sender: voter,
  executeMessage: { place_votes: { gauge: 0, votes } }, funds: [],
} as const);

describe("canonical gauge post-transaction confirmation", () => {
  it("requires an existing ballot revision and rejects stale same-preference state", () => {
    const refreshed = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "2501000000000", ballot: { ...gaugeData.ballot!, revisedAt: 2501, revisions: 2 } }, fingerprint: "gauge:after" };
    const reviewed = [{ option: "alpha", weight: "0.500000000000000000" }];
    expect(() => confirmGaugeMutation(mutation("place_votes", gaugeContext, refreshed, reviewed))).not.toThrow();
    expect(() => confirmGaugeMutation(mutation("place_votes", gaugeContext, gaugeContext, reviewed))).toThrow(/revision|time/);

    const wrongIdentity = { ...refreshed, data: { ...refreshed.data, ballot: { ...refreshed.data.ballot!, voter: `${voter}x` } } };
    const wrongPower = { ...refreshed, data: { ...refreshed.data, ballot: { ...refreshed.data.ballot!, power: "99" } } };
    const wrongVotingPower = { ...refreshed, data: { ...refreshed.data, votingPower: { ...refreshed.data.votingPower!, power: "99" } } };
    const wrongCast = { ...refreshed, data: { ...refreshed.data, ballot: { ...refreshed.data.ballot!, castAt: 2501 } } };
    const wrongReceipt = { ...refreshed, data: { ...refreshed.data, ballot: { ...refreshed.data.ballot!, receiptIndex: 2 } } };
    for (const state of [wrongIdentity, wrongPower, wrongVotingPower, wrongCast, wrongReceipt])
      expect(() => confirmGaugeMutation(mutation("place_votes", gaugeContext, state, reviewed))).toThrow(/revision|semantically/);
  });

  it("accepts contract same-second revisions but requires a later second when pre-state makes it representable", () => {
    const sameSecondBefore = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "2200000000000" } };
    const sameSecondAfter = { ...sameSecondBefore, data: { ...sameSecondBefore.data, ballot: { ...gaugeData.ballot!, revisions: 2 } } };
    expect(() => confirmGaugeMutation(mutation("place_votes", sameSecondBefore, sameSecondAfter, gaugeData.ballot!.votes))).not.toThrow();

    const staleTimestamp = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "2501000000000", ballot: { ...gaugeData.ballot!, revisions: 2 } } };
    expect(() => confirmGaugeMutation(mutation("place_votes", gaugeContext, staleTimestamp, gaugeData.ballot!.votes))).toThrow(/revision|time/);
  });

  it("confirms a first placement only with revision zero and exact event/state attributes", () => {
    const before = { ...gaugeContext, data: { ...gaugeData, ballot: null, current: { ...gaugeData.current!, participatingPower: "400", totalCast: "350", voterCount: 0 } } };
    const refreshed = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "2501000000000", ballot: { ...gaugeData.ballot!, castAt: 2501, revisedAt: 2501, revisions: 0 } } };
    expect(() => confirmGaugeMutation(mutation("place_votes", before, refreshed, gaugeData.ballot!.votes))).not.toThrow();
    const revised = { ...refreshed, data: { ...refreshed.data, ballot: { ...refreshed.data.ballot!, revisions: 1 } } };
    expect(() => confirmGaugeMutation(mutation("place_votes", before, revised, gaugeData.ballot!.votes))).toThrow(/first placement/);
  });

  it("validates every vote event attribute against refreshed state", () => {
    const refreshed = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "2501000000000", ballot: { ...gaugeData.ballot!, revisedAt: 2501, revisions: 2 } } };
    const reviewed = gaugeData.ballot!.votes;
    for (const [key, value] of Object.entries({ snapshot_height: "9", voting_power: "9", participating_power: "9", total_cast: "9", option_count: "9" })) {
      const input = mutation("place_votes", gaugeContext, refreshed, reviewed);
      expect(() => confirmGaugeMutation({ ...input, events: [voteEvent(refreshed, 1, { [key]: value })] })).toThrow();
    }
  });

  it("confirms removal only from the exact pre-ballot transition and refreshed event tallies", () => {
    const refreshed = { ...gaugeContext, data: { ...gaugeData, ballot: null, current: { ...gaugeData.current!, participatingPower: "400", totalCast: "350", voterCount: 0 } } };
    expect(() => confirmGaugeMutation(mutation("remove_votes", gaugeContext, refreshed, null))).not.toThrow();
    expect(() => confirmGaugeMutation(mutation("remove_votes", gaugeContext, gaugeContext, null))).toThrow(/removal/);
    const wrongTransition = { ...refreshed, data: { ...refreshed.data, current: { ...refreshed.data.current!, totalCast: "351" } } };
    expect(() => confirmGaugeMutation(mutation("remove_votes", gaugeContext, wrongTransition, null))).toThrow(/removal|transition/);
  });

  it("requires a new canonical epoch for open and a terminal matching outcome for execute", () => {
    const beforeOpen = { ...gaugeContext, data: { ...gaugeData, current: gaugeData.previous } };
    expect(() => confirmGaugeMutation({ action: "open_epoch", events: [event("open_snapshot_epoch", { snapshot_height: String(gaugeData.current!.snapshotHeight) })], before: beforeOpen, refreshed: gaugeContext, sender: voter, executeMessage: { open_epoch: { gauge: 0 } }, funds: [] })).not.toThrow();
    const terminal = { ...gaugeContext, data: { ...gaugeData, current: { ...gaugeData.current!, outcome: "no_distribution_turnout" as const } } };
    expect(() => confirmGaugeMutation({ action: "execute", events: [event("execute_snapshot_epoch", { outcome: "no_distribution_turnout" })], before: gaugeContext, refreshed: terminal, sender: voter, executeMessage: { execute: { gauge: 0 } }, funds: [] })).not.toThrow();
    expect(() => confirmGaugeMutation({ action: "execute", events: [event("execute_snapshot_epoch", { outcome: "distributed" })], before: gaugeContext, refreshed: terminal, sender: voter, executeMessage: { execute: { gauge: 0 } }, funds: [] })).toThrow("outcome");
  });

  it("requires exactly one matching action event for open, vote, remove, and execute while allowing unrelated wasm events", () => {
    const revised = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "2501000000000", ballot: { ...gaugeData.ballot!, revisedAt: 2501, revisions: 2 } } };
    const removed = { ...gaugeContext, data: { ...gaugeData, ballot: null, current: { ...gaugeData.current!, participatingPower: "400", totalCast: "350", voterCount: 0 } } };
    const beforeOpen = { ...gaugeContext, data: { ...gaugeData, current: gaugeData.previous } };
    const terminal = { ...gaugeContext, data: { ...gaugeData, current: { ...gaugeData.current!, outcome: "no_distribution_turnout" as const } } };
    const cases = [
      { input: { action: "open_epoch", before: beforeOpen, refreshed: gaugeContext, sender: voter, executeMessage: { open_epoch: { gauge: 0 } }, funds: [] }, matching: event("open_snapshot_epoch", { snapshot_height: String(gaugeData.current!.snapshotHeight) }) },
      { input: { ...mutation("place_votes", gaugeContext, revised, gaugeData.ballot!.votes), events: undefined }, matching: voteEvent(revised, gaugeData.ballot!.votes.length) },
      { input: { ...mutation("remove_votes", gaugeContext, removed, null), events: undefined }, matching: voteEvent(removed, 0) },
      { input: { action: "execute", before: gaugeContext, refreshed: terminal, sender: voter, executeMessage: { execute: { gauge: 0 } }, funds: [] }, matching: event("execute_snapshot_epoch", { outcome: "no_distribution_turnout" }) },
    ] as const;
    const unrelated = event("unrelated_wasm_action");
    for (const { input, matching } of cases) {
      expect(() => confirmGaugeMutation({ ...input, events: [unrelated, matching] })).not.toThrow();
      expect(() => confirmGaugeMutation({ ...input, events: [unrelated] })).toThrow(/event/);
      expect(() => confirmGaugeMutation({ ...input, events: [matching, unrelated, matching] })).toThrow(/event/);
    }
  });

  it("rejects missing events, wrong epochs, and attached funds", () => {
    expect(() => confirmGaugeMutation({ action: "place_votes", events: [], before: gaugeContext, refreshed: gaugeContext, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: [] } }, funds: [] })).toThrow("event");
    expect(() => confirmGaugeMutation({ action: "place_votes", events: [voteEvent(gaugeContext, 1)], before: gaugeContext, refreshed: gaugeContext, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: gaugeData.ballot!.votes } }, funds: [{ denom: "ujuno", amount: "1" }] })).toThrow("must not attach");
  });
});
