import { describe, expect, it } from "vitest";
import { confirmBountyMutation } from "./bountyConfirmation";
import { bounty } from "./test/bountyFixtures";
const sender = bounty.creator;
describe("canonical event plus refreshed-state confirmation", () => {
  it("confirms creation only when event and refreshed state agree", () => {
    const refreshed = { ...bounty, total_contribution: "1000000" };
    expect(confirmBountyMutation({ action: "create_bounty", sender, amount: "1000000", refreshed,
      events: [{ type: "juno_voice_bounties.bounty_created", attributes: [
        { key: "bounty_id", value: "1" }, { key: "creator", value: sender }, { key: "amount", value: "1000000" }] }] }))
      .toEqual({ bountyId: 1, eventType: "juno_voice_bounties.bounty_created" });
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
