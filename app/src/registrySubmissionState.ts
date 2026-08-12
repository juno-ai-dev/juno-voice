import type { RegistryAction } from "./registryActions";
import { DEFAULT_EXPLORER } from "./config";

const STORAGE_PREFIX = "juno-voice:registry-submission:v1";
const actions = new Set<RegistryAction>(["register_project", "update_pending_metadata", "propose_payout_address",
  "cancel_payout_address_change", "accept_payout_address", "retire", "claim_registration_bond"]);

export interface RegistrySubmissionScope { sender: string; chainId: string; contract: string }
export type RegistryContractScope = Omit<RegistrySubmissionScope, "sender">;
export interface RegistrySubmissionEvidence extends RegistrySubmissionScope {
  version: 1;
  action: RegistryAction;
  status: "pending" | "unknown";
  txHash?: string;
  explorerUrl?: string;
}
export type StoredRegistrySubmission =
  | { kind: "uncertain"; evidence: RegistrySubmissionEvidence }
  | { kind: "malformed" };

const unavailableSubmissions = new Set<string>();
const unavailableLatest = new Set<string>();

const key = ({ sender, chainId, contract }: RegistrySubmissionScope) =>
  `${STORAGE_PREFIX}:${encodeURIComponent(chainId)}:${encodeURIComponent(contract)}:${encodeURIComponent(sender)}`;
const latestKey = ({ chainId, contract }: RegistryContractScope) =>
  `${STORAGE_PREFIX}:latest:${encodeURIComponent(chainId)}:${encodeURIComponent(contract)}`;
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((field) => field in value) && Object.keys(value).every((field) => required.includes(field) || optional.includes(field));
const nonBlank = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const validExplorerUrl = (value: unknown, txHash: string) =>
  value === `${DEFAULT_EXPLORER}/tx/${encodeURIComponent(txHash)}`;

function parse(value: string, scope: RegistrySubmissionScope): RegistrySubmissionEvidence | null {
  try {
    const raw: unknown = JSON.parse(value);
    if (!plain(raw) || !exact(raw, ["version", "sender", "chainId", "contract", "action", "status"], ["txHash", "explorerUrl"]) || raw.version !== 1 ||
      raw.sender !== scope.sender || raw.chainId !== scope.chainId || raw.contract !== scope.contract || !actions.has(raw.action as RegistryAction) ||
      (raw.status !== "pending" && raw.status !== "unknown") || ("txHash" in raw && !nonBlank(raw.txHash, 256)) ||
      (raw.status === "pending" && !("txHash" in raw)) || ("explorerUrl" in raw && (!("txHash" in raw) ||
        !nonBlank(raw.txHash, 256) || !validExplorerUrl(raw.explorerUrl, raw.txHash)))) return null;
    return raw as unknown as RegistrySubmissionEvidence;
  } catch { return null; }
}

export function loadRegistrySubmission(scope: RegistrySubmissionScope): StoredRegistrySubmission | null {
  if (unavailableSubmissions.has(key(scope))) return { kind: "malformed" };
  try {
    const value = window.sessionStorage.getItem(key(scope));
    if (value === null) return null;
    const evidence = parse(value, scope);
    return evidence ? { kind: "uncertain", evidence } : { kind: "malformed" };
  } catch { return { kind: "malformed" }; }
}

export function loadLatestRegistrySubmission(scope: RegistryContractScope): StoredRegistrySubmission | null {
  if (unavailableLatest.has(latestKey(scope))) return { kind: "malformed" };
  try {
    const value = window.sessionStorage.getItem(latestKey(scope));
    if (value === null) return null;
    const raw: unknown = JSON.parse(value);
    if (!plain(raw) || !exact(raw, ["version", "sender", "chainId", "contract"]) || raw.version !== 1 ||
      !nonBlank(raw.sender, 256) || raw.chainId !== scope.chainId || raw.contract !== scope.contract) return { kind: "malformed" };
    return loadRegistrySubmission({ sender: raw.sender, ...scope }) ?? { kind: "malformed" };
  } catch { return { kind: "malformed" }; }
}

export function saveRegistrySubmission(evidence: RegistrySubmissionEvidence): boolean {
  const submissionKey = key(evidence), contractKey = latestKey(evidence);
  try {
    const encoded = JSON.stringify(evidence);
    if (!parse(encoded, evidence)) return false;
    unavailableSubmissions.add(submissionKey);
    unavailableLatest.add(contractKey);
    window.sessionStorage.setItem(submissionKey, encoded);
    window.sessionStorage.setItem(contractKey, JSON.stringify({ version: 1, sender: evidence.sender, chainId: evidence.chainId, contract: evidence.contract }));
    unavailableSubmissions.delete(submissionKey);
    unavailableLatest.delete(contractKey);
    return true;
  }
  catch { return false; }
}

export function clearRegistrySubmission(scope: RegistrySubmissionScope): void {
  try {
    window.sessionStorage.removeItem(key(scope));
    const latest = window.sessionStorage.getItem(latestKey(scope));
    if (latest) {
      const raw: unknown = JSON.parse(latest);
      if (plain(raw) && raw.sender === scope.sender) window.sessionStorage.removeItem(latestKey(scope));
    }
    unavailableSubmissions.delete(key(scope));
    unavailableLatest.delete(latestKey(scope));
  }
  catch { /* A storage failure must never unlock an uncertain action. */ }
}

export function registryActionFromReview(message: Readonly<Record<string, unknown>>): RegistryAction | null {
  const fields = Object.keys(message);
  return fields.length === 1 && actions.has(fields[0] as RegistryAction) ? fields[0] as RegistryAction : null;
}
