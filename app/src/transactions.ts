import { fromBech32 } from "@cosmjs/encoding";
import type { AppConfig } from "./config";
import type { WalletAuthorization, WalletSession } from "./wallet";

export interface Coin { readonly denom: string; readonly amount: string }
export interface FeeEstimate { readonly gas: string; readonly amount: readonly Coin[] }
export interface CanonicalState { readonly fingerprint: string; readonly height: number }
export interface TransactionIntent {
  readonly chainId: string;
  readonly contract: string;
  readonly executeMessage: Readonly<Record<string, unknown>>;
  readonly funds: readonly Coin[];
  readonly consequences: readonly string[];
  readonly expectedStateFingerprint: string;
}
export interface TransactionReview {
  readonly reviewId: string; readonly flowBinding: string; readonly sender: string; readonly chainId: string; readonly contract: string;
  readonly executeMessage: Readonly<Record<string, unknown>>; readonly funds: readonly Coin[];
  readonly fee: FeeEstimate; readonly consequences: readonly string[]; readonly canonicalState: CanonicalState;
  readonly walletRevision: number;
}
export interface ExactExecuteRequest {
  readonly sender: string; readonly chainId: string; readonly contract: string;
  readonly executeMessage: Readonly<Record<string, unknown>>; readonly funds: readonly Coin[]; readonly fee: FeeEstimate;
}
export type BroadcastResponse =
  | { readonly status: "confirmed"; readonly txHash: string; readonly height: number }
  | { readonly status: "failed"; readonly txHash?: string; readonly reason: string }
  | { readonly status: "pending"; readonly txHash: string }
  | { readonly status: "unknown"; readonly txHash?: string };
export type TransactionOutcome =
  | (Extract<BroadcastResponse, { status: "confirmed" }> & { readonly confirmationStatus: "confirmed"; readonly refreshStatus: "refreshed" | "failed"; readonly explorerUrl: string })
  | (Exclude<BroadcastResponse, { status: "confirmed" }> & { readonly explorerUrl?: string })
  | { readonly status: "rejected"; readonly reason: string };
export interface TransactionDependencies {
  readonly contracts: Pick<AppConfig, "contract" | "registryContract" | "gaugeContract">;
  readonly wallet: WalletSession;
  readonly readCanonicalState: () => Promise<CanonicalState>;
  readonly estimateFee: (request: Omit<ExactExecuteRequest, "fee">) => Promise<FeeEstimate>;
  readonly signAndBroadcast: (request: ExactExecuteRequest) => Promise<BroadcastResponse>;
  readonly refreshCanonical: () => Promise<void>;
  readonly explorerBaseUrl: string;
  /** Shared for the application lifetime; inject a fresh instance to isolate tests. */
  readonly reviewRegistry?: TransactionReviewRegistry;
}
export type TransactionErrorCode = "wrong_chain" | "stale_state" | "stale_identity" | "message_forbidden" |
  "invalid_review" | "duplicate_broadcast" | "invalid_transaction";
export class TransactionSafetyError extends Error {
  constructor(public readonly code: TransactionErrorCode, message: string) { super(message); this.name = "TransactionSafetyError"; }
}
export type BroadcastDependencyErrorKind = "transport" | "rejected";
export class BroadcastDependencyError extends Error {
  readonly txHash?: string;
  constructor(public readonly kind: BroadcastDependencyErrorKind, message: string, details: { txHash?: string } = {}) {
    super(message); this.name = "BroadcastDependencyError"; this.txHash = details.txHash;
  }
}

