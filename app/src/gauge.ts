import type { AppConfig } from "./config";
import { connectRpc, type Connect, type RpcClient } from "./rpc";
import { mapProject, type Project } from "./registry";

export const GAUGE_ID = 0 as const;
export const GAUGE_PAGE_LIMIT = 100;
export const DECIMAL_SCALE = 1_000_000_000_000_000_000n;
const U128_MAX = 340282366920938463463374607431768211455n;

const bad = (where: string): never => { throw new Error(`Malformed ${where} response from RPC.`); };
const object = (value: unknown, where: string): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : bad(where);
const text = (value: unknown, where: string) => typeof value === "string" ? value : bad(where);
const bool = (value: unknown, where: string) => typeof value === "boolean" ? value : bad(where);
const integer = (value: unknown, where: string) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad(where);
const uint = (value: unknown, where: string) => {
  const result = text(value, where);
  if (!/^(0|[1-9]\d*)$/.test(result) || BigInt(result) > U128_MAX) bad(where);
  return result;
};
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) bad("gauge object");
};

/** Parse a CosmWasm Decimal without ever entering JavaScript floating-point arithmetic. */
export function parseDecimal18(value: string, label = "Weight"): bigint {
  if (!/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value))
    throw new Error(`${label} must be a non-negative decimal with at most 18 fractional digits.`);
  const [whole, fraction = ""] = value.split(".");
  const atomics = BigInt(whole) * DECIMAL_SCALE + BigInt(fraction.padEnd(18, "0") || "0");
  if (atomics > U128_MAX) throw new Error(`${label} exceeds the contract Decimal range.`);
  return atomics;
}

