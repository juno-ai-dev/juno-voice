import { describe, expect, it, vi } from "vitest";
import { createGaugeDataSource, mapBallotResponse, mapEpoch, mapGauge, mapGaugeConfig, mapVotingPower, type GaugeDataSource } from "./gauge";
import { config } from "./test/bountyFixtures";
import { openEpoch, priorEpoch, rawEpoch, voter } from "./test/gaugeFixtures";

const rawConfig = { owner: config.vaultContract, dao_core: config.vaultContract, voting_powers: config.votingContract, hook_caller: config.gaugeContract, power_source: { epoch_snapshot: { guardian: voter } } };
const rawGauge = { id: 0, title: "Hack Juno", adapter: config.registryContract, epoch_size: 1000, min_percent_selected: "0.01", max_options_selected: 10, max_available_percentage: "0.5", is_stopped: false, next_epoch: 3000, reset: null, snapshot_policy: { min_turnout_bps: 2000, epoch_budget: "10000000", denom: "ujuno" }, current_epoch: 2 };
const ballot = { ballot: { voter, power: "100", votes: [{ option: "alpha", weight: "0.5" }], cast_at: 2100, revised_at: 2200, revisions: 1, receipt_index: 1 } };

function connector(allocationCount = 2) {
  const codeIds = new Map<string, number>([[config.gaugeContract, config.gaugeCodeId], [config.votingContract, config.votingCodeId], [config.vaultContract, config.vaultCodeId], [config.registryContract, config.registryCodeId]]);
  const checksums = new Map<number, string>([[config.gaugeCodeId, config.gaugeCodeChecksum], [config.votingCodeId, config.votingCodeChecksum], [config.vaultCodeId, config.vaultCodeChecksum], [config.registryCodeId, config.registryCodeChecksum]]);
  return vi.fn(async () => ({
    getChainId: async () => "juno-1", getHeight: async () => 40_000_100, getChainTimeNanos: async () => "2500000000000", getBalance: async () => "10000000", disconnect: vi.fn(),
    getContract: async (address: string) => ({ address, codeId: codeIds.get(address)! }), getCodeDetails: async (codeId: number) => ({ checksum: checksums.get(codeId)! }),
    queryContractSmart: async (address: string, query: Record<string, Record<string, unknown>>) => {
      const action = Object.keys(query)[0];
      if (address === config.vaultContract) return action === "voting_module" ? config.votingContract : [{ address: config.gaugeContract, prefix: "A", status: "enabled" }];
      if (address === config.votingContract) return action === "dao" ? config.vaultContract : { power: "100", height: openEpoch.snapshotHeight };
      if (address === config.registryContract) return action === "pause" ? { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null } : { options: ["alpha", "do-not-distribute"] };
      if (action === "config") return rawConfig;
      if (action === "gauge") return rawGauge;
      if (action === "list_epochs") return { epochs: [rawEpoch(priorEpoch), rawEpoch(openEpoch)] };
      if (action === "epoch_allocations") {
        const epoch = query.epoch_allocations.epoch;
        const values = epoch === 1 ? [["alpha", "400"], ["do-not-distribute", "0"]] : [["alpha", "300"], ["do-not-distribute", "100"]];
        return { allocations: values.slice(0, allocationCount) };
      }
      if (action === "epoch_ballot") return ballot;
      throw new Error(`unexpected ${address}:${action}`);
    },
  }));
}

describe("strict pinned gauge schema decoders", () => {
  it("decodes exact gauge, epoch, ballot and historical power shapes", () => {
    expect(mapGaugeConfig(rawConfig)).toMatchObject({ owner: config.vaultContract, votingPowers: config.votingContract });
    expect(mapGauge(rawGauge)).toMatchObject({ id: 0, currentEpoch: 2, snapshotPolicy: { epochBudget: "10000000" } });
    expect(mapEpoch(rawEpoch(priorEpoch))).toMatchObject({ epochId: 1, outcome: "distributed", messageCount: 1 });
    expect(mapBallotResponse(ballot)).toMatchObject({ voter, votes: [{ option: "alpha", weight: "0.5" }] });
    expect(mapVotingPower({ power: "100", height: 40_000_002 })).toEqual({ power: "100", height: 40_000_002 });
  });
  it.each([
    ["unknown gauge field", () => mapGauge({ ...rawGauge, future: true })],
    ["hook-mode binding", () => mapGaugeConfig({ ...rawConfig, power_source: { hook: { hook_caller: voter } } })],
    ["duplicate ballot option", () => mapBallotResponse({ ballot: { ...ballot.ballot, votes: [...ballot.ballot.votes, ...ballot.ballot.votes] } })],
    ["wrong power height type", () => mapVotingPower({ power: "100", height: "40000002" })],
  ])("fails closed on %s", (_, decode) => expect(decode).toThrow(/Malformed/));
});

describe("canonical epoch and connected-ballot discovery", () => {
  it("verifies every deployment binding and discovers current/previous fixed snapshots", async () => {
    const source: GaugeDataSource = createGaugeDataSource(config, connector());
    const data = await source.loadGauge(voter);
    expect(data.current?.epochId).toBe(2); expect(data.previous?.epochId).toBe(1);
    expect(data.options.map((item) => item.option)).toEqual(["alpha", "do-not-distribute"]);
    expect(data.previousOptions[0]).toEqual({ option: "alpha", power: "400" });
    expect(data.ballot?.voter).toBe(voter); expect(data.votingPower).toEqual({ power: "100", height: openEpoch.snapshotHeight });
    expect(data.vaultBalance).toBe("10000000");
  });
  it("does not silently accept an incomplete fixed epoch option snapshot", async () => {
    await expect(createGaugeDataSource(config, connector(1)).loadGauge(voter)).rejects.toThrow("option snapshot is incomplete");
  });
});
