import type { WalletAuthorization, WalletSession } from "./wallet";

export interface Coin {
  readonly denom: string;
  readonly amount: string;
}
export interface FeeEstimate {
  readonly gas: string;
  readonly amount: readonly Coin[];
}
export interface CanonicalState {
  readonly fingerprint: string;
  readonly height: number;
}
export interface TransactionIntent {
  readonly chainId: string;
  readonly contract: string;
  readonly executeMessage: Readonly<Record<string, unknown>>;
  readonly funds: readonly Coin[];
  readonly consequences: readonly string[];
  readonly expectedStateFingerprint: string;
  readonly allowedMessages: readonly string[];
}
export interface TransactionReview {
  readonly reviewId: string;
  readonly sender: string;
  readonly chainId: string;
  readonly contract: string;
  readonly executeMessage: Readonly<Record<string, unknown>>;
  readonly funds: readonly Coin[];
  readonly fee: FeeEstimate;
  readonly consequences: readonly string[];
  readonly canonicalState: CanonicalState;
  readonly walletRevision: number;
}
export interface ExactExecuteRequest {
  readonly sender: string;
  readonly chainId: string;
  readonly contract: string;
  readonly executeMessage: Readonly<Record<string, unknown>>;
  readonly funds: readonly Coin[];
  readonly fee: FeeEstimate;
}
export type BroadcastResponse =
  | { readonly status: "confirmed"; readonly txHash: string; readonly height: number }
  | { readonly status: "failed"; readonly txHash?: string; readonly reason: string }
  | { readonly status: "pending"; readonly txHash: string }
  | { readonly status: "unknown"; readonly txHash?: string };
export type TransactionOutcome =
  | (Extract<BroadcastResponse, { status: "confirmed" }> & { readonly explorerUrl: string })
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
export type TransactionErrorCode =
  | "wrong_chain"
  | "stale_state"
  | "stale_identity"
  | "message_forbidden"
  | "invalid_review"
  | "duplicate_broadcast"
  | "invalid_transaction";
export class TransactionSafetyError extends Error {
  constructor(public readonly code: TransactionErrorCode, message: string) {
    super(message);
    this.name = "TransactionSafetyError";
  }
}

const PRIVILEGED_MESSAGES = new Set([
  "moderate",
  "graduate_project",
  "pause_new_activity",
  "unpause_new_activity",
  "update_roles",
  "update_config",
  "pause",
  "unpause",
]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
function copyFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TransactionSafetyError("invalid_transaction", "Transaction contains a non-JSON value.");
  return encoded;
}
function validCoin(coin: Coin): boolean {
  return /^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/.test(coin.denom) && /^(0|[1-9]\d*)$/.test(coin.amount);
}
function validateFee(fee: FeeEstimate): void {
  if (!/^[1-9]\d*$/.test(fee.gas) || !Array.isArray(fee.amount) || fee.amount.some((coin) => !validCoin(coin)))
    throw new TransactionSafetyError("invalid_transaction", "Fee estimator returned an invalid fee.");
}
function validateIntent(intent: TransactionIntent, authorization: WalletAuthorization): string {
  if (intent.chainId !== "juno-1" || authorization.chainId !== intent.chainId)
    throw new TransactionSafetyError("wrong_chain", "Transaction and wallet must both target juno-1.");
  if (!intent.contract.startsWith("juno1") || intent.funds.some((coin) => !validCoin(coin)))
    throw new TransactionSafetyError("invalid_transaction", "Invalid contract or funds.");
  const keys = Object.keys(intent.executeMessage);
  if (keys.length !== 1) throw new TransactionSafetyError("message_forbidden", "Execute message must have exactly one action.");
  const action = keys[0];
  if (PRIVILEGED_MESSAGES.has(action) || !intent.allowedMessages.includes(action))
    throw new TransactionSafetyError("message_forbidden", `Execute action ${action} is not permitted by this flow.`);
  if (!intent.expectedStateFingerprint || intent.consequences.length === 0 || intent.consequences.some((item) => !item.trim()))
    throw new TransactionSafetyError("invalid_transaction", "Canonical state and explicit consequences are required.");
  canonical(intent.executeMessage);
  return action;
}
function isRejected(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  return value?.code === 4001 || (typeof value?.message === "string" && /reject|denied/i.test(value.message));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Wallet rejected the request.";
}

