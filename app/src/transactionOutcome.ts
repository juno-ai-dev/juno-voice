import { DEFAULT_EXPLORER } from "./config";
import type { TransactionOutcome } from "./transactions";

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, fields: readonly string[]) => {
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && keys.every((field) => typeof field === "string" && fields.includes(field)) &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field));
};
const nonBlank = (value: unknown, max = 2_048): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const validHash = (value: unknown): value is string => nonBlank(value, 256);
const validExplorer = (value: unknown, txHash: string) => value === `${DEFAULT_EXPLORER}/tx/${encodeURIComponent(txHash)}`;

/** Validate the untrusted adapter result before it can alter locks or render links. */
export function runtimeTransactionOutcome(value: unknown): TransactionOutcome | null {
  if (!plain(value)) return null;
  const status = value.status;
  if (status === "confirmed" && exact(value, ["status", "txHash", "height", "confirmationStatus", "refreshStatus", "explorerUrl"]) &&
    validHash(value.txHash) && Number.isSafeInteger(value.height) && (value.height as number) > 0 &&
    value.confirmationStatus === "confirmed" && (value.refreshStatus === "refreshed" || value.refreshStatus === "failed") &&
    validExplorer(value.explorerUrl, value.txHash)) return value as unknown as TransactionOutcome;
  if (status === "rejected" && exact(value, ["status", "reason"]) && nonBlank(value.reason))
    return value as unknown as TransactionOutcome;
  if (status === "failed" && exact(value, ["status", "reason"]) && nonBlank(value.reason))
    return value as unknown as TransactionOutcome;
  if (status === "failed" && exact(value, ["status", "reason", "txHash", "explorerUrl"]) && nonBlank(value.reason) &&
    validHash(value.txHash) && validExplorer(value.explorerUrl, value.txHash)) return value as unknown as TransactionOutcome;
  if (status === "pending" && exact(value, ["status", "txHash", "explorerUrl"]) && validHash(value.txHash) &&
    validExplorer(value.explorerUrl, value.txHash)) return value as unknown as TransactionOutcome;
  if (status === "unknown" && exact(value, ["status"])) return value as unknown as TransactionOutcome;
  if (status === "unknown" && exact(value, ["status", "txHash", "explorerUrl"]) && validHash(value.txHash) &&
    validExplorer(value.explorerUrl, value.txHash)) return value as unknown as TransactionOutcome;
  return null;
}