export function canonicalDecimal(value: string): string {
  const atomics = parseDecimal18(value);
  const whole = atomics / DECIMAL_SCALE;
  const fraction = (atomics % DECIMAL_SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export interface GaugeConfig {
  owner: string; daoCore: string; votingPowers: string; guardian: string;
}
export interface GaugeState {
  id: number; title: string; adapter: string; epochSize: number; minPercentSelected: string | null;
  maxOptionsSelected: number; maxAvailablePercentage: string | null; isStopped: boolean;
  nextEpoch: number; currentEpoch: number | null;
  snapshotPolicy: { minTurnoutBps: number; epochBudget: string; denom: string; retainedOption: string | null; executionWindowSeconds: number };
}
export type EpochOutcome = "open" | "distributed" | "no_distribution_turnout" | "no_distribution_zero_participation" |
  "no_eligible_options" | "insufficient_funds" | "expired" | "aborted";
export interface Epoch {
  gaugeId: number; epochId: number; snapshotHeight: number; snapshotTotalPower: string;
  participatingPower: string; allocatedPower: string; totalCast: string; retainedOption: string | null;
  retainedOptionPower: string; unallocatedPower: string; selectedProjectPower: string; emittedValue: string; retainedValue: string;
  minTurnoutBps: number; policyVersion: number; epochBudget: string; denom: string; opensAt: number; closesAt: number;
  executionDeadline: number; voterCount: number; optionCount: number; outcome: EpochOutcome; messageCount: number;
  insufficientFunds: { required: string; available: string } | null; abortReason: string | null;
  cleanup: { phase: "ballots" | "options" | "complete"; cursor: number; complete: boolean };
}
export interface GaugeVote { option: string; weight: string }
export interface Ballot {
  voter: string; power: string; votes: GaugeVote[]; castAt: number; revisedAt: number; revisions: number; receiptIndex: number;
}
export interface GaugeOption { option: string; power: string }
export interface VotingPower { power: string; height: number }
export interface GaugeData {
  config: GaugeConfig; gauge: GaugeState; epochs: Epoch[]; current: Epoch | null; previous: Epoch | null;
  options: GaugeOption[]; previousOptions: GaugeOption[]; ballot: Ballot | null; votingPower: VotingPower | null; vaultBalance: string;
  chainTimeNanos: string; observationHeight: number; refreshedAt: Date; weakConsistency: true;
  adapterStopped: boolean;
  currentRegistryOptions: string[];
  registryProjects: Project[];
}
export interface GaugeActionContext { data: GaugeData; fingerprint: string }
export interface GaugeDataSource {
  loadGauge(voter?: string): Promise<GaugeData>;
  loadActionContext(voter: string | null): Promise<GaugeActionContext>;
}

export const gaugeQueries = {
  config: () => ({ config: {} }), gauge: () => ({ gauge: { id: GAUGE_ID } }),
  epochs: (startAfter: number | null) => ({ list_epochs: { gauge: GAUGE_ID, start_after: startAfter, limit: GAUGE_PAGE_LIMIT } }),
  allocations: (epoch: number, startAfter: string | null) => ({ epoch_allocations: { gauge: GAUGE_ID, epoch, start_after: startAfter, limit: GAUGE_PAGE_LIMIT } }),
  ballot: (epoch: number, voter: string) => ({ epoch_ballot: { gauge: GAUGE_ID, epoch, voter } }),
  votingPower: (address: string, height: number) => ({ voting_power_at_height: { address, height } }),
  vaultVotingModule: () => ({ voting_module: {} }), vaultProposalModules: () => ({ proposal_modules: { start_after: null, limit: 30 } }),
  votingDao: () => ({ dao: {} }),
  registryPause: () => ({ pause: {} }),
  registryOptions: (startAfter: string | null) => ({ all_options: { start_after: startAfter, limit: 50 } }),
  registryProjects: (startAfter: number | null) => ({ projects: { start_after: startAfter, limit: 50 } }),
} as const;

export function mapGaugeConfig(value: unknown): GaugeConfig {
  const x = object(value, "gauge config"); exact(x, ["owner", "dao_core", "voting_powers", "hook_caller", "power_source"]);
  const source = object(x.power_source, "gauge power source"); exact(source, ["epoch_snapshot"]);
  const snapshot = object(source.epoch_snapshot, "gauge power source"); exact(snapshot, ["guardian"]);
  return { owner: text(x.owner, "gauge config"), daoCore: text(x.dao_core, "gauge config"), votingPowers: text(x.voting_powers, "gauge config"), guardian: text(snapshot.guardian, "gauge config") };
}
const nullableDecimal = (value: unknown, where: string) => {
  if (value === null) return null;
  const result = text(value, where); parseDecimal18(result, where); return result;
};
export function mapGauge(value: unknown): GaugeState {
  const x = object(value, "gauge");
  exact(x, ["id", "title", "adapter", "epoch_size", "min_percent_selected", "max_options_selected", "max_available_percentage", "is_stopped", "next_epoch", "reset", "snapshot_policy", "current_epoch"]);
  if (x.reset !== null || x.snapshot_policy === null) bad("gauge");
  const policy = object(x.snapshot_policy, "gauge snapshot policy"); exact(policy, ["min_turnout_bps", "epoch_budget", "denom", "retained_option", "execution_window_seconds"]);
  const current = x.current_epoch === null ? null : integer(x.current_epoch, "gauge");
  return { id: integer(x.id, "gauge"), title: text(x.title, "gauge"), adapter: text(x.adapter, "gauge"), epochSize: integer(x.epoch_size, "gauge"),
    minPercentSelected: nullableDecimal(x.min_percent_selected, "minimum selection percentage"), maxOptionsSelected: integer(x.max_options_selected, "gauge"),
    maxAvailablePercentage: nullableDecimal(x.max_available_percentage, "maximum selection percentage"), isStopped: bool(x.is_stopped, "gauge"), nextEpoch: integer(x.next_epoch, "gauge"), currentEpoch: current,
    snapshotPolicy: { minTurnoutBps: integer(policy.min_turnout_bps, "gauge snapshot policy"), epochBudget: uint(policy.epoch_budget, "gauge snapshot policy"), denom: text(policy.denom, "gauge snapshot policy"), retainedOption: policy.retained_option === null ? null : text(policy.retained_option, "gauge snapshot policy"), executionWindowSeconds: integer(policy.execution_window_seconds, "gauge snapshot policy") } };
}
const mapOutcome = (value: unknown): Pick<Epoch, "outcome" | "messageCount" | "insufficientFunds" | "abortReason"> => {
  if (typeof value === "string" && ["open", "no_distribution_turnout", "no_distribution_zero_participation", "no_eligible_options", "expired"].includes(value))
    return { outcome: value as EpochOutcome, messageCount: 0, insufficientFunds: null, abortReason: null };
  const x = object(value, "epoch outcome");
  if (Object.keys(x).length !== 1) bad("epoch outcome");
  if ("distributed" in x) { const body = object(x.distributed, "epoch outcome"); exact(body, ["message_count"]); return { outcome: "distributed", messageCount: integer(body.message_count, "epoch outcome"), insufficientFunds: null, abortReason: null }; }
  if ("insufficient_funds" in x) { const body = object(x.insufficient_funds, "epoch outcome"); exact(body, ["required", "available"]); return { outcome: "insufficient_funds", messageCount: 0, insufficientFunds: { required: uint(body.required, "epoch outcome"), available: uint(body.available, "epoch outcome") }, abortReason: null }; }
  if ("aborted" in x) { const body = object(x.aborted, "epoch outcome"); exact(body, ["reason"]); return { outcome: "aborted", messageCount: 0, insufficientFunds: null, abortReason: text(body.reason, "epoch outcome") }; }
  return bad("epoch outcome");
};
export function mapEpoch(value: unknown): Epoch {
  const x = object(value, "epoch"); exact(x, ["gauge_id", "epoch_id", "snapshot_height", "snapshot_total_power", "participating_power", "allocated_power", "total_cast", "retained_option", "retained_option_power", "unallocated_power", "selected_project_power", "emitted_value", "retained_value", "min_turnout_bps", "policy_version", "epoch_budget", "denom", "opens_at", "closes_at", "execution_deadline", "voter_count", "option_count", "outcome", "cleanup"]);
  const outcome = mapOutcome(x.outcome), cleanup = object(x.cleanup, "epoch cleanup"); exact(cleanup, ["phase", "cursor", "complete"]);
  const phase = text(cleanup.phase, "epoch cleanup") as Epoch["cleanup"]["phase"];
  if (!["ballots", "options", "complete"].includes(phase)) bad("epoch cleanup");
  return { gaugeId: integer(x.gauge_id, "epoch"), epochId: integer(x.epoch_id, "epoch"), snapshotHeight: integer(x.snapshot_height, "epoch"), snapshotTotalPower: uint(x.snapshot_total_power, "epoch"), participatingPower: uint(x.participating_power, "epoch"), allocatedPower: uint(x.allocated_power, "epoch"), totalCast: uint(x.total_cast, "epoch"), retainedOption: x.retained_option === null ? null : text(x.retained_option, "epoch"), retainedOptionPower: uint(x.retained_option_power, "epoch"), unallocatedPower: uint(x.unallocated_power, "epoch"), selectedProjectPower: uint(x.selected_project_power, "epoch"), emittedValue: uint(x.emitted_value, "epoch"), retainedValue: uint(x.retained_value, "epoch"), minTurnoutBps: integer(x.min_turnout_bps, "epoch"), policyVersion: integer(x.policy_version, "epoch"), epochBudget: uint(x.epoch_budget, "epoch"), denom: text(x.denom, "epoch"), opensAt: integer(x.opens_at, "epoch"), closesAt: integer(x.closes_at, "epoch"), executionDeadline: integer(x.execution_deadline, "epoch"), voterCount: integer(x.voter_count, "epoch"), optionCount: integer(x.option_count, "epoch"), ...outcome, cleanup: { phase, cursor: integer(cleanup.cursor, "epoch cleanup"), complete: bool(cleanup.complete, "epoch cleanup") } };
}
export function mapVote(value: unknown): GaugeVote {
  const x = object(value, "gauge vote"); exact(x, ["option", "weight"]); const weight = text(x.weight, "gauge vote"); parseDecimal18(weight);
  if (parseDecimal18(weight) <= 0n) bad("gauge vote");
  return { option: text(x.option, "gauge vote"), weight };
}
export function mapBallotResponse(value: unknown): Ballot | null {
  const outer = object(value, "epoch ballot"); exact(outer, ["ballot"]); if (outer.ballot === null) return null;
  const x = object(outer.ballot, "epoch ballot"); exact(x, ["voter", "power", "votes", "cast_at", "revised_at", "revisions", "receipt_index"]);
  const rawVotes: unknown[] = Array.isArray(x.votes) ? x.votes : bad("epoch ballot");
  const votes = rawVotes.map(mapVote); if (new Set(votes.map((v) => v.option)).size !== votes.length) bad("epoch ballot");
  return { voter: text(x.voter, "epoch ballot"), power: uint(x.power, "epoch ballot"), votes, castAt: integer(x.cast_at, "epoch ballot"), revisedAt: integer(x.revised_at, "epoch ballot"), revisions: integer(x.revisions, "epoch ballot"), receiptIndex: integer(x.receipt_index, "epoch ballot") };
}
export function mapVotingPower(value: unknown): VotingPower {
  const x = object(value, "historical voting power"); exact(x, ["power", "height"]);
  return { power: uint(x.power, "historical voting power"), height: integer(x.height, "historical voting power") };
}

async function verifyContract(client: RpcClient, address: string, codeId: number, checksum: string, label: string) {
  const [contract, code] = await Promise.all([client.getContract(address), client.getCodeDetails(codeId)]);
  if (contract.address !== address || contract.codeId !== codeId || code.checksum.toLowerCase() !== checksum) throw new Error(`${label} deployment provenance mismatch.`);
}
async function paginateEpochs(query: (message: object) => Promise<unknown>): Promise<Epoch[]> {
  const output: Epoch[] = []; let cursor: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const x = object(await query(gaugeQueries.epochs(cursor)), "epoch list"); exact(x, ["epochs"]); const rawEpochs: unknown[] = Array.isArray(x.epochs) ? x.epochs : bad("epoch list");
    const items = rawEpochs.map(mapEpoch);
    for (const item of items) { if (item.gaugeId !== GAUGE_ID || (cursor !== null && item.epochId <= cursor)) bad("epoch list"); cursor = item.epochId; output.push(item); }
    if (items.length < GAUGE_PAGE_LIMIT) return output;
  }
  throw new Error("Gauge epoch pagination exceeded its fail-closed bound.");
}
async function paginateAllocations(query: (message: object) => Promise<unknown>, epoch: Epoch): Promise<GaugeOption[]> {
  const output: GaugeOption[] = []; let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const x = object(await query(gaugeQueries.allocations(epoch.epochId, cursor)), "epoch allocations"); exact(x, ["allocations"]); const rawAllocations: unknown[] = Array.isArray(x.allocations) ? x.allocations : bad("epoch allocations");
    const items = rawAllocations.map((entry: unknown) => { if (!Array.isArray(entry) || entry.length !== 2) return bad("epoch allocations"); return { option: text(entry[0], "epoch allocations"), power: uint(entry[1], "epoch allocations") }; });
    for (const item of items) { if (!item.option || (cursor !== null && item.option <= cursor)) bad("epoch allocations"); cursor = item.option; output.push(item); }
    if (items.length < GAUGE_PAGE_LIMIT) break;
  }
  if (epoch.cleanup.phase === "ballots" && output.length !== epoch.optionCount) throw new Error("Canonical epoch option snapshot is incomplete.");
  return output;
}
async function paginateRegistryOptions(query: (message: object) => Promise<unknown>): Promise<string[]> {
  const output: string[] = []; let cursor: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const x = object(await query(gaugeQueries.registryOptions(cursor)), "registry options"); exact(x, ["options"]);
    const values: unknown[] = Array.isArray(x.options) ? x.options : bad("registry options");
    for (const value of values) { const option = text(value, "registry options"); if (!option || (cursor !== null && option <= cursor)) bad("registry options"); cursor = option; output.push(option); }
    if (values.length < 50) return output;
  }
  throw new Error("Registry option pagination exceeded its fail-closed bound.");
}
async function paginateRegistryProjects(query: (message: object) => Promise<unknown>): Promise<Project[]> {
  const output: Project[] = []; let cursor: number | null = null;
  for (let page = 0; page < 1000; page++) {
    const x = object(await query(gaugeQueries.registryProjects(cursor)), "registry projects"); exact(x, ["projects"]);
    const values: unknown[] = Array.isArray(x.projects) ? x.projects : bad("registry projects");
    const projects = values.map(mapProject);
    for (const project of projects) { if (cursor !== null && project.id <= cursor) bad("registry projects"); cursor = project.id; output.push(project); }
    if (values.length < 50) return output;
  }
  throw new Error("Registry project pagination exceeded its fail-closed bound.");
}

