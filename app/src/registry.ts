import type { AppConfig } from "./config";
import { connectRpc, type Connect } from "./rpc";
import type { RegistryActionContext } from "./registryActions";

export const REGISTRY_PAGE_LIMIT = 50;
const U64_MAX = 18446744073709551615n;
const U128_MAX = 340282366920938463463374607431768211455n;
const bad = (where: string): never => { throw new Error(`Malformed registry ${where} response from RPC.`); };
const record = (value: unknown, where: string): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : bad(where);
const string = (value: unknown, where: string) => typeof value === "string" ? value : bad(where);
const boolean = (value: unknown, where: string) => typeof value === "boolean" ? value : bad(where);
const integer = (value: unknown, where: string) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad(where);
const uint = (value: unknown, where: string, max = U128_MAX) => {
  const text = string(value, where);
  if (!/^(0|[1-9]\d*)$/.test(text) || BigInt(text) > max) bad(where);
  return text;
};
const nullable = <T>(value: unknown, map: (item: unknown) => T) => value === null || value === undefined ? null : map(value);
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []) => {
  if (required.some((key) => !(key in value)) || Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) bad("object");
};

export type ProjectStatus = "pending" | "active" | "suspended" | "rejected" | "retired";
export type BondState = "deposited" | "refunded" | "forfeited" | "claimable" | "claimed";
export interface RegistryConfig {
  native_denom: string; registration_bond: string; max_active_projects: number; max_metadata_uri_bytes: number;
  max_page_limit: number; max_reason_bytes: number; payout_address_delay_seconds: number; curator: string; governor: string; version: string;
}
export interface RegistryPause { admissions_stopped: boolean; adapter_stopped: boolean; reason: string | null; actor: string | null; changed_at: string | null }
export interface RegistryAccounting { active_projects: number; pending_applications: number; bond_liability: string; lifetime_bonds_received: string; lifetime_bonds_refunded: string; lifetime_bonds_forfeited: string }
export interface RegistryHealth { accounting: RegistryAccounting; actual_native_balance: string; fully_backed: boolean }
export interface Project {
  id: string; owner: string; payout_address: string; metadata_uri: string; metadata_digest: string; status: ProjectStatus;
  created_at: string; updated_at: string; status_history_count: number; address_history_count: number;
  provenance: { kind: "bonded_registration"; applicant: string } | { kind: "graduated_bounty"; source_bounty_id: number };
  bond: { amount: string; depositor: string; state: BondState } | null;
  pending_payout_address: { address: string; proposed_at: string; executable_at: string; proposed_by: string } | null;
  latest_review: { code: string; note: string } | null;
}
export interface StatusHistory { sequence: number; project_id: string; from: ProjectStatus | null; to: ProjectStatus; action: string; actor: string; at: string; reason: { code: string; note: string } | null }
export interface AddressHistory { sequence: number; project_id: string; action: "proposed" | "replaced" | "cancelled" | "accepted"; actor: string; at: string; old_address: string; proposed_address: string | null }
export interface ProjectDetail { project: Project; statusHistory: StatusHistory[]; addressHistory: AddressHistory[] }
export interface RegistryData { config: RegistryConfig; pause: RegistryPause; health: RegistryHealth; projects: Project[]; applications: Project[]; options: string[]; observationHeight: number; refreshedAt: Date; weakConsistency: true }

