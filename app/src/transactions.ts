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
  readonly reviewId: string; readonly sender: string; readonly chainId: string; readonly contract: string;
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
function canonical(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": case "string": return JSON.stringify(value);
    case "number": if (!Number.isFinite(value)) return invalidJson(); return JSON.stringify(value);
    case "object": break;
    default: return invalidJson();
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return invalidJson();
    return `[${value.map(canonical).join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidJson();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (Reflect.ownKeys(object).length !== keys.length) return invalidJson();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalidJson();
  }
  return `{${keys.sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function copyFreeze<T>(value: T): T { canonical(value); return deepFreeze(structuredClone(value)); }
function validCoin(coin: Coin): boolean {
  return Boolean(coin && /^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/.test(coin.denom) && /^(0|[1-9]\d*)$/.test(coin.amount));
}
function validateFee(fee: FeeEstimate): void {
  if (!fee || !/^[1-9]\d*$/.test(fee.gas) || !Array.isArray(fee.amount) || fee.amount.some((coin) => !validCoin(coin)))
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
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Object.keys(value as object).sort();
  return actual.length === keys.length && [...keys].sort().every((key, index) => key === actual[index]);
}
const uint = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
// Issue #32 currently approves only the contribution flow. Expanding this map
// is a security-policy change and requires an exact schema plus dedicated UX.
const ACTION_SCHEMAS: Readonly<Record<string, (body: unknown) => boolean>> = Object.freeze({
  contribute: (body) => objectWithExactKeys(body, ["bounty_id"]) && uint(body.bounty_id),
});
function validateIntent(intent: TransactionIntent, authorization: WalletAuthorization): void {
  canonical(intent);
  if (intent.chainId !== "juno-1" || authorization.chainId !== intent.chainId)
    throw new TransactionSafetyError("wrong_chain", "Transaction and wallet must both target juno-1.");
  if (!validJunoAddress(intent.contract, [32]) || intent.contract !== DEFAULT_BOUNTY_CONTRACT || !Array.isArray(intent.funds) || intent.funds.some((coin) => !validCoin(coin)))
    throw new TransactionSafetyError("invalid_transaction", "Invalid or unapproved contract or funds.");
  const keys = Object.keys(intent.executeMessage);
  const action = keys.length === 1 ? keys[0] : "";
  if (!action || !ACTION_SCHEMAS[action]?.(intent.executeMessage[action]))
    throw new TransactionSafetyError("message_forbidden", "Execute action or schema is not permitted by the central policy.");
  if (!intent.expectedStateFingerprint || !Array.isArray(intent.consequences) || intent.consequences.length === 0 || intent.consequences.some((item) => !item.trim()))
    throw new TransactionSafetyError("invalid_transaction", "Canonical state and explicit consequences are required.");
}

export function createTransactionFlow(dependencies: TransactionDependencies) {
  let nextId = 1;
  const prepared = new Map<string, string>();
  const consumed = new Set<string>();
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
      if (canonicalState.fingerprint !== intent.expectedStateFingerprint)
        throw new TransactionSafetyError("stale_state", "Canonical state changed; reload and review again.");
      if (!Number.isSafeInteger(canonicalState.height) || canonicalState.height <= 0)
        throw new TransactionSafetyError("invalid_transaction", "Canonical query returned an invalid height.");
      const unsigned = copyFreeze({ sender: authorization.address, chainId: intent.chainId, contract: intent.contract,
        executeMessage: intent.executeMessage, funds: intent.funds });
      const fee = await dependencies.estimateFee(unsigned); validateFee(fee);
      const review = copyFreeze({ reviewId: `review-${nextId++}`, ...unsigned, fee, consequences: intent.consequences,
        canonicalState, walletRevision: authorization.revision });
      prepared.set(review.reviewId, canonical(review)); return review;
    },
    async submit(review: TransactionReview): Promise<TransactionOutcome> {
      const expected = prepared.get(review.reviewId);
      if (!expected || expected !== canonical(review)) throw new TransactionSafetyError("invalid_review", "Review is unknown or no longer exact.");
      if (consumed.has(review.reviewId)) throw new TransactionSafetyError("duplicate_broadcast", "This reviewed transaction was already submitted.");
      consumed.add(review.reviewId);
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
      if (outcome.status !== "confirmed") return outcome;
      let refreshStatus: "refreshed" | "failed" = "refreshed";
      try { await dependencies.refreshCanonical(); } catch { refreshStatus = "failed"; }
      return { ...outcome, confirmationStatus: "confirmed", refreshStatus,
        explorerUrl: `${dependencies.explorerBaseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(outcome.txHash)}` };
    },
  };
}
