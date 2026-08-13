import { describe, expect, it } from "vitest";
import { DECIMAL_SCALE, canonicalDecimal, parseDecimal18 } from "./gauge";
import { buildGaugeIntent, gaugeEligibility, validatePreferences } from "./gaugeActions";
import { config } from "./test/bountyFixtures";
import { gaugeContext, gaugeData, voter } from "./test/gaugeFixtures";

describe("18-decimal gauge preference validation", () => {
  it("parses and canonicalizes exact fixed point without floating point", () => {
    expect(parseDecimal18("0.123456789012345678")).toBe(123456789012345678n);
    expect(parseDecimal18("1")).toBe(DECIMAL_SCALE);
    expect(canonicalDecimal("0.500000000000000000")).toBe("0.5");
    expect(() => parseDecimal18("0.1234567890123456789")).toThrow("at most 18");
    expect(() => parseDecimal18("1e-3")).toThrow("decimal");
    expect(() => parseDecimal18("01.0")).toThrow("decimal");
  });
  it("accepts positive unique fixed options summing to one or less", () => {
    expect(validatePreferences([{ option: "alpha", weight: "0.333333333333333333" }, { option: "do-not-distribute", weight: "0.666666666666666667" }], ["alpha", "do-not-distribute"], "1000000000000000000"))
      .toEqual([{ option: "alpha", weight: "0.333333333333333333" }, { option: "do-not-distribute", weight: "0.666666666666666667" }]);
  });
  it.each([
    ["duplicate", [{ option: "alpha", weight: "0.2" }, { option: "alpha", weight: "0.3" }], "Duplicate"],
    ["unknown", [{ option: "today-only", weight: "0.2" }], "not an option fixed"],
    ["zero", [{ option: "alpha", weight: "0" }], "positive"],
    ["over one", [{ option: "alpha", weight: "0.6" }, { option: "do-not-distribute", weight: "0.400000000000000001" }], "at most 1"],
  ])("rejects %s preferences", (_, votes, message) => expect(() => validatePreferences(votes, ["alpha", "do-not-distribute"], "100")).toThrow(message));
  it("rejects weights that floor to zero at fixed historical power", () =>
    expect(() => validatePreferences([{ option: "alpha", weight: "0.009999999999999999" }], ["alpha"], "100")).toThrow("rounds to zero"));
});

describe("canonical gauge eligibility and messages", () => {
  it("builds exact placement, revision/removal, open, and execute messages with empty funds", () => {
    expect(buildGaugeIntent(config, voter, gaugeContext, "place_votes", [{ option: "project:1", weight: "0.5" }])).toMatchObject({ contract: config.gaugeContract, executeMessage: { place_votes: { gauge: 0, votes: [{ option: "project:1", weight: "0.5" }] } }, funds: [] });
    expect(buildGaugeIntent(config, voter, gaugeContext, "remove_votes")).toMatchObject({ executeMessage: { place_votes: { gauge: 0, votes: null } }, funds: [] });
    const terminal = { ...gaugeContext, data: { ...gaugeData, current: { ...gaugeData.current!, outcome: "distributed" as const, messageCount: 1 }, gauge: { ...gaugeData.gauge, nextEpoch: 2400 } } };
    expect(buildGaugeIntent(config, voter, terminal, "open_epoch")).toMatchObject({
      executeMessage: { open_epoch: { gauge: 0 } },
      consequences: [expect.stringContaining("$JUNO 10")],
    });
    const closed = { ...gaugeContext, data: { ...gaugeData, chainTimeNanos: "3000000000000" } };
    expect(buildGaugeIntent(config, voter, closed, "execute").executeMessage).toEqual({ execute: { gauge: 0 } });
  });
  it.each([
    ["wrong epoch time", { chainTimeNanos: "3000000000000" }],
    ["stopped gauge", { gauge: { ...gaugeData.gauge, isStopped: true } }],
    ["stopped adapter", { adapterStopped: true }],
    ["no historical power", { votingPower: { power: "0", height: gaugeData.current!.snapshotHeight } }],
  ])("disables voting for %s", (_, change) => {
    const data = { ...gaugeData, ...change } as typeof gaugeData;
    expect(gaugeEligibility({ data, fingerprint: "x" }).vote).toBe(false);
    expect(() => buildGaugeIntent(config, voter, { data, fingerprint: "x" }, "place_votes", [{ option: "project:1", weight: "1" }])).toThrow("not eligible");
  });
  it("fails open closed but permits terminal execution to record an emitted-value shortfall", () => {
    const data = { ...gaugeData, vaultBalance: "9999999", chainTimeNanos: "3000000000000" };
    const eligibility = gaugeEligibility({ data, fingerprint: "x" });
    expect(eligibility.open).toBe(false);
    expect(eligibility.execute).toBe(true);
  });
  it("allows terminal no-turnout execution without pretending distribution needs funding", () => {
    const data = { ...gaugeData, vaultBalance: "0", adapterStopped: true, chainTimeNanos: "3000000000000", current: { ...gaugeData.current!, participatingPower: "1" } };
    expect(gaugeEligibility({ data, fingerprint: "x" }).execute).toBe(true);
    expect(buildGaugeIntent(config, voter, { data, fingerprint: "x" }, "execute").executeMessage).toEqual({ execute: { gauge: 0 } });
  });
});