const statuses = new Set<ProjectStatus>(["pending", "active", "suspended", "rejected", "retired"]);
const bonds = new Set<BondState>(["deposited", "refunded", "forfeited", "claimable", "claimed"]);
const review = (value: unknown) => nullable(value, (item) => { const x = record(item, "review"); exactKeys(x, ["code", "note"]); return { code: string(x.code, "review"), note: string(x.note, "review") }; });
export function mapProject(value: unknown): Project {
  const x = record(value, "project");
  exactKeys(x, ["id", "owner", "payout_address", "metadata_uri", "metadata_digest", "status", "created_at", "updated_at", "status_history_count", "address_history_count", "provenance"], ["bond", "pending_payout_address", "latest_review"]);
  const status = string(x.status, "project") as ProjectStatus;
  if (!statuses.has(status)) bad("project");
  const provenanceRaw = record(x.provenance, "provenance");
  let provenance: Project["provenance"] | undefined;
  if ("bonded_registration" in provenanceRaw && Object.keys(provenanceRaw).length === 1) {
    const body = record(provenanceRaw.bonded_registration, "provenance"); exactKeys(body, ["applicant"]);
    provenance = { kind: "bonded_registration", applicant: string(body.applicant, "provenance") };
  } else if ("graduated_bounty" in provenanceRaw && Object.keys(provenanceRaw).length === 1) {
    const body = record(provenanceRaw.graduated_bounty, "provenance"); exactKeys(body, ["source_bounty_id"]);
    provenance = { kind: "graduated_bounty", source_bounty_id: integer(body.source_bounty_id, "provenance") };
  } else bad("provenance");
  if (!provenance) return bad("provenance");
  const bond = nullable(x.bond, (item) => { const body = record(item, "bond"); exactKeys(body, ["amount", "depositor", "state"]); const state = string(body.state, "bond") as BondState; if (!bonds.has(state)) bad("bond"); return { amount: uint(body.amount, "bond"), depositor: string(body.depositor, "bond"), state }; });
  const pending = nullable(x.pending_payout_address, (item) => { const body = record(item, "pending payout"); exactKeys(body, ["address", "proposed_at", "executable_at", "proposed_by"]); return { address: string(body.address, "pending payout"), proposed_at: uint(body.proposed_at, "pending payout", U64_MAX), executable_at: uint(body.executable_at, "pending payout", U64_MAX), proposed_by: string(body.proposed_by, "pending payout") }; });
  return { id: string(x.id, "project"), owner: string(x.owner, "project"), payout_address: string(x.payout_address, "project"), metadata_uri: string(x.metadata_uri, "project"), metadata_digest: string(x.metadata_digest, "project"), status, created_at: uint(x.created_at, "project", U64_MAX), updated_at: uint(x.updated_at, "project", U64_MAX), status_history_count: integer(x.status_history_count, "project"), address_history_count: integer(x.address_history_count, "project"), provenance: provenance as Project["provenance"], bond, pending_payout_address: pending, latest_review: review(x.latest_review) };
}
export function mapRegistryConfig(value: unknown): RegistryConfig {
  const x = record(value, "config");
  const config = { native_denom: string(x.native_denom, "config"), registration_bond: uint(x.registration_bond, "config"), max_active_projects: integer(x.max_active_projects, "config"), max_metadata_uri_bytes: integer(x.max_metadata_uri_bytes, "config"), max_page_limit: integer(x.max_page_limit, "config"), max_reason_bytes: integer(x.max_reason_bytes, "config"), payout_address_delay_seconds: integer(x.payout_address_delay_seconds, "config"), curator: string(x.curator, "config"), governor: string(x.governor, "config"), version: uint(x.version, "config", U64_MAX) };
  if (config.native_denom !== "ujuno" || config.registration_bond === "0" || config.max_active_projects !== 99 || config.max_metadata_uri_bytes < 1 || config.max_metadata_uri_bytes > 2_048 || config.max_page_limit < 1 || config.max_page_limit > 100 || config.max_reason_bytes < 1 || config.max_reason_bytes > 2_048 || config.payout_address_delay_seconds < 1 || config.payout_address_delay_seconds > 7_776_000) bad("config");
  return config;
}
const mapAccounting = (value: unknown): RegistryAccounting => { const x = record(value, "accounting"); return { active_projects: integer(x.active_projects, "accounting"), pending_applications: integer(x.pending_applications, "accounting"), bond_liability: uint(x.bond_liability, "accounting"), lifetime_bonds_received: uint(x.lifetime_bonds_received, "accounting"), lifetime_bonds_refunded: uint(x.lifetime_bonds_refunded, "accounting"), lifetime_bonds_forfeited: uint(x.lifetime_bonds_forfeited, "accounting") }; };
const mapPause = (value: unknown): RegistryPause => { const x = record(value, "pause"); return { admissions_stopped: boolean(x.admissions_stopped, "pause"), adapter_stopped: boolean(x.adapter_stopped, "pause"), reason: nullable(x.reason, (v) => string(v, "pause")), actor: nullable(x.actor, (v) => string(v, "pause")), changed_at: nullable(x.changed_at, (v) => uint(v, "pause", U64_MAX)) }; };
const mapHealth = (value: unknown): RegistryHealth => { const x = record(value, "health"); return { accounting: mapAccounting(x.accounting), actual_native_balance: uint(x.actual_native_balance, "health"), fully_backed: boolean(x.fully_backed, "health") }; };
const list = (value: unknown, key: "projects" | "entries") => { const x = record(value, key); if (!Array.isArray(x[key])) bad(key); return x[key] as unknown[]; };
const actionLabel = (value: unknown) => typeof value === "string" ? value : (() => { const x = record(value, "status action"); if (Object.keys(x).length !== 1 || !("reviewed" in x)) bad("status action"); const y = record(x.reviewed, "status action"); exactKeys(y, ["decision"]); return `reviewed:${string(y.decision, "status action")}`; })();
const mapStatus = (value: unknown): StatusHistory => { const x = record(value, "status history"); const from = nullable(x.from, (v) => string(v, "status history") as ProjectStatus), to = string(x.to, "status history") as ProjectStatus; if ((from && !statuses.has(from)) || !statuses.has(to)) bad("status history"); return { sequence: integer(x.sequence, "status history"), project_id: string(x.project_id, "status history"), from, to, action: actionLabel(x.action), actor: string(x.actor, "status history"), at: uint(x.at, "status history", U64_MAX), reason: review(x.reason) }; };
const addressActions = new Set(["proposed", "replaced", "cancelled", "accepted"] as const);
const mapAddress = (value: unknown): AddressHistory => { const x = record(value, "address history"), action = string(x.action, "address history") as AddressHistory["action"]; if (!addressActions.has(action)) bad("address history"); return { sequence: integer(x.sequence, "address history"), project_id: string(x.project_id, "address history"), action, actor: string(x.actor, "address history"), at: uint(x.at, "address history", U64_MAX), old_address: string(x.old_address, "address history"), proposed_address: nullable(x.proposed_address, (v) => string(v, "address history")) }; };