export function createGaugeDataSource(cfg: AppConfig, connector: Connect = connectRpc): GaugeDataSource {
  const load = async (voter?: string): Promise<GaugeData> => {
    const client = await connector(cfg.rpc);
    try {
      if ((await client.getChainId()) !== cfg.chainId) throw new Error("Gauge chain provenance mismatch.");
      await Promise.all([
        verifyContract(client, cfg.gaugeContract, cfg.gaugeCodeId, cfg.gaugeCodeChecksum, "Gauge"),
        verifyContract(client, cfg.votingContract, cfg.votingCodeId, cfg.votingCodeChecksum, "Voting module"),
        verifyContract(client, cfg.vaultContract, cfg.vaultCodeId, cfg.vaultCodeChecksum, "Program Vault"),
        verifyContract(client, cfg.registryContract, cfg.registryCodeId, cfg.registryCodeChecksum, "Registry"),
      ]);
      const gaugeQuery = (message: object) => client.queryContractSmart(cfg.gaugeContract, message);
      const [rawConfig, rawGauge, rawVaultVoting, rawModules, rawVotingDao, rawRegistryPause, observationHeight, chainTimeNanos] = await Promise.all([
        gaugeQuery(gaugeQueries.config()), gaugeQuery(gaugeQueries.gauge()), client.queryContractSmart(cfg.vaultContract, gaugeQueries.vaultVotingModule()),
        client.queryContractSmart(cfg.vaultContract, gaugeQueries.vaultProposalModules()), client.queryContractSmart(cfg.votingContract, gaugeQueries.votingDao()), client.queryContractSmart(cfg.registryContract, gaugeQueries.registryPause()), client.getHeight(), client.getChainTimeNanos(),
      ]);
      const config = mapGaugeConfig(rawConfig), gauge = mapGauge(rawGauge);
      if (rawVaultVoting !== cfg.votingContract || rawVotingDao !== cfg.vaultContract || !Array.isArray(rawModules)) throw new Error("Program Vault module binding mismatch.");
      const modules = rawModules.map((value) => { const x = object(value, "vault proposal modules"); exact(x, ["address", "prefix", "status"]); return { address: text(x.address, "vault proposal modules"), status: text(x.status, "vault proposal modules") }; });
      if (modules.length !== 1 || modules[0].address !== cfg.gaugeContract || modules[0].status !== "enabled") throw new Error("Program Vault execution-module binding mismatch.");
      const registryPause = object(rawRegistryPause, "registry pause");
      exact(registryPause, ["admissions_stopped", "adapter_stopped", "reason", "actor", "changed_at"]);
      const adapterStopped = bool(registryPause.adapter_stopped, "registry pause");
      const [currentRegistryOptions, registryProjects] = await Promise.all([
        paginateRegistryOptions((message) => client.queryContractSmart(cfg.registryContract, message)),
        paginateRegistryProjects((message) => client.queryContractSmart(cfg.registryContract, message)),
      ]);
      const activeProjects = registryProjects.filter((project) => project.status === "active");
      const expectedRegistryOptions = ["do-not-distribute", ...activeProjects.map((project) => `project:${project.id}`)].sort();
      if (JSON.stringify(currentRegistryOptions) !== JSON.stringify(expectedRegistryOptions)) throw new Error("Registry project options are inconsistent.");
      if (config.owner !== cfg.vaultContract || config.daoCore !== cfg.vaultContract || config.votingPowers !== cfg.votingContract || gauge.id !== GAUGE_ID || gauge.adapter !== cfg.registryContract || gauge.snapshotPolicy.denom !== "ujuno" || gauge.snapshotPolicy.minTurnoutBps > 10_000 || gauge.snapshotPolicy.retainedOption !== "do-not-distribute" || gauge.snapshotPolicy.executionWindowSeconds < 1) throw new Error("Gauge deployment binding mismatch.");
      const epochs = await paginateEpochs(gaugeQuery);
      if (new Set(epochs.map((epoch) => epoch.epochId)).size !== epochs.length) throw new Error("Duplicate canonical epoch identity.");
      const current = gauge.currentEpoch === null ? null : epochs.find((epoch) => epoch.epochId === gauge.currentEpoch) ?? null;
      if (gauge.currentEpoch !== null && !current) throw new Error("Current epoch is absent from canonical epoch history.");
      const previous = current ? [...epochs].reverse().find((epoch) => epoch.epochId < current.epochId) ?? null : [...epochs].reverse()[0] ?? null;
      const [options, previousOptions] = await Promise.all([current ? paginateAllocations(gaugeQuery, current) : [], previous ? paginateAllocations(gaugeQuery, previous) : []]);
      const [ballot, votingPower] = voter && current ? await Promise.all([
        gaugeQuery(gaugeQueries.ballot(current.epochId, voter)).then(mapBallotResponse),
        client.queryContractSmart(cfg.votingContract, gaugeQueries.votingPower(voter, current.snapshotHeight)).then(mapVotingPower),
      ]) : [null, null];
      if (ballot && ballot.voter !== voter) throw new Error("Connected ballot identity mismatch.");
      if (votingPower && votingPower.height !== current?.snapshotHeight) throw new Error("Historical voting-power height mismatch.");
      if (!client.getBalance) throw new Error("Canonical Program Vault balance query is unavailable.");
      const vaultBalance = await client.getBalance(cfg.vaultContract, "ujuno");
      return { config, gauge, epochs, current, previous, options, previousOptions, ballot, votingPower, vaultBalance, chainTimeNanos, observationHeight: integer(observationHeight, "gauge height"), refreshedAt: new Date(), weakConsistency: true, adapterStopped, currentRegistryOptions, registryProjects: activeProjects };
    } finally { client.disconnect(); }
  };
  return { loadGauge: load, async loadActionContext(voter) { const data = await load(voter ?? undefined); return { data, fingerprint: JSON.stringify({ config: data.config, gauge: data.gauge, current: data.current, options: data.options, ballot: data.ballot, votingPower: data.votingPower, vaultBalance: data.vaultBalance, adapterStopped: data.adapterStopped, currentRegistryOptions: data.currentRegistryOptions, registryProjects: data.registryProjects }) }; } };
}
