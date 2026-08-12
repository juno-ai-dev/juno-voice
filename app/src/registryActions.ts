import { fromBech32 } from "@cosmjs/encoding";
import type { AppConfig } from "./config";
import type { Project, RegistryData } from "./registry";
import type { TransactionIntent, TransactionReview, TransactionOutcome } from "./transactions";
import { formatJuno } from "./junoAmount";

export const PROJECT_ID_PATTERN = /^[a-z0-9-]{3,64}$/;
export const METADATA_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
export type RegistryAction = "register_project" | "update_pending_metadata" | "propose_payout_address" |
  "cancel_payout_address_change" | "accept_payout_address" | "retire" | "claim_registration_bond";
export interface RegistryActionInput { action: RegistryAction; projectId: string; metadataUri: string; metadataDigest: string; address: string; note: string }
export interface RegistryActionContext { data: RegistryData; project: Project | null; chainTimeNanos: string; fingerprint: string }
export interface RegistryTransactionFlow { connect?(): Promise<{ address: string }>; prepare(intent: TransactionIntent): Promise<TransactionReview>; submit(review: TransactionReview): Promise<TransactionOutcome> }

const bytes = (value: string) => new TextEncoder().encode(value).length;
const validAccount = (value: string) => {
  try { const decoded = fromBech32(value); return value === value.toLowerCase() && decoded.prefix === "juno" && decoded.data.length === 20; }
  catch { return false; }
};
const fail = (message: string): never => { throw new Error(message); };
const controller = (project: Project, sender: string) => project.owner === sender || project.payout_address === sender;

export function buildRegistryIntent(config: AppConfig, sender: string, context: RegistryActionContext, input: RegistryActionInput): TransactionIntent {
  const { action, projectId, metadataUri, metadataDigest, address, note } = input;
  const { data, project } = context;
  if (!validAccount(sender)) fail("Connect a valid Juno account before preparing this action.");
  if (!PROJECT_ID_PATTERN.test(projectId) || projectId === "do-not-distribute") fail("Project ID must be 3–64 lowercase ASCII letters, digits, or hyphens and not reserved.");
  if (!data.health.fully_backed) fail("Registry bond accounting is not fully backed.");
  if (action === "register_project") {
    if (data.pause.admissions_stopped) fail("Registry admissions are stopped.");
    if (project) fail("That project ID already exists.");
    if (data.health.accounting.active_projects >= data.config.max_active_projects) fail("Registry active-project capacity is full.");
  } else if (!project) fail("Load an existing canonical project before preparing this action.");
  const owned = project?.owner === sender;
  if (action === "update_pending_metadata" && (!owned || project?.status !== "pending" || data.pause.admissions_stopped)) fail("Only the owner may update a pending application while admissions are open.");
  if (action === "propose_payout_address" && (!project || !controller(project, sender) || !["active", "suspended"].includes(project.status))) fail("Only the owner or current payout address may propose an address for an active or suspended project.");
  if (action === "cancel_payout_address_change" && (!project || !controller(project, sender) || !project.pending_payout_address)) fail("Only the owner or current payout address may cancel a pending address change.");
  if (action === "accept_payout_address") {
    const pending = project?.pending_payout_address;
    if (!pending) throw new Error("A pending payout-address change is required.");
    if (pending.address !== sender) fail("Only the proposed payout address may accept this change.");
    if (BigInt(context.chainTimeNanos) < BigInt(pending.executable_at)) fail("The payout-address delay is still open according to canonical chain time.");
  }
  if (action === "retire" && (!owned || !project || !["active", "suspended"].includes(project.status))) fail("Only the owner may voluntarily retire an active or suspended project.");
  if (action === "claim_registration_bond" && (!project?.bond || project.bond.depositor !== sender || project.bond.state !== "claimable")) fail("Only the depositor may claim a claimable registration bond.");
  if (["register_project", "update_pending_metadata"].includes(action)) {
    if (!metadataUri.trim() || bytes(metadataUri) > data.config.max_metadata_uri_bytes) fail(`Metadata URI must be non-empty and at most ${data.config.max_metadata_uri_bytes} UTF-8 bytes.`);
    if (!METADATA_DIGEST_PATTERN.test(metadataDigest)) fail("Metadata digest must be sha256: followed by exactly 64 lowercase hex characters.");
  }
  if (["register_project", "propose_payout_address"].includes(action) && !validAccount(address)) fail("Payout address must be a valid Juno account address.");
  if (action === "propose_payout_address" && address === project?.payout_address) fail("New payout address must differ from the current payout address.");
  if (action === "retire" && (!note.trim() || bytes(note) > data.config.max_reason_bytes)) fail(`Retirement note must be non-empty and at most ${data.config.max_reason_bytes} UTF-8 bytes.`);

  const body = action === "register_project" ? { project_id: projectId, metadata_uri: metadataUri, metadata_digest: metadataDigest, payout_address: address }
    : action === "update_pending_metadata" ? { project_id: projectId, metadata_uri: metadataUri, metadata_digest: metadataDigest }
    : action === "propose_payout_address" ? { project_id: projectId, address }
    : action === "retire" ? { project_id: projectId, reason: { code: "voluntary_retirement", note } }
    : { project_id: projectId };
  const consequences: Record<RegistryAction, string> = {
    register_project: `Attach exactly ${formatJuno(data.config.registration_bond)} as a registration bond.`,
    update_pending_metadata: "Replace the pending application's metadata URI and digest.",
    propose_payout_address: "Start or replace the delayed payout-address change.",
    cancel_payout_address_change: "Cancel the currently pending payout-address change.",
    accept_payout_address: "Make this account the project's canonical payout address.",
    retire: "Permanently retire this project and remove it from active gauge options.",
    claim_registration_bond: `Transfer the claimable registration bond to ${sender}.`,
  };
  return { chainId: config.chainId, contract: config.registryContract, executeMessage: { [action]: body },
    funds: action === "register_project" ? [{ denom: data.config.native_denom, amount: data.config.registration_bond }] : [],
    consequences: [consequences[action]], expectedStateFingerprint: context.fingerprint };
}