export const registryQueries = {
  config: () => ({ config: {} }), pause: () => ({ pause: {} }), health: () => ({ health: {} }), project: (projectId: string) => ({ project: { project_id: projectId } }),
  projects: (startAfter: string | null = null) => ({ projects: { start_after: startAfter, limit: REGISTRY_PAGE_LIMIT } }),
  applications: (startAfter: string | null = null) => ({ applications: { start_after: startAfter, limit: REGISTRY_PAGE_LIMIT } }),
  options: (startAfter: string | null = null) => ({ all_options: { start_after: startAfter, limit: REGISTRY_PAGE_LIMIT } }),
  statusHistory: (projectId: string, startAfter: number | null = null) => ({ status_history: { project_id: projectId, start_after: startAfter, limit: REGISTRY_PAGE_LIMIT } }),
  addressHistory: (projectId: string, startAfter: number | null = null) => ({ address_history: { project_id: projectId, start_after: startAfter, limit: REGISTRY_PAGE_LIMIT } }),
} as const;
async function paginate<T>(query: (cursor: string | number | null) => Promise<unknown>, map: (value: unknown) => T, key: "projects" | "entries", cursorOf: (item: T) => string | number): Promise<T[]> {
  const output: T[] = []; let cursor: string | number | null = null;
  for (let pageNo = 0; pageNo < 1000; pageNo++) {
    const page = list(await query(cursor), key).map(map);
    for (const item of page) { const next = cursorOf(item); if (cursor !== null && next <= cursor) throw new Error("Non-increasing registry pagination cursor from RPC."); cursor = next; output.push(item); }
    if (page.length < REGISTRY_PAGE_LIMIT) return output;
  }
  throw new Error("Too many registry pages from RPC.");
}
export interface RegistryDataSource {
  loadRegistry(): Promise<RegistryData>;
  loadProject(projectId: string): Promise<ProjectDetail>;
  loadActionContext(projectId: string, allowMissing: boolean): Promise<RegistryActionContext>;
}
export function createRegistryDataSource(cfg: AppConfig, connector: Connect = connectRpc): RegistryDataSource {
  const connect = async () => { const client = await connector(cfg.rpc); const [chain, contract] = await Promise.all([client.getChainId(), client.getContract(cfg.registryContract)]); if (chain !== cfg.chainId || contract.address !== cfg.registryContract || contract.codeId !== cfg.registryCodeId) { client.disconnect(); throw new Error("Registry deployment mismatch."); } const code = await client.getCodeDetails(cfg.registryCodeId); if (code.checksum.toLowerCase() !== cfg.registryCodeChecksum) { client.disconnect(); throw new Error("Registry deployment mismatch: checksum."); } return client; };
  return {
    async loadRegistry() { const client = await connect(); try { const query = (q: object) => client.queryContractSmart(cfg.registryContract, q); const [rawConfig, rawPause, rawHealth, height] = await Promise.all([query(registryQueries.config()), query(registryQueries.pause()), query(registryQueries.health()), client.getHeight()]); const config = mapRegistryConfig(rawConfig); if (config.native_denom !== "ujuno" || config.max_page_limit < REGISTRY_PAGE_LIMIT) throw new Error("Registry deployment has unsupported live configuration."); const [projects, applications, options] = await Promise.all([paginate((cursor) => query(registryQueries.projects(cursor as string | null)), mapProject, "projects", (item) => item.id), paginate((cursor) => query(registryQueries.applications(cursor as string | null)), mapProject, "projects", (item) => item.id), paginate(async (cursor) => { const x = record(await query(registryQueries.options(cursor as string | null)), "options"); if (!Array.isArray(x.options)) bad("options"); return { projects: x.options }; }, (v) => string(v, "option"), "projects", (item) => item)]); if (!options.includes("do-not-distribute") || projects.some((p) => p.status !== "active") || applications.some((p) => p.status !== "pending")) throw new Error("Registry returned inconsistent project classifications."); return { config, pause: mapPause(rawPause), health: mapHealth(rawHealth), projects, applications, options, observationHeight: integer(height, "height"), refreshedAt: new Date(), weakConsistency: true }; } finally { client.disconnect(); } },
    async loadProject(projectId) { const client = await connect(); try { const query = (q: object) => client.queryContractSmart(cfg.registryContract, q); const project = mapProject(await query(registryQueries.project(projectId))); if (project.id !== projectId) throw new Error("Registry project identity mismatch."); const [statusHistory, addressHistory] = await Promise.all([paginate((cursor) => query(registryQueries.statusHistory(projectId, cursor as number | null)), mapStatus, "entries", (item) => item.sequence), paginate((cursor) => query(registryQueries.addressHistory(projectId, cursor as number | null)), mapAddress, "entries", (item) => item.sequence)]); if (statusHistory.some((x) => x.project_id !== projectId) || addressHistory.some((x) => x.project_id !== projectId)) throw new Error("Registry returned cross-project history."); return { project, statusHistory, addressHistory }; } finally { client.disconnect(); } },
    async loadActionContext(projectId, allowMissing) {
      const client = await connect();
      try {
        const query = (q: object) => client.queryContractSmart(cfg.registryContract, q);
        const [rawConfig, rawPause, rawHealth, height, chainTimeNanos] = await Promise.all([
          query(registryQueries.config()), query(registryQueries.pause()), query(registryQueries.health()), client.getHeight(), client.getChainTimeNanos(),
        ]);
        let project: Project | null = null;
        try { project = mapProject(await query(registryQueries.project(projectId))); }
        catch (error) {
          if (!allowMissing || !(error instanceof Error) || !/project not found/i.test(error.message)) throw error;
        }
        if (project && project.id !== projectId) throw new Error("Registry project identity mismatch.");
        const config = mapRegistryConfig(rawConfig), pause = mapPause(rawPause), health = mapHealth(rawHealth);
        const data: RegistryData = { config, pause, health, projects: project?.status === "active" ? [project] : [], applications: project?.status === "pending" ? [project] : [], options: ["do-not-distribute"], observationHeight: integer(height, "height"), refreshedAt: new Date(), weakConsistency: true };
        // Height and time are observation metadata, not mutable contract state. Including
        // either would invalidate an otherwise exact review whenever a new block arrives.
        const fingerprint = JSON.stringify({ projectId, project, config, pause, health });
        return { data, project, chainTimeNanos, fingerprint };
      } finally { client.disconnect(); }
    },
  };
}
