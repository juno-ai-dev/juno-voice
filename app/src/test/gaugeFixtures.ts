import type { Epoch, GaugeActionContext, GaugeData } from "../gauge";

export const voter = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
export const openEpoch = {
  gaugeId: 0, epochId: 2, snapshotHeight: 40_000_002, snapshotTotalPower: "1000", participatingPower: "500", allocatedPower: "400", totalCast: "400",
  retainedOption: "do-not-distribute", retainedOptionPower: "100", unallocatedPower: "100", selectedProjectPower: "0", emittedValue: "0", retainedValue: "0",
  minTurnoutBps: 2000, policyVersion: 1, epochBudget: "10000000", denom: "ujuno", opensAt: 2_000, closesAt: 3_000, executionDeadline: 4_000, voterCount: 1, optionCount: 2,
  outcome: "open", messageCount: 0, insufficientFunds: null, abortReason: null, cleanup: { phase: "ballots", cursor: 0, complete: false },
} as const;
export const priorEpoch = {
  ...openEpoch, epochId: 1, snapshotHeight: 39_000_001, opensAt: 1_000, closesAt: 1_900, executionDeadline: 2_900,
  selectedProjectPower: "400", emittedValue: "8000000", retainedValue: "2000000", outcome: "distributed", messageCount: 1,
} as const;
export const gaugeData: GaugeData = {
  config: { owner: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", daoCore: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg", votingPowers: "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2", guardian: voter },
  gauge: { id: 0, title: "Hack Juno", adapter: "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n", epochSize: 1000, minPercentSelected: "0.01", maxOptionsSelected: 10, maxAvailablePercentage: "0.5", isStopped: false, nextEpoch: 3000, currentEpoch: 2, snapshotPolicy: { minTurnoutBps: 2000, epochBudget: "10000000", denom: "ujuno", retainedOption: "do-not-distribute", executionWindowSeconds: 1000 } },
  epochs: [priorEpoch, openEpoch], current: openEpoch, previous: priorEpoch,
  options: [{ option: "do-not-distribute", power: "100" }, { option: "project:1", power: "300" }],
  previousOptions: [{ option: "do-not-distribute", power: "0" }, { option: "project:1", power: "400" }],
  ballot: { voter, power: "100", votes: [{ option: "project:1", weight: "0.5" }], castAt: 2100, revisedAt: 2200, revisions: 1, receiptIndex: 1 },
  votingPower: { power: "100", height: 40_000_002 }, vaultBalance: "10000000", chainTimeNanos: "2500000000000", observationHeight: 40_000_100, refreshedAt: new Date("2026-08-12T00:00:00Z"), weakConsistency: true, adapterStopped: false,
  currentRegistryOptions: ["do-not-distribute", "project:1"],
  registryProjects: [{ id: 1, owner: voter, payout_address: voter, metadata_uri: "ipfs://alpha-project", metadata_digest: `sha256:${"a".repeat(64)}`, status: "active", created_at: "1", updated_at: "1", status_history_count: 1, address_history_count: 0, provenance: { kind: "bonded_registration", applicant: voter }, bond: { amount: "1000000", depositor: voter, state: "deposited" }, pending_payout_address: null, latest_review: null }],
};
export const gaugeContext: GaugeActionContext = { data: gaugeData, fingerprint: "gauge:0:epoch:2" };

export const rawEpoch = (epoch: Epoch = openEpoch) => ({
  gauge_id: epoch.gaugeId, epoch_id: epoch.epochId, snapshot_height: epoch.snapshotHeight, snapshot_total_power: epoch.snapshotTotalPower,
  participating_power: epoch.participatingPower, allocated_power: epoch.allocatedPower, total_cast: epoch.totalCast, retained_option: epoch.retainedOption,
  retained_option_power: epoch.retainedOptionPower, unallocated_power: epoch.unallocatedPower, selected_project_power: epoch.selectedProjectPower,
  emitted_value: epoch.emittedValue, retained_value: epoch.retainedValue, min_turnout_bps: epoch.minTurnoutBps, policy_version: epoch.policyVersion, epoch_budget: epoch.epochBudget,
  denom: epoch.denom, opens_at: epoch.opensAt, closes_at: epoch.closesAt, execution_deadline: epoch.executionDeadline, voter_count: epoch.voterCount, option_count: epoch.optionCount,
  outcome: epoch.outcome === "distributed" ? { distributed: { message_count: epoch.messageCount } } : epoch.outcome === "insufficient_funds" ? { insufficient_funds: epoch.insufficientFunds } : epoch.outcome === "aborted" ? { aborted: { reason: epoch.abortReason } } : epoch.outcome,
  cleanup: epoch.cleanup,
});
