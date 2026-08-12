import { fromBech32 } from "@cosmjs/encoding";
import { DEFAULT_BOUNTY_CONTRACT } from "./config";
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
  | Exclude<BroadcastResponse, { status: "confirmed" }>
  | { readonly status: "rejected"; readonly reason: string };
export interface TransactionDependencies {
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
function objectWithExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return exactDataObject(value, keys);
}
const uint = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
// Issue #32 currently approves only the contribution flow. Expanding this map
// is a security-policy change and requires an exact schema plus dedicated UX.
const ACTION_SCHEMAS: Readonly<Record<string, (body: unknown) => boolean>> = Object.freeze({
  contribute: (body) => objectWithExactKeys(body, ["bounty_id"]) && uint(body.bounty_id),
});
function validateIntent(intent: TransactionIntent, authorization: WalletAuthorization): void {
  safeCanonical(intent);
  if (intent.chainId !== "juno-1" || authorization.chainId !== intent.chainId)
    throw new TransactionSafetyError("wrong_chain", "Transaction and wallet must both target juno-1.");
  if (!validJunoAddress(authorization.address, [20]) || !validJunoAddress(intent.contract, [32]) ||
    intent.contract !== DEFAULT_BOUNTY_CONTRACT || !Array.isArray(intent.funds) ||
    intent.funds.length !== 1 || !exactJunoCoin(intent.funds[0]))
    throw new TransactionSafetyError("invalid_transaction", "Invalid or unapproved contract or funds.");
  const keys = Object.keys(intent.executeMessage);
  const action = keys.length === 1 ? keys[0] : "";
  if (!action || !ACTION_SCHEMAS[action]?.(intent.executeMessage[action]))
    throw new TransactionSafetyError("message_forbidden", "Execute action or schema is not permitted by the central policy.");
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
      const authorization = await dependencies.wallet.current(); validateIntent(intent, authorization);
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
          return { status: "unknown", ...(error.txHash ? { txHash: error.txHash } : {}) };
        }
        return { status: "unknown" };
      }
      const validatedOutcome = validateBroadcastResponse(outcome);
      if (!validatedOutcome) return { status: "unknown" };
      if (validatedOutcome.status !== "confirmed") return validatedOutcome;
      let refreshStatus: "refreshed" | "failed" = "refreshed";
      try { await dependencies.refreshCanonical(); } catch { refreshStatus = "failed"; }
      return { ...validatedOutcome, confirmationStatus: "confirmed", refreshStatus,
        explorerUrl: `${dependencies.explorerBaseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(validatedOutcome.txHash)}` };
    },
  };
}
