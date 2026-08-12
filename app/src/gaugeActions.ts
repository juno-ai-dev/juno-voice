import { fromBech32 } from "@cosmjs/encoding";
import type { AppConfig } from "./config";
import { formatJuno } from "./junoAmount";
import { canonicalDecimal, DECIMAL_SCALE, GAUGE_ID, parseDecimal18, type GaugeActionContext, type GaugeVote } from "./gauge";
import type { TransactionIntent, TransactionOutcome, TransactionReview } from "./transactions";

export type GaugeAction = "open_epoch" | "place_votes" | "remove_votes" | "execute";
export interface PreferenceInput { option: string; weight: string }
export interface GaugeTransactionFlow {
  connect?(): Promise<{ address: string }>;
  prepare(intent: TransactionIntent): Promise<TransactionReview>;
  submit(review: TransactionReview): Promise<TransactionOutcome>;
}

const validAccount = (value: string) => {
  try { const decoded = fromBech32(value); return value === value.toLowerCase() && decoded.prefix === "juno" && decoded.data.length === 20; }
  catch { return false; }
};
const fail = (message: string): never => { throw new Error(message); };
const chainSeconds = (nanos: string) => BigInt(nanos) / 1_000_000_000n;

export function validatePreferences(inputs: readonly PreferenceInput[], options: readonly string[], snapshotPower: string): GaugeVote[] {
  if (inputs.length === 0) fail("Add at least one positive preference, or use Remove ballot to abstain.");
  if (inputs.length > 100) fail("At most 100 preference entries are allowed.");
  const fixedOptions = new Set(options), seen = new Set<string>(); let sum = 0n;
  const power = BigInt(snapshotPower);
  if (power <= 0n) fail("This account had no voting power at the epoch snapshot height.");
  const votes = inputs.map(({ option, weight }, index) => {
    if (!fixedOptions.has(option)) fail(`Preference ${index + 1} is not an option fixed for this epoch.`);
    if (seen.has(option)) fail(`Duplicate option: ${option}.`); seen.add(option);
    const atomics = parseDecimal18(weight, `Weight for ${option}`);
    if (atomics <= 0n) fail(`Weight for ${option} must be positive.`);
    sum += atomics;
    if (sum > DECIMAL_SCALE) fail("Preference weights must sum to at most 1.");
    if (power * atomics / DECIMAL_SCALE === 0n) fail(`Weight for ${option} rounds to zero at the fixed snapshot power.`);
    return { option, weight: canonicalDecimal(weight) };
  });
  return votes;
}

export function gaugeEligibility(context: GaugeActionContext) {
  const { data } = context, epoch = data.current, now = chainSeconds(data.chainTimeNanos);
  const base = !data.gauge.isStopped && !data.adapterStopped;
  const funded = BigInt(data.vaultBalance) >= BigInt(data.gauge.snapshotPolicy.epochBudget);
  const turnoutMet = !!epoch && BigInt(epoch.participatingPower) * 10_000n >= BigInt(epoch.snapshotTotalPower) * BigInt(epoch.minTurnoutBps);
  const minimum = data.gauge.minPercentSelected === null ? 0n : parseDecimal18(data.gauge.minPercentSelected);
  const valid = new Set(data.currentRegistryOptions);
  const hasExecutionCandidate = !!epoch && BigInt(epoch.totalCast) > 0n && data.options.some(({ option, power }) =>
    BigInt(power) > 0n && valid.has(option) && BigInt(power) * DECIMAL_SCALE >= BigInt(epoch.totalCast) * minimum);
  return {
    open: base && funded && (!epoch || epoch.outcome !== "open") && now >= BigInt(data.gauge.nextEpoch),
    vote: base && !!epoch && epoch.outcome === "open" && now < BigInt(epoch.closesAt) && BigInt(data.votingPower?.power ?? "0") > 0n,
    execute: !data.gauge.isStopped && !!epoch && epoch.outcome === "open" && now >= BigInt(epoch.closesAt) &&
      (!turnoutMet || !hasExecutionCandidate || (!data.adapterStopped && funded)),
  };
}

export function buildGaugeIntent(config: AppConfig, sender: string, context: GaugeActionContext, action: GaugeAction, preferences: readonly PreferenceInput[] = []): TransactionIntent {
  if (!validAccount(sender)) fail("Connect a valid Juno account before preparing this action.");
  const { data } = context, eligibility = gaugeEligibility(context), epoch = data.current;
  let executeMessage: Record<string, unknown>, consequence: string;
  if (action === "open_epoch") {
    if (!eligibility.open) fail("Canonical chain state does not currently permit opening a funded epoch.");
    executeMessage = { open_epoch: { gauge: GAUGE_ID } };
    consequence = `Open the next epoch with a new historical power snapshot and the fixed ${formatJuno(data.gauge.snapshotPolicy.epochBudget)} budget.`;
  } else if (action === "execute") {
    if (!eligibility.execute || !epoch) fail("Canonical chain state does not currently permit executing this epoch.");
    executeMessage = { execute: { gauge: GAUGE_ID } };
    consequence = "Finalize the fixed epoch. Ineligible, capped, unselected, and do-not-distribute value remains in the Program Vault; it does not roll over automatically.";
  } else if (action === "remove_votes") {
    if (!eligibility.vote || !epoch || !data.ballot) fail("A live connected ballot is required before it can be removed.");
    const currentEpoch = epoch;
    if (!currentEpoch) throw new Error("Canonical epoch is unavailable.");
    executeMessage = { place_votes: { gauge: GAUGE_ID, votes: null } };
    consequence = `Remove the connected account's ballot from epoch ${currentEpoch.epochId} and abstain.`;
  } else {
    if (!eligibility.vote || !epoch || !data.votingPower) fail("This account is not eligible to vote in the current canonical epoch.");
    const currentEpoch = epoch, votingPower = data.votingPower;
    if (!currentEpoch || !votingPower) throw new Error("Canonical voter context is unavailable.");
    const votes = validatePreferences(preferences, data.options.map((option) => option.option), votingPower.power);
    executeMessage = { place_votes: { gauge: GAUGE_ID, votes } };
    consequence = `${data.ballot ? "Replace" : "Place"} the connected account's complete weighted ballot for epoch ${currentEpoch.epochId}. Unused weight remains intentionally unallocated.`;
  }
  return { chainId: config.chainId, contract: config.gaugeContract, executeMessage, funds: [], consequences: [consequence], expectedStateFingerprint: context.fingerprint };
}
