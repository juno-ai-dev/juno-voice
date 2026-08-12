import { describe, expect, it, vi } from "vitest";
import { createRegistryDataSource, mapProject, mapRegistryConfig, registryQueries, type Project } from "./registry";
import { config } from "./test/bountyFixtures";
const account = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
export const project: Project = { id: "alpha", owner: account, payout_address: account, metadata_uri: "https://example.com/alpha.json", metadata_digest: "ab".repeat(32), status: "active", created_at: "1700000000000000000", updated_at: "1700000000000000000", status_history_count: 1, address_history_count: 0, provenance: { kind: "bonded_registration", applicant: account }, bond: { amount: "1000000", depositor: account, state: "claimable" }, pending_payout_address: null, latest_review: { code: "meets_criteria", note: "ok" } };
const wire = (p: Project) => ({ ...p, provenance: p.provenance.kind === "bonded_registration" ? { bonded_registration: { applicant: p.provenance.applicant } } : { graduated_bounty: { source_bounty_id: p.provenance.source_bounty_id } }, bond: p.bond, pending_payout_address: p.pending_payout_address });
const liveConfig = { native_denom: "ujuno", registration_bond: "1000000", max_active_projects: 100, max_metadata_uri_bytes: 512, max_page_limit: 50, max_reason_bytes: 500, payout_address_delay_seconds: 86400, curator: account, governor: account, version: "1" };
const base = () => ({ queryContractSmart: vi.fn(), getChainId: vi.fn().mockResolvedValue("juno-1"), getHeight: vi.fn().mockResolvedValue(99), getContract: vi.fn().mockResolvedValue({ address: config.registryContract, codeId: 5151 }), getCodeDetails: vi.fn().mockResolvedValue({ checksum: config.registryCodeChecksum }), disconnect: vi.fn() });
const singletons = (query: object) => "config" in query ? liveConfig : "pause" in query ? { admissions_stopped: false, adapter_stopped: false, actor: null, reason: null, changed_at: null } : "health" in query ? { accounting: { active_projects: 1, pending_applications: 0, bond_liability: "1000000", lifetime_bonds_received: "1000000", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" }, actual_native_balance: "1000000", fully_backed: true } : null;
describe("registry live schemas", () => {
  it("constructs exact pagination and detail queries", () => { expect(registryQueries.projects()).toEqual({ projects: { start_after: null, limit: 50 } }); expect(registryQueries.applications("a")).toEqual({ applications: { start_after: "a", limit: 50 } }); expect(registryQueries.statusHistory("a", 50)).toEqual({ status_history: { project_id: "a", start_after: 50, limit: 50 } }); });
  it("maps every project response variant and exact integer boundaries", () => {
    expect(mapProject(wire(project))).toEqual(project);
    expect(mapProject({ ...wire(project), provenance: { graduated_bounty: { source_bounty_id: 7 } }, bond: null, latest_review: null, pending_payout_address: { address: account, proposed_at: "0", executable_at: "18446744073709551615", proposed_by: account } }).provenance).toEqual({ kind: "graduated_bounty", source_bounty_id: 7 });
    for (const status of ["pending", "active", "suspended", "rejected", "retired"]) expect(mapProject({ ...wire(project), status }).status).toBe(status);
    for (const state of ["deposited", "refunded", "forfeited", "claimable", "claimed"]) expect(mapProject({ ...wire(project), bond: { ...project.bond, state } }).bond?.state).toBe(state);
    expect(() => mapProject({ ...wire(project), status: "unknown" })).toThrow("Malformed registry project");
    expect(() => mapProject({ ...wire(project), created_at: "18446744073709551616" })).toThrow();
    expect(() => mapRegistryConfig({ ...liveConfig, registration_bond: "340282366920938463463374607431768211456" })).toThrow();
  });
  it("paginates full project/option pages with exclusive increasing cursors", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation((_address: string, query: Record<string, unknown>) => {
      const singleton = singletons(query); if (singleton) return Promise.resolve(singleton);
      if ("projects" in query) { const cursor = (query.projects as { start_after: string | null }).start_after; return Promise.resolve({ projects: cursor ? [] : Array.from({ length: 50 }, (_, i) => wire({ ...project, id: String(i).padStart(2, "0") })) }); }
      if ("applications" in query) return Promise.resolve({ projects: [] });
      if ("all_options" in query) { const cursor = (query.all_options as { start_after: string | null }).start_after; return Promise.resolve({ options: cursor ? [] : ["do-not-distribute"] }); }
      throw new Error("unexpected");
    });
    const result = await createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc)).loadRegistry();
    expect(result.projects).toHaveLength(50); expect(rpc.queryContractSmart).toHaveBeenCalledWith(config.registryContract, registryQueries.projects("49")); expect(rpc.disconnect).toHaveBeenCalledOnce();
  });
  it("fails closed on deployment, classification, and non-increasing pages", async () => {
    const rpc = base(); rpc.getContract.mockResolvedValue({ address: config.registryContract, codeId: 999 });
    await expect(createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc)).loadRegistry()).rejects.toThrow("deployment mismatch");
    const duplicate = base(); duplicate.queryContractSmart.mockImplementation((_a: string, query: Record<string, unknown>) => Promise.resolve(singletons(query) ?? ("projects" in query ? { projects: [wire(project), wire(project)] } : "applications" in query ? { projects: [] } : { options: ["do-not-distribute"] })));
    await expect(createRegistryDataSource(config, vi.fn().mockResolvedValue(duplicate)).loadRegistry()).rejects.toThrow("Non-increasing");
  });
});
