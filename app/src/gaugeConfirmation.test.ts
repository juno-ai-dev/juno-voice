import { describe, expect, it } from "vitest";
import { confirmGaugeMutation, type GaugeEvent } from "./gaugeConfirmation";
import { gaugeContext, gaugeData, voter } from "./test/gaugeFixtures";

const event = (action: string, extra: Record<string, string> = {}): GaugeEvent => ({ type: "wasm", attributes: Object.entries({ action, sender: voter, gauge_id: "0", epoch_id: "2", ...extra }).map(([key, value]) => ({ key, value })) });
describe("canonical gauge post-transaction confirmation", () => {
  it("requires semantic ballot equality as well as matching event attributes", () => {
    const before = { ...gaugeContext, data: { ...gaugeData, ballot: null } };
    expect(() => confirmGaugeMutation({ action: "place_votes", events: [event("place_snapshot_vote", { option_count: "1" })], before, refreshed: gaugeContext, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: [{ option: "alpha", weight: "0.500000000000000000" }] } }, funds: [] })).not.toThrow();
    expect(() => confirmGaugeMutation({ action: "place_votes", events: [event("place_snapshot_vote", { option_count: "1" })], before, refreshed: { ...gaugeContext, data: { ...gaugeData, ballot: { ...gaugeData.ballot!, votes: [{ option: "alpha", weight: "0.4" }] } } }, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: [{ option: "alpha", weight: "0.5" }] } }, funds: [] })).toThrow("semantically match");
  });
  it("confirms explicit null removal only after the refreshed ballot is null", () => {
    const refreshed = { ...gaugeContext, data: { ...gaugeData, ballot: null } };
    expect(() => confirmGaugeMutation({ action: "remove_votes", events: [event("place_snapshot_vote", { option_count: "0" })], before: gaugeContext, refreshed, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: null } }, funds: [] })).not.toThrow();
    expect(() => confirmGaugeMutation({ action: "remove_votes", events: [event("place_snapshot_vote", { option_count: "0" })], before: gaugeContext, refreshed: gaugeContext, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: null } }, funds: [] })).toThrow("removal");
  });
  it("requires a new canonical epoch for open and a terminal matching outcome for execute", () => {
    const beforeOpen = { ...gaugeContext, data: { ...gaugeData, current: gaugeData.previous } };
    expect(() => confirmGaugeMutation({ action: "open_epoch", events: [event("open_snapshot_epoch", { snapshot_height: String(gaugeData.current!.snapshotHeight) })], before: beforeOpen, refreshed: gaugeContext, sender: voter, executeMessage: { open_epoch: { gauge: 0 } }, funds: [] })).not.toThrow();
    const terminal = { ...gaugeContext, data: { ...gaugeData, current: { ...gaugeData.current!, outcome: "no_distribution_turnout" as const } } };
    expect(() => confirmGaugeMutation({ action: "execute", events: [event("execute_snapshot_epoch", { outcome: "no_distribution_turnout" })], before: gaugeContext, refreshed: terminal, sender: voter, executeMessage: { execute: { gauge: 0 } }, funds: [] })).not.toThrow();
    expect(() => confirmGaugeMutation({ action: "execute", events: [event("execute_snapshot_epoch", { outcome: "distributed" })], before: gaugeContext, refreshed: terminal, sender: voter, executeMessage: { execute: { gauge: 0 } }, funds: [] })).toThrow("outcome");
  });
  it("rejects missing events, wrong epochs, and attached funds", () => {
    expect(() => confirmGaugeMutation({ action: "place_votes", events: [], before: gaugeContext, refreshed: gaugeContext, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: [] } }, funds: [] })).toThrow("event");
    expect(() => confirmGaugeMutation({ action: "place_votes", events: [event("place_snapshot_vote", { option_count: "1" })], before: gaugeContext, refreshed: gaugeContext, sender: voter, executeMessage: { place_votes: { gauge: 0, votes: gaugeData.ballot!.votes } }, funds: [{ denom: "ujuno", amount: "1" }] })).toThrow("must not attach");
  });
});