function invalidJson(): never {
  throw new TransactionSafetyError("invalid_transaction", "Transaction contains a non-canonical JSON value.");
}
function validDataDescriptor(descriptor: PropertyDescriptor | undefined, enumerable: boolean): descriptor is PropertyDescriptor & { value: unknown } {
  return Boolean(descriptor && "value" in descriptor && descriptor.enumerable === enumerable &&
    ((descriptor.configurable === true && descriptor.writable === true) ||
      (descriptor.configurable === false && descriptor.writable === false)));
}
function canonical(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": case "string": return JSON.stringify(value);
    case "number": if (!Number.isFinite(value) || Object.is(value, -0)) return invalidJson(); return JSON.stringify(value);
    case "object": break;
    default: return invalidJson();
  }
  if (ancestors.has(value)) return invalidJson();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return invalidJson();
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.length !== value.length + 1 || ownKeys[value.length] !== "length") return invalidJson();
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index++) {
        if (ownKeys[index] !== String(index)) return invalidJson();
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!validDataDescriptor(descriptor, true)) return invalidJson();
        encoded.push(canonical(descriptor.value, ancestors));
      }
      const length = Object.getOwnPropertyDescriptor(value, "length");
      if (!length || length.enumerable || length.configurable || length.value !== value.length ||
        (length.writable !== true && !(length.writable === false && Object.isFrozen(value)))) return invalidJson();
      return `[${encoded.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return invalidJson();
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    if (Reflect.ownKeys(object).length !== keys.length) return invalidJson();
    for (const key of keys) if (!validDataDescriptor(Object.getOwnPropertyDescriptor(object, key), true)) return invalidJson();
    return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(Object.getOwnPropertyDescriptor(object, key)?.value, ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
function safeCanonical(value: unknown): string {
  try { return canonical(value); }
  catch (error) {
    if (error instanceof TransactionSafetyError) throw error;
    throw new TransactionSafetyError("invalid_transaction", "Transaction could not be canonicalized.");
  }
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function copyFreeze<T>(value: T): T {
  safeCanonical(value);
  try { return deepFreeze(structuredClone(value)); }
  catch { throw new TransactionSafetyError("invalid_transaction", "Transaction could not be cloned safely."); }
}
const UINT128_MAX = 340282366920938463463374607431768211455n;
// Cosmos gas is an integer; Number.MAX_SAFE_INTEGER is the largest lossless JS domain.
const MAX_GAS = BigInt(Number.MAX_SAFE_INTEGER);
function validAmount(amount: unknown, positive: boolean): amount is string {
  if (typeof amount !== "string" || !/^(0|[1-9]\d*)$/.test(amount)) return false;
  const parsed = BigInt(amount); return parsed <= UINT128_MAX && (!positive || parsed > 0n);
}
function exactDataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key) &&
    validDataDescriptor(Object.getOwnPropertyDescriptor(value, key), true));
}
function exactJunoCoin(coin: Coin | undefined): boolean {
  return exactDataObject(coin, ["denom", "amount"]) && coin.denom === "ujuno" && validAmount(coin.amount, true);
}
function validateFee(fee: FeeEstimate): void {
  safeCanonical(fee);
  if (!exactDataObject(fee, ["gas", "amount"]) || !validAmount(fee.gas, true) || BigInt(fee.gas) > MAX_GAS || !Array.isArray(fee.amount) ||
    fee.amount.length !== 1 || !exactJunoCoin(fee.amount[0]))
    throw new TransactionSafetyError("invalid_transaction", "Fee estimator returned an invalid fee.");
}
function validJunoAddress(address: string, lengths: readonly number[]): boolean {
  try {
    if (address !== address.toLowerCase()) return false;
    const decoded = fromBech32(address);
    return decoded.prefix === "juno" && lengths.includes(decoded.data.length);
  } catch { return false; }
}
const projectId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const metadataUri = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && new TextEncoder().encode(value).length <= 2_048;
// Any address the chain accepts as a fund destination: 20 bytes for an
// account, 32 for a contract. DAOs, multisigs, and vaults are ordinary
// recipients, and both contracts store the value after their own
// addr_validate. The authorized signer is still checked as a 20-byte account
// below: a contract cannot sign a transaction.
const payee = (value: unknown): value is string => typeof value === "string" && validJunoAddress(value, [20, 32]);
function objectWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return exactDataObject(value, keys);
}
const uint = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
const uint32 = (value: unknown) => uint(value) && (value as number) <= 4294967295;
const digest = (value: unknown) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const gaugeOnly = (body: unknown) => objectWithExactKeys(body, ["gauge"]) && body.gauge === 0;
const decimalAtomics = (value: unknown): bigint | null => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const parsed = BigInt(whole) * 1_000_000_000_000_000_000n + BigInt(fraction.padEnd(18, "0") || "0");
  return parsed <= UINT128_MAX ? parsed : null;
};
const placeVotes = (body: unknown) => {
  if (!objectWithExactKeys(body, ["gauge", "votes"]) || body.gauge !== 0) return false;
  if (body.votes === null) return true;
  if (!Array.isArray(body.votes) || body.votes.length < 1 || body.votes.length > 100) return false;
  const seen = new Set<string>(); let sum = 0n;
  for (const vote of body.votes) {
    if (!objectWithExactKeys(vote, ["option", "weight"]) || typeof vote.option !== "string" || !vote.option || vote.option.length > 128 || seen.has(vote.option)) return false;
    const weight = decimalAtomics(vote.weight); if (weight === null || weight <= 0n) return false;
    seen.add(vote.option); sum += weight; if (sum > 1_000_000_000_000_000_000n) return false;
  }
  return true;
};
const projectCandidate = (value: unknown) => value === null ||
  (objectWithExactKeys(value, ["metadata_uri", "metadata_digest"]) &&
    typeof value.metadata_uri === "string" && value.metadata_uri.length > 0 && digest(value.metadata_digest));
const ACTION_SCHEMAS: Readonly<Record<string, (body: unknown) => boolean>> = Object.freeze({
  create_bounty: (body) => objectWithExactKeys(body, ["title", "summary", "acceptance_criteria", "content_uri",
    "content_digest", "expires_at", "project_candidate"]) &&
    typeof body.title === "string" && typeof body.summary === "string" && typeof body.acceptance_criteria === "string" &&
    ((body.content_uri === null && body.content_digest === null) ||
      (typeof body.content_uri === "string" && body.content_uri.length > 0 && digest(body.content_digest))) &&
    validAmount(body.expires_at, true) &&
    BigInt(body.expires_at as string) <= 18446744073709551615n && projectCandidate(body.project_candidate),
  contribute: (body) => objectWithExactKeys(body, ["bounty_id"]) && uint(body.bounty_id),
  nominate_payout: (body) => objectWithExactKeys(body, ["bounty_id", "recipient", "evidence_uri", "evidence_digest", "rationale"]) &&
    uint(body.bounty_id) && payee(body.recipient) &&
    text(body.evidence_uri) && digest(body.evidence_digest) && text(body.rationale),
  confirm_sole_payout: (body) => objectWithExactKeys(body, ["bounty_id", "round"]) && uint(body.bounty_id) && uint32(body.round),
  decline_sole_payout: (body) => objectWithExactKeys(body, ["bounty_id", "round", "reason"]) &&
    uint(body.bounty_id) && uint32(body.round) && text(body.reason),
  vote_payout: (body) => (objectWithExactKeys(body, ["bounty_id", "round", "vote"]) ||
    objectWithExactKeys(body, ["bounty_id", "round", "vote", "rationale"])) && uint(body.bounty_id) && uint32(body.round) &&
    (body.vote === "yes" || body.vote === "no") && (!("rationale" in body) || body.rationale === null || text(body.rationale)),
  finalize_payout: (body) => objectWithExactKeys(body, ["bounty_id", "round"]) && uint(body.bounty_id) && uint32(body.round),
  cancel_sole_funded: (body) => objectWithExactKeys(body, ["bounty_id", "reason"]) && uint(body.bounty_id) && text(body.reason),
  expire: (body) => objectWithExactKeys(body, ["bounty_id"]) && uint(body.bounty_id),
  claim_refund: (body) => objectWithExactKeys(body, ["bounty_id"]) && uint(body.bounty_id),
  register_project: (body) => objectWithExactKeys(body, ["metadata_uri", "metadata_digest", "payout_address"]) &&
    metadataUri(body.metadata_uri) && digest(body.metadata_digest) && payee(body.payout_address),
  update_pending_metadata: (body) => objectWithExactKeys(body, ["project_id", "metadata_uri", "metadata_digest"]) &&
    projectId(body.project_id) && metadataUri(body.metadata_uri) && digest(body.metadata_digest),
  propose_payout_address: (body) => objectWithExactKeys(body, ["project_id", "address"]) && projectId(body.project_id) && payee(body.address),
  cancel_payout_address_change: (body) => objectWithExactKeys(body, ["project_id"]) && projectId(body.project_id),
  accept_payout_address: (body) => objectWithExactKeys(body, ["project_id"]) && projectId(body.project_id),
  claim_registration_bond: (body) => objectWithExactKeys(body, ["project_id"]) && projectId(body.project_id),
  retire: (body) => {
    if (!objectWithExactKeys(body, ["project_id", "reason"]) || !projectId(body.project_id) || !objectWithExactKeys(body.reason, ["code", "note"])) return false;
    return body.reason.code === "voluntary_retirement" && typeof body.reason.note === "string" && body.reason.note.trim().length > 0 && new TextEncoder().encode(body.reason.note).length <= 2_048;
  },
  open_epoch: gaugeOnly,
  place_votes: placeVotes,
  execute: gaugeOnly,
  expire_epoch: gaugeOnly,
});
const BOUNTY_ACTIONS = new Set([
  "create_bounty", "contribute", "nominate_payout", "confirm_sole_payout", "decline_sole_payout",
  "vote_payout", "finalize_payout", "cancel_sole_funded", "expire", "claim_refund",
]);
const REGISTRY_ACTIONS = new Set([
  "register_project", "update_pending_metadata", "propose_payout_address", "cancel_payout_address_change",
  "accept_payout_address", "claim_registration_bond", "retire",
]);
const GAUGE_ACTIONS = new Set(["open_epoch", "place_votes", "execute", "expire_epoch"]);
const PAYABLE_ACTIONS = new Set(["create_bounty", "contribute", "register_project"]);
function validateIntent(intent: TransactionIntent, authorization: WalletAuthorization,
  contracts: TransactionDependencies["contracts"]): void {
  safeCanonical(intent);
  if (intent.chainId !== "juno-1" || authorization.chainId !== intent.chainId)
    throw new TransactionSafetyError("wrong_chain", "Transaction and wallet must both target juno-1.");
  if (!validJunoAddress(authorization.address, [20]) || !validJunoAddress(intent.contract, [32]) ||
    ![contracts.contract, contracts.registryContract, contracts.gaugeContract].includes(intent.contract) || !Array.isArray(intent.funds))
    throw new TransactionSafetyError("invalid_transaction", "Invalid or unapproved contract or funds.");
  const keys = Object.keys(intent.executeMessage);
  const action = keys.length === 1 ? keys[0] : "";
  if (!action || !ACTION_SCHEMAS[action]?.(intent.executeMessage[action]))
    throw new TransactionSafetyError("message_forbidden", "Execute action or schema is not permitted by the central policy.");
  const contractActions = intent.contract === contracts.contract ? BOUNTY_ACTIONS :
    intent.contract === contracts.gaugeContract ? GAUGE_ACTIONS : REGISTRY_ACTIONS;
  if (!contractActions.has(action))
    throw new TransactionSafetyError("message_forbidden", "Execute action is not permitted for this contract.");
  if (PAYABLE_ACTIONS.has(action) ? intent.funds.length !== 1 || !exactJunoCoin(intent.funds[0]) : intent.funds.length !== 0)
    throw new TransactionSafetyError("invalid_transaction", "Invalid funds for this execute action.");
  if (!intent.expectedStateFingerprint || !Array.isArray(intent.consequences) || intent.consequences.length === 0 ||
    intent.consequences.some((item) => typeof item !== "string" || !item.trim()))
    throw new TransactionSafetyError("invalid_transaction", "Canonical state and explicit consequences are required.");
}
function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function validateBroadcastResponse(value: unknown): BroadcastResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const status = (value as Record<string, unknown>).status;
  if (status === "confirmed" && exactDataObject(value, ["status", "txHash", "height"]) &&
    nonBlank(value.txHash) && Number.isSafeInteger(value.height) && (value.height as number) > 0)
    return value as Extract<BroadcastResponse, { status: "confirmed" }>;
  if (status === "pending" && exactDataObject(value, ["status", "txHash"]) && nonBlank(value.txHash))
    return value as Extract<BroadcastResponse, { status: "pending" }>;
  if (status === "failed" &&
    (exactDataObject(value, ["status", "reason"]) || exactDataObject(value, ["status", "txHash", "reason"])) &&
    nonBlank(value.reason) && (!("txHash" in value) || nonBlank(value.txHash)))
    return value as Extract<BroadcastResponse, { status: "failed" }>;
  if (status === "unknown" &&
    (exactDataObject(value, ["status"]) || exactDataObject(value, ["status", "txHash"])) &&
    (!("txHash" in value) || nonBlank(value.txHash)))
    return value as Extract<BroadcastResponse, { status: "unknown" }>;
  return null;
}

interface RegisteredReview { readonly flowBinding: string; readonly canonicalReview: string; consumed: boolean }
export class TransactionReviewRegistry {
  private readonly reviews = new Map<string, RegisteredReview>();
  register(reviewId: string, flowBinding: string, canonicalReview: string): void {
    if (this.reviews.has(reviewId)) throw new TransactionSafetyError("invalid_review", "Review identifier collision.");
    this.reviews.set(reviewId, { flowBinding, canonicalReview, consumed: false });
  }
  consume(reviewId: string, flowBinding: string, canonicalReview: string): void {
    const entry = this.reviews.get(reviewId);
    if (!entry || entry.flowBinding !== flowBinding || entry.canonicalReview !== canonicalReview)
      throw new TransactionSafetyError("invalid_review", "Review is unknown or no longer exact.");
    if (entry.consumed) throw new TransactionSafetyError("duplicate_broadcast", "This reviewed transaction was already submitted.");
    entry.consumed = true;
  }
}
const applicationReviewRegistry = new TransactionReviewRegistry();

export function createTransactionFlow(dependencies: TransactionDependencies) {
  const withExplorer = <T extends Exclude<BroadcastResponse, { status: "confirmed" }>>(outcome: T): T & { explorerUrl?: string } =>
    "txHash" in outcome && outcome.txHash
      ? { ...outcome, explorerUrl: `${dependencies.explorerBaseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(outcome.txHash)}` }
      : outcome;
  const flowBinding = crypto.randomUUID();
  const registry = dependencies.reviewRegistry ?? applicationReviewRegistry;
  const assertExact = (review: TransactionReview, authorization: WalletAuthorization): void => {
    try {
      dependencies.wallet.assertRevision({ ...authorization, address: review.sender, chainId: review.chainId,
        revision: review.walletRevision });
    } catch { throw new TransactionSafetyError("stale_identity", "Wallet identity changed; review again."); }
    if (authorization.address !== review.sender || authorization.chainId !== review.chainId || authorization.revision !== review.walletRevision)
      throw new TransactionSafetyError("stale_identity", "Wallet identity changed; review again.");
  };
  const readExact = async (review: TransactionReview): Promise<void> => {
    try { assertExact(review, await dependencies.wallet.current()); }
    catch { throw new TransactionSafetyError("stale_identity", "Wallet identity changed; review again."); }
  };
  return {
    async prepare(intent: TransactionIntent): Promise<TransactionReview> {
      const authorization = await dependencies.wallet.current();
      validateIntent(intent, authorization, dependencies.contracts);
      const canonicalState = await dependencies.readCanonicalState();
      safeCanonical(canonicalState);
      if (canonicalState.fingerprint !== intent.expectedStateFingerprint)
        throw new TransactionSafetyError("stale_state", "Canonical state changed; reload and review again.");
      if (!Number.isSafeInteger(canonicalState.height) || canonicalState.height <= 0)
        throw new TransactionSafetyError("invalid_transaction", "Canonical query returned an invalid height.");
      const unsigned = copyFreeze({ sender: authorization.address, chainId: intent.chainId, contract: intent.contract,
        executeMessage: intent.executeMessage, funds: intent.funds });
      const fee = await dependencies.estimateFee(unsigned); validateFee(fee);
      const review = copyFreeze({ reviewId: crypto.randomUUID(), flowBinding, ...unsigned, fee, consequences: intent.consequences,
        canonicalState, walletRevision: authorization.revision });
      registry.register(review.reviewId, flowBinding, safeCanonical(review)); return review;
    },
    async submit(review: TransactionReview): Promise<TransactionOutcome> {
      let encoded: string;
      try { encoded = safeCanonical(review); }
      catch { throw new TransactionSafetyError("invalid_review", "Review is not canonical."); }
      registry.consume(review.reviewId, flowBinding, encoded);
      await readExact(review);
      const currentState = await dependencies.readCanonicalState();
      if (currentState.fingerprint !== review.canonicalState.fingerprint)
        throw new TransactionSafetyError("stale_state", "Canonical state changed; review again before signing.");
      let authorization: WalletAuthorization;
      try { authorization = await dependencies.wallet.current(); }
      catch { throw new TransactionSafetyError("stale_identity", "Wallet identity changed; review again."); }
      // No await occurs from this final exact assertion through signer invocation.
      assertExact(review, authorization);
      const request = copyFreeze({ sender: review.sender, chainId: review.chainId, contract: review.contract,
        executeMessage: review.executeMessage, funds: review.funds, fee: review.fee });
      let outcome: BroadcastResponse;
      try { outcome = await dependencies.signAndBroadcast(request); }
      catch (error) {
        if (error instanceof BroadcastDependencyError) {
          if (error.kind === "rejected") return { status: "rejected", reason: error.message };
          return withExplorer({ status: "unknown", ...(error.txHash ? { txHash: error.txHash } : {}) });
        }
        return { status: "unknown" };
      }
      const validatedOutcome = validateBroadcastResponse(outcome);
      if (!validatedOutcome) return { status: "unknown" };
      if (validatedOutcome.status !== "confirmed") return withExplorer(validatedOutcome);
      let refreshStatus: "refreshed" | "failed" = "refreshed";
      try { await dependencies.refreshCanonical(); } catch { refreshStatus = "failed"; }
      return { ...validatedOutcome, confirmationStatus: "confirmed", refreshStatus,
        explorerUrl: `${dependencies.explorerBaseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(validatedOutcome.txHash)}` };
    },
  };
}
