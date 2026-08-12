import type { Epoch, GaugeActionContext, GaugeData } from "../gauge";

export const voter = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
export const openEpoch = {
  gaugeId: 0, epochId: 2, snapshotHeight: 40_000_002, snapshotTotalPower: "1000", participatingPower: "500", totalCast: "400",
  minTurnoutBps: 2000, epochBudget: "10000000", denom: "ujuno", opensAt: 2_000, closesAt: 3_000, voterCount: 1, optionCount: 2,
  outcome: "open", messageCount: 0, cleanup: { phase: "ballots", cursor: 0, complete: false },
} as const;
export const priorEpoch = {
  ...openEpoch, epochId: 1, snapshotHeight: 39_000_001, opensAt: 1_000, closesAt: 1_900, outcome: "distributed", messageCount: 1,
} as const;
export const gaugeData: GaugeData = {
  config: { owner: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", daoCore: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", votingPowers: "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2", guardian: voter },
  gauge: { id: 0, title: "Hack Juno", adapter: "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n", epochSize: 1000, minPercentSelected: "0.01", maxOptionsSelected: 10, maxAvailablePercentage: "0.5", isStopped: false, nextEpoch: 3000, currentEpoch: 2, snapshotPolicy: { minTurnoutBps: 2000, epochBudget: "10000000", denom: "ujuno" } },
  epochs: [priorEpoch, openEpoch], current: openEpoch, previous: priorEpoch,
  options: [{ option: "alpha", power: "300" }, { option: "do-not-distribute", power: "100" }],
  previousOptions: [{ option: "alpha", power: "400" }, { option: "do-not-distribute", power: "0" }],
  ballot: { voter, power: "100", votes: [{ option: "alpha", weight: "0.5" }], castAt: 2100, revisedAt: 2200, revisions: 1, receiptIndex: 1 },
  votingPower: { power: "100", height: 40_000_002 }, vaultBalance: "10000000", chainTimeNanos: "2500000000000", observationHeight: 40_000_100, refreshedAt: new Date("2026-08-12T00:00:00Z"), weakConsistency: true, adapterStopped: false,
  currentRegistryOptions: ["alpha", "do-not-distribute"],
};
export const gaugeContext: GaugeActionContext = { data: gaugeData, fingerprint: "gauge:0:epoch:2" };

export const rawEpoch = (epoch: Epoch = openEpoch) => ({
  gauge_id: epoch.gaugeId, epoch_id: epoch.epochId, snapshot_height: epoch.snapshotHeight, snapshot_total_power: epoch.snapshotTotalPower,
  participating_power: epoch.participatingPower, total_cast: epoch.totalCast, min_turnout_bps: epoch.minTurnoutBps, epoch_budget: epoch.epochBudget,
  denom: epoch.denom, opens_at: epoch.opensAt, closes_at: epoch.closesAt, voter_count: epoch.voterCount, option_count: epoch.optionCount,
  outcome: epoch.outcome === "distributed" ? { distributed: { message_count: epoch.messageCount } } : epoch.outcome,
  cleanup: epoch.cleanup,
});
