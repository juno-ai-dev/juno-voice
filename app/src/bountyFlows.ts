import type { Bounty, ContractConfig, PauseState } from "./types";
import type { TransactionIntent } from "./transactions";
import { formatJuno, parseJuno } from "./junoAmount";
import { METADATA_DIGEST_PATTERN, URI_SCHEME_PATTERN } from "./metadataDigest";

const U64_MAX = 18446744073709551615n;
const utf8 = (value: string) => new TextEncoder().encode(value).length;

const required = (value: string, max: number, label: string) => {
  if (!value.trim()) throw new Error(`${label} is required.`);
  if (utf8(value) > max) throw new Error(`${label} exceeds the live ${max}-byte limit.`);
  return value;
};
const optionalPair = (uri: string, digest: string, max: number, label: string) => {
  const u = uri.trim(), d = digest.trim();
  if (Boolean(u) !== Boolean(d)) throw new Error(`${label} URI and SHA-256 digest must be supplied together.`);
  if (!u) return { uri: null, digest: null };
  if (utf8(u) > max || !URI_SCHEME_PATTERN.test(u))
    throw new Error(`${label} URI must be a bounded HTTPS or IPFS URI.`);
  if (!METADATA_DIGEST_PATTERN.test(d)) throw new Error(`${label} digest must use sha256:<64 lowercase hex characters>.`);
  return { uri: u, digest: d };
};
export interface CreateBountyInput {
  title: string; summary: string; acceptanceCriteria: string;
  contentUri: string; contentDigest: string; expiresAtNanos: string; initialJuno: string;
  projectCandidate?: { metadataUri: string; metadataDigest: string };
}
export interface EligibilityState {
  config: ContractConfig; pause: PauseState; chainTimeNanos: string; fingerprint: string;
}
function assertConfig(state: EligibilityState) {
  if (state.pause.paused) throw new Error("New bounty activity is paused on chain.");
  if (state.config.native_denom !== "ujuno") throw new Error("Unsupported live native denomination.");
  if (!/^\d+$/.test(state.chainTimeNanos) || BigInt(state.chainTimeNanos) > U64_MAX)
    throw new Error("Canonical chain time is unavailable.");
}
export function createBountyIntent(input: CreateBountyInput, state: EligibilityState, bountyContract: string): TransactionIntent {
  assertConfig(state);
  const initialUjuno = parseJuno(input.initialJuno);
  const initial = BigInt(initialUjuno);
  if (initial < BigInt(state.config.min_contribution) || initial > BigInt(state.config.max_bounty_total))
    throw new Error("Initial contribution is outside the live contract limits.");
  if (!/^\d+$/.test(input.expiresAtNanos)) throw new Error("Expiration must be an exact nanosecond timestamp.");
  const now = BigInt(state.chainTimeNanos), expiry = BigInt(input.expiresAtNanos);
  const min = now + BigInt(state.config.min_lifetime_seconds) * 1_000_000_000n;
  const max = now + BigInt(state.config.max_lifetime_seconds) * 1_000_000_000n;
  if (expiry < min || expiry > max || expiry > U64_MAX) throw new Error("Expiration is outside the lifetime range measured from chain time.");
  const content = optionalPair(input.contentUri, input.contentDigest, state.config.limits.max_uri_bytes, "Content");
  let project_candidate = null;
  if (input.projectCandidate) {
    const metadata = optionalPair(input.projectCandidate.metadataUri, input.projectCandidate.metadataDigest,
      state.config.limits.max_uri_bytes, "Project metadata");
    if (metadata.uri === null || metadata.digest === null)
      throw new Error("Project metadata URI and digest are required for a project candidate.");
    project_candidate = {
      metadata_uri: metadata.uri, metadata_digest: metadata.digest,
    };
  }
  return {
    chainId: "juno-1", contract: bountyContract,
    executeMessage: { create_bounty: {
      title: required(input.title, state.config.limits.max_title_bytes, "Title"),
      summary: required(input.summary, state.config.limits.max_summary_bytes, "Summary"),
      acceptance_criteria: required(input.acceptanceCriteria, state.config.limits.max_acceptance_criteria_bytes, "Acceptance criteria"),
      content_uri: content.uri, content_digest: content.digest,
      expires_at: input.expiresAtNanos, project_candidate,
    } },
    funds: [{ denom: "ujuno", amount: initialUjuno }],
    consequences: [`Create a bounty and escrow exactly ${formatJuno(initialUjuno)}.`,
      `Terms and limits are snapshotted at config version ${state.config.version}.`,
      project_candidate ? "This is only a project candidate; graduation is a later authorized action." : "No project candidate is attached."],
    expectedStateFingerprint: state.fingerprint,
  };
}
export function contributeIntent(bounty: Bounty, juno: string, contributor: string | null,
  knownContributors: readonly string[], state: EligibilityState, bountyContract: string): TransactionIntent {
  assertConfig(state);
  const ujuno = parseJuno(juno);
  const value = BigInt(ujuno);
  if (value < BigInt(state.config.min_contribution)) throw new Error("Contribution is below the live minimum.");
  if (bounty.status !== "open") throw new Error("This bounty is not open for contributions.");
  if (BigInt(state.chainTimeNanos) >= BigInt(bounty.expires_at)) throw new Error("This bounty has expired according to chain time.");
  if (BigInt(bounty.total_contribution) + value > BigInt(bounty.terms.max_bounty_total))
    throw new Error("Contribution exceeds this bounty's snapshotted total cap.");
  const existing = contributor !== null && knownContributors.includes(contributor);
  if (!existing && bounty.contributor_count >= bounty.terms.max_contributors)
    throw new Error("This bounty has reached its snapshotted contributor cap.");
  return {
    chainId: "juno-1", contract: bountyContract,
    executeMessage: { contribute: { bounty_id: bounty.id } }, funds: [{ denom: "ujuno", amount: ujuno }],
    consequences: [`Add exactly ${formatJuno(ujuno)} to bounty #${bounty.id}; escrowed funds may only leave through contract rules.`,
      `Eligibility uses canonical chain time and the bounty's snapshotted caps.`],
    expectedStateFingerprint: state.fingerprint,
  };
}
