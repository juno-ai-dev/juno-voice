import { DEFAULT_EXPLORER } from "./config";
import { GAUGE_ID } from "./gauge";
import type { GaugeAction } from "./gaugeActions";

const STORAGE_PREFIX = "juno-voice:gauge-submission:v1";
const actions = new Set<GaugeAction>(["open_epoch", "place_votes", "remove_votes", "execute"]);

export interface GaugeSubmissionScope { sender: string; chainId: string; contract: string; gaugeId: typeof GAUGE_ID }
export type GaugeContractScope = Omit<GaugeSubmissionScope, "sender">;
export interface GaugeSubmissionEvidence extends GaugeSubmissionScope {
  version: 1;
  action: GaugeAction;
  epoch: number;
  status: "pending" | "unknown";
  txHash?: string;
  explorerUrl?: string;
}
export type StoredGaugeSubmission =
  | { kind: "uncertain"; evidence: GaugeSubmissionEvidence }
  | { kind: "malformed" };

const unavailableSubmissions = new Set<string>();
const unavailableLatest = new Set<string>();
const key = ({ sender, chainId, contract, gaugeId }: GaugeSubmissionScope) =>
  `${STORAGE_PREFIX}:${encodeURIComponent(chainId)}:${encodeURIComponent(contract)}:${gaugeId}:${encodeURIComponent(sender)}`;
const latestKey = ({ chainId, contract, gaugeId }: GaugeContractScope) =>
  `${STORAGE_PREFIX}:latest:${encodeURIComponent(chainId)}:${encodeURIComponent(contract)}:${gaugeId}`;
const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) =>
  required.every((field) => field in value) && Object.keys(value).every((field) => required.includes(field) || optional.includes(field));
const nonBlank = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
const validExplorerUrl = (value: unknown, txHash: string) => value === `${DEFAULT_EXPLORER}/tx/${encodeURIComponent(txHash)}`;

export function markGaugeSubmissionUnavailable(scope: GaugeSubmissionScope): void {
  unavailableSubmissions.add(key(scope));
  unavailableLatest.add(latestKey(scope));
}

function parse(value: string, scope: GaugeSubmissionScope): GaugeSubmissionEvidence | null {
  try {
    const raw: unknown = JSON.parse(value);
    if (!plain(raw) || !exact(raw, ["version", "sender", "chainId", "contract", "gaugeId", "action", "epoch", "status"], ["txHash", "explorerUrl"]) ||
      raw.version !== 1 || raw.sender !== scope.sender || raw.chainId !== scope.chainId || raw.contract !== scope.contract ||
      raw.gaugeId !== scope.gaugeId || raw.gaugeId !== GAUGE_ID || !actions.has(raw.action as GaugeAction) ||
      !Number.isSafeInteger(raw.epoch) || (raw.epoch as number) < 1 || (raw.status !== "pending" && raw.status !== "unknown") ||
      ("txHash" in raw && !nonBlank(raw.txHash, 256)) || (raw.status === "pending" && !("txHash" in raw)) ||
      ("explorerUrl" in raw && (!("txHash" in raw) || !nonBlank(raw.txHash, 256) || !validExplorerUrl(raw.explorerUrl, raw.txHash)))) return null;
    return raw as unknown as GaugeSubmissionEvidence;
  } catch { return null; }
}

export function loadGaugeSubmission(scope: GaugeSubmissionScope): StoredGaugeSubmission | null {
  if (unavailableSubmissions.has(key(scope))) return { kind: "malformed" };
  try {
    const value = window.sessionStorage.getItem(key(scope));
    if (value === null) return null;
    const evidence = parse(value, scope);
    return evidence ? { kind: "uncertain", evidence } : { kind: "malformed" };
  } catch { return { kind: "malformed" }; }
}

export function loadLatestGaugeSubmission(scope: GaugeContractScope): StoredGaugeSubmission | null {
  if (unavailableLatest.has(latestKey(scope))) return { kind: "malformed" };
  try {
    const value = window.sessionStorage.getItem(latestKey(scope));
    if (value === null) return null;
    const raw: unknown = JSON.parse(value);
    if (!plain(raw) || !exact(raw, ["version", "sender", "chainId", "contract", "gaugeId"]) || raw.version !== 1 ||
      !nonBlank(raw.sender, 256) || raw.chainId !== scope.chainId || raw.contract !== scope.contract || raw.gaugeId !== scope.gaugeId || raw.gaugeId !== GAUGE_ID)
      return { kind: "malformed" };
    return loadGaugeSubmission({ sender: raw.sender, ...scope }) ?? { kind: "malformed" };
  } catch { return { kind: "malformed" }; }
}

export function saveGaugeSubmission(evidence: GaugeSubmissionEvidence): boolean {
  const submissionKey = key(evidence), contractKey = latestKey(evidence);
  markGaugeSubmissionUnavailable(evidence);
  try {
    const encoded = JSON.stringify(evidence);
    if (!parse(encoded, evidence)) return false;
    window.sessionStorage.setItem(submissionKey, encoded);
    window.sessionStorage.setItem(contractKey, JSON.stringify({ version: 1, sender: evidence.sender, chainId: evidence.chainId,
      contract: evidence.contract, gaugeId: evidence.gaugeId }));
    unavailableSubmissions.delete(submissionKey);
    unavailableLatest.delete(contractKey);
    return true;
  } catch { return false; }
}

export function clearGaugeSubmission(scope: GaugeSubmissionScope): boolean {
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

export function gaugeActionFromReview(message: Readonly<Record<string, unknown>>): GaugeAction | null {
  const fields = Object.keys(message);
  if (fields.length !== 1) return null;
  const field = fields[0], body = message[field];
  if (!plain(body) || body.gauge !== GAUGE_ID) return null;
  if ((field === "open_epoch" || field === "execute") && exact(body, ["gauge"])) return field;
  if (field !== "place_votes" || !exact(body, ["gauge", "votes"])) return null;
  if (body.votes === null) return "remove_votes";
  return Array.isArray(body.votes) ? "place_votes" : null;
}