export function createTransactionFlow(dependencies: TransactionDependencies) {
  let nextId = 1;
  const prepared = new Map<string, string>();
  const consumed = new Set<string>();

  return {
    async prepare(intent: TransactionIntent): Promise<TransactionReview> {
      const authorization = await dependencies.wallet.current();
      validateIntent(intent, authorization);
      const canonicalState = await dependencies.readCanonicalState();
      if (canonicalState.fingerprint !== intent.expectedStateFingerprint)
        throw new TransactionSafetyError("stale_state", "Canonical state changed; reload and review again.");
      if (!Number.isSafeInteger(canonicalState.height) || canonicalState.height <= 0)
        throw new TransactionSafetyError("invalid_transaction", "Canonical query returned an invalid height.");

      const unsigned = copyFreeze({
        sender: authorization.address,
        chainId: intent.chainId,
        contract: intent.contract,
        executeMessage: intent.executeMessage,
        funds: intent.funds,
      });
      const fee = await dependencies.estimateFee(unsigned);
      validateFee(fee);
      // This immutable object is the exact pre-sign disclosure, not a summary.
      const review = copyFreeze({
        reviewId: `review-${nextId++}`,
        ...unsigned,
        fee,
        consequences: intent.consequences,
        canonicalState,
        walletRevision: authorization.revision,
      });
      prepared.set(review.reviewId, canonical(review));
      return review;
    },

    async submit(review: TransactionReview): Promise<TransactionOutcome> {
      const expected = prepared.get(review.reviewId);
      if (!expected || expected !== canonical(review))
        throw new TransactionSafetyError("invalid_review", "Review is unknown or no longer exact.");
      if (consumed.has(review.reviewId))
        throw new TransactionSafetyError("duplicate_broadcast", "This reviewed transaction was already submitted.");
      // Consume before the first await: ambiguous/pending attempts must never be retried.
      consumed.add(review.reviewId);

      const authorization = await dependencies.wallet.current();
      try {
        dependencies.wallet.assertRevision({
          ...authorization,
          address: review.sender,
          chainId: review.chainId,
          revision: review.walletRevision,
        });
      } catch {
        throw new TransactionSafetyError("stale_identity", "Wallet identity changed; review again.");
      }
      if (authorization.address !== review.sender || authorization.chainId !== review.chainId)
        throw new TransactionSafetyError("stale_identity", "Wallet identity changed; review again.");

      const currentState = await dependencies.readCanonicalState();
      if (currentState.fingerprint !== review.canonicalState.fingerprint)
        throw new TransactionSafetyError("stale_state", "Canonical state changed; review again before signing.");

      // Construct only after canonical revalidation; pass exactly what was displayed.
      const request = copyFreeze({
        sender: review.sender,
        chainId: review.chainId,
        contract: review.contract,
        executeMessage: review.executeMessage,
        funds: review.funds,
        fee: review.fee,
      });
      let outcome: BroadcastResponse;
      try {
        outcome = await dependencies.signAndBroadcast(request);
      } catch (error) {
        if (isRejected(error)) return { status: "rejected", reason: message(error) };
        return { status: "failed", reason: message(error) };
      }
      if (outcome.status !== "confirmed") return outcome;
      await dependencies.refreshCanonical();
      return {
        ...outcome,
        explorerUrl: `${dependencies.explorerBaseUrl.replace(/\/$/, "")}/tx/${encodeURIComponent(outcome.txHash)}`,
      };
    },
  };
}
