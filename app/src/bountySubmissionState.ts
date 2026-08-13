import type { TransactionReview } from "./transactions";

const STORAGE_PREFIX = "juno-voice:bounty-submission:v1";
const actions = new Set(["create_bounty", "contribute", "nominate_payout", "confirm_sole_payout", "decline_sole_payout",
  "vote_payout", "finalize_payout", "cancel_sole_funded", "expire", "claim_refund"] as const);
export type BountySubmissionAction = typeof actions extends Set<infer T> ? T : never;

export interface BountySubmissionScope { sender: string; chainId: string; contract: string }
export type BountyContractScope = Omit<BountySubmissionScope, "sender">;
export interface BountySubmissionEvidence extends BountySubmissionScope {
  version: 1;
  action: BountySubmissionAction;
  status: "pending" | "unknown";
  txHash?: string;
  explorerUrl?: string;
}
export type StoredBountySubmission =
  | { kind: "uncertain"; evidence: BountySubmissionEvidence }
  | { kind: "malformed" };

const unavailableSubmissions = new Set<string>();
const unavailableLatest = new Set<string>();
const key = ({ sender, chainId, contract }: BountySubmissionScope) =>
  `${STORAGE_PREFIX}:${encodeURIComponent(chainId)}:${encodeURIComponent(contract)}:${encodeURIComponent(sender)}`;
const latestKey = ({ chainId, contract }: BountyContractScope) =>
  `${STORAGE_PREFIX}:latest:${encodeURIComponent(chainId)}:${encodeURIComponent(contract)}`;
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((field) => field in value) && Object.keys(value).every((field) => required.includes(field) || optional.includes(field));
const nonBlank = (value: unknown, max = 256): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const explorerMatches = (value: unknown, txHash: string) => {
  if (!nonBlank(value, 2_048)) return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.pathname.endsWith(`/tx/${encodeURIComponent(txHash)}`); }
  catch { return false; }
};

function parse(value: string, scope: BountySubmissionScope): BountySubmissionEvidence | null {
  try {
    const raw: unknown = JSON.parse(value);
    if (!plain(raw) || !exact(raw, ["version", "sender", "chainId", "contract", "action", "status"], ["txHash", "explorerUrl"]) ||
      raw.version !== 1 || raw.sender !== scope.sender || raw.chainId !== scope.chainId || raw.contract !== scope.contract ||
      !actions.has(raw.action as BountySubmissionAction) || (raw.status !== "pending" && raw.status !== "unknown") ||
      ("txHash" in raw && !nonBlank(raw.txHash)) || (raw.status === "pending" && !("txHash" in raw)) ||
      ("explorerUrl" in raw && (!("txHash" in raw) || !nonBlank(raw.txHash) || !explorerMatches(raw.explorerUrl, raw.txHash)))) return null;
    return raw as unknown as BountySubmissionEvidence;
  } catch { return null; }
}

export function markBountySubmissionUnavailable(scope: BountySubmissionScope): void {
  unavailableSubmissions.add(key(scope));
  unavailableLatest.add(latestKey(scope));
}

export function loadBountySubmission(scope: BountySubmissionScope): StoredBountySubmission | null {
  if (unavailableSubmissions.has(key(scope))) return { kind: "malformed" };
  try {
    const value = window.sessionStorage.getItem(key(scope));
    if (value === null) return null;
    const evidence = parse(value, scope);
    return evidence ? { kind: "uncertain", evidence } : { kind: "malformed" };
  } catch { return { kind: "malformed" }; }
}

export function loadLatestBountySubmission(scope: BountyContractScope): StoredBountySubmission | null {
  if (unavailableLatest.has(latestKey(scope))) return { kind: "malformed" };
  try {
    const value = window.sessionStorage.getItem(latestKey(scope));
    if (value === null) return null;
    const raw: unknown = JSON.parse(value);
    if (!plain(raw) || !exact(raw, ["version", "sender", "chainId", "contract"]) || raw.version !== 1 ||
      !nonBlank(raw.sender) || raw.chainId !== scope.chainId || raw.contract !== scope.contract) return { kind: "malformed" };
    return loadBountySubmission({ sender: raw.sender, ...scope }) ?? { kind: "malformed" };
  } catch { return { kind: "malformed" }; }
}

export function saveBountySubmission(evidence: BountySubmissionEvidence): boolean {
  const submissionKey = key(evidence), contractKey = latestKey(evidence);
  markBountySubmissionUnavailable(evidence);
  try {
    const encoded = JSON.stringify(evidence);
    if (!parse(encoded, evidence)) return false;
    window.sessionStorage.setItem(submissionKey, encoded);
    window.sessionStorage.setItem(contractKey, JSON.stringify({ version: 1, sender: evidence.sender,
      chainId: evidence.chainId, contract: evidence.contract }));
    unavailableSubmissions.delete(submissionKey);
    unavailableLatest.delete(contractKey);
    return true;
  } catch { return false; }
}

export function clearBountySubmission(scope: BountySubmissionScope): boolean {
  const submissionKey = key(scope), contractKey = latestKey(scope);
  unavailableSubmissions.add(submissionKey);
  unavailableLatest.add(contractKey);
  try {
    window.sessionStorage.removeItem(submissionKey);
    const latest = window.sessionStorage.getItem(contractKey);
    if (latest) {
      const raw: unknown = JSON.parse(latest);
      if (!plain(raw)) return false;
      if (raw.sender === scope.sender) window.sessionStorage.removeItem(contractKey);
    }
    unavailableSubmissions.delete(submissionKey);
    unavailableLatest.delete(contractKey);
    return true;
  } catch { return false; }
}

export function bountyActionFromReview(review: TransactionReview, expected: BountyContractScope): BountySubmissionAction | null {
  if (review.chainId !== expected.chainId || review.contract !== expected.contract || !nonBlank(review.sender)) return null;
  const fields = Object.keys(review.executeMessage);
  return fields.length === 1 && actions.has(fields[0] as BountySubmissionAction) ? fields[0] as BountySubmissionAction : null;
}
