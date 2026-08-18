import { describe, expect, it, vi } from "vitest";
import { createRegistryDataSource, mapProject, mapRegistryConfig, registryQueries, type Project } from "./registry";
import { config } from "./test/bountyFixtures";
const account = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
export const project: Project = { id: 1, owner: account, payout_address: account, metadata_uri: "https://example.com/alpha.json", metadata_digest: "ab".repeat(32), status: "active", created_at: "1700000000000000000", updated_at: "1700000000000000000", status_history_count: 1, address_history_count: 0, provenance: { kind: "bonded_registration", applicant: account }, bond: { amount: "100000000", depositor: account, state: "claimable" }, pending_payout_address: null, latest_review: { code: "meets_criteria", note: "ok" } };
const wire = (p: Project) => ({ ...p, provenance: p.provenance.kind === "bonded_registration" ? { bonded_registration: { applicant: p.provenance.applicant } } : { graduated_bounty: { source_bounty_contract: p.provenance.source_bounty_contract, source_bounty_id: p.provenance.source_bounty_id } }, bond: p.bond, pending_payout_address: p.pending_payout_address });
const liveConfig = { native_denom: "ujuno", registration_bond: "100000000", max_active_projects: 99, max_metadata_uri_bytes: 512, max_page_limit: 100, max_reason_bytes: 2048, payout_address_delay_seconds: 86400, curator: account, governor: account, version: 1 };
const base = () => ({ queryContractSmart: vi.fn(), getChainId: vi.fn().mockResolvedValue("juno-1"), getHeight: vi.fn().mockResolvedValue(99), getChainTimeNanos: vi.fn().mockResolvedValue("1800000000000000000"), getContract: vi.fn().mockResolvedValue({ address: config.registryContract, codeId: 5156 }), getCodeDetails: vi.fn().mockResolvedValue({ checksum: config.registryCodeChecksum }), disconnect: vi.fn() });
const singletons = (query: object) => "config" in query ? liveConfig : "pause" in query ? { admissions_stopped: false, adapter_stopped: false, actor: null, reason: null, changed_at: null } : "health" in query ? { accounting: { active_projects: 1, pending_applications: 0, bond_liability: "100000000", lifetime_bonds_received: "100000000", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" }, actual_native_balance: "100000000", fully_backed: true } : null;
describe("registry live schemas", () => {
  it("constructs exact pagination and detail queries", () => { expect(registryQueries.projects()).toEqual({ projects: { start_after: null, limit: 50 } }); expect(registryQueries.applications(1)).toEqual({ applications: { start_after: 1, limit: 50 } }); expect(registryQueries.statusHistory(1, 50)).toEqual({ status_history: { project_id: 1, start_after: 50, limit: 50 } }); });
  it("maps every project response variant and exact integer boundaries", () => {
    expect(mapProject(wire(project))).toEqual(project);
    expect(mapProject({ ...wire(project), provenance: { graduated_bounty: { source_bounty_contract: config.contract, source_bounty_id: 7 } }, bond: null, latest_review: null, pending_payout_address: { address: account, proposed_at: "0", executable_at: "18446744073709551615", proposed_by: account } }).provenance).toEqual({ kind: "graduated_bounty", source_bounty_contract: config.contract, source_bounty_id: 7 });
    for (const status of ["pending", "active", "suspended", "rejected", "retired"]) expect(mapProject({ ...wire(project), status }).status).toBe(status);
    for (const state of ["deposited", "refunded", "forfeited", "claimable", "claimed"]) expect(mapProject({ ...wire(project), bond: { ...project.bond, state } }).bond?.state).toBe(state);
    expect(() => mapProject({ ...wire(project), status: "unknown" })).toThrow("Malformed registry project");
    expect(() => mapProject({ ...wire(project), created_at: "18446744073709551616" })).toThrow();
    expect(() => mapRegistryConfig({ ...liveConfig, registration_bond: "340282366920938463463374607431768211456" })).toThrow();
    expect(() => mapRegistryConfig({ ...liveConfig, max_active_projects: 100 })).toThrow();
    expect(() => mapRegistryConfig({ ...liveConfig, max_metadata_uri_bytes: 2_049 })).toThrow();
  });
  it("paginates full project/option pages with exclusive increasing cursors", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation((_address: string, query: Record<string, unknown>) => {
      const singleton = singletons(query); if (singleton) return Promise.resolve(singleton);
      if ("projects" in query) { const cursor = (query.projects as { start_after: number | null }).start_after; return Promise.resolve({ projects: cursor ? [] : Array.from({ length: 50 }, (_, i) => wire({ ...project, id: i + 1 })) }); }
      if ("applications" in query) return Promise.resolve({ projects: [] });
      if ("all_options" in query) { const cursor = (query.all_options as { start_after: string | null }).start_after; const options = ["do-not-distribute", ...Array.from({ length: 50 }, (_, i) => `project:${i + 1}`)].sort(); const start = cursor === null ? 0 : options.indexOf(cursor) + 1; return Promise.resolve({ options: options.slice(start, start + 50) }); }
      throw new Error("unexpected");
    });
    const result = await createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc)).loadRegistry();
    expect(result.projects).toHaveLength(50); expect(rpc.queryContractSmart).toHaveBeenCalledWith(config.registryContract, registryQueries.projects(50)); expect(rpc.disconnect).toHaveBeenCalledOnce();
  });
  it("accepts the complete mixed-status projects response and exposes only active projects plus pending applications", async () => {
    const rpc = base();
    const complete = (["active", "pending", "rejected", "retired", "suspended"] as const)
      .map((status, index) => ({ ...project, id: index + 1, status }));
    rpc.queryContractSmart.mockImplementation((_address: string, query: Record<string, unknown>) => {
      const singleton = singletons(query); if (singleton) return Promise.resolve(singleton);
      if ("projects" in query) return Promise.resolve({ projects: complete.map(wire) });
      if ("applications" in query) return Promise.resolve({ projects: [wire(complete[1])] });
      if ("all_options" in query) return Promise.resolve({ options: ["do-not-distribute", "project:1"] });
      throw new Error("unexpected");
    });
    const result = await createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc)).loadRegistry();
    expect(result.projects.map(({ id }) => id)).toEqual([1]);
    expect(result.applications.map(({ id }) => id)).toEqual([2]);
    expect([...result.projects, ...result.applications].map(({ id }) => id)).toEqual([1, 2]);
  });
  it("fails closed on deployment, classification, and non-increasing pages", async () => {
    const rpc = base(); rpc.getContract.mockResolvedValue({ address: config.registryContract, codeId: 999 });
    await expect(createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc)).loadRegistry()).rejects.toThrow("deployment mismatch");
    const duplicate = base(); duplicate.queryContractSmart.mockImplementation((_a: string, query: Record<string, unknown>) => Promise.resolve(singletons(query) ?? ("projects" in query ? { projects: [wire(project), wire(project)] } : "applications" in query ? { projects: [] } : { options: ["do-not-distribute"] })));
    await expect(createRegistryDataSource(config, vi.fn().mockResolvedValue(duplicate)).loadRegistry()).rejects.toThrow("Non-increasing");
    const inconsistent = base(); inconsistent.queryContractSmart.mockImplementation((_a: string, query: Record<string, unknown>) => Promise.resolve(singletons(query) ?? ("projects" in query ? { projects: [wire(project)] } : "applications" in query ? { projects: [wire({ ...project, id: 2, status: "pending" })] } : { options: ["do-not-distribute"] })));
    await expect(createRegistryDataSource(config, vi.fn().mockResolvedValue(inconsistent)).loadRegistry()).rejects.toThrow("inconsistent project classifications");
  });
  it("does not query a project before the registry assigns a registration ID", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation(async (_address: string, query: Record<string, unknown>) => {
      if ("project" in query) throw new Error("project query must not run");
      return singletons(query);
    });
    const missing = await createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc)).loadActionContext(null);
    expect(missing.project).toBeNull();
    expect(rpc.queryContractSmart).not.toHaveBeenCalledWith(config.registryContract, expect.objectContaining({ project: expect.anything() }));
  });
  it("keeps action fingerprints stable across height and chain-time changes", async () => {
    const rpc = base();
    rpc.queryContractSmart.mockImplementation(async (_address: string, query: Record<string, unknown>) => {
      if ("project" in query) return wire(project);
      return singletons(query);
    });
    const source = createRegistryDataSource(config, vi.fn().mockResolvedValue(rpc));
    const first = await source.loadActionContext(project.id);
    rpc.getHeight.mockResolvedValue(100); rpc.getChainTimeNanos.mockResolvedValue("1800000001000000000");
    const second = await source.loadActionContext(project.id);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.data.observationHeight).toBe(100);
    expect(second.chainTimeNanos).not.toBe(first.chainTimeNanos);
  });
});
