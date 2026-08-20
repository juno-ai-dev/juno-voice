import { toBech32 } from "@cosmjs/encoding";
import { describe, expect, it } from "vitest";
import { buildRegistryIntent, type RegistryActionInput, type RegistryActionContext } from "./registryActions";
import { config } from "./test/bountyFixtures";
import { project } from "./registry.test";

const owner = project.owner;
const next = toBech32("juno", new Uint8Array(20).fill(7));
const input: RegistryActionInput = { action: "register_project", projectId: null, metadataUri: "ipfs://metadata", metadataDigest: `sha256:${"a".repeat(64)}`, address: owner, note: "No longer maintained" };
const context = (overrides: Partial<RegistryActionContext> = {}): RegistryActionContext => ({
  data: { config: { native_denom: "ujuno", registration_bond: "1000000", max_active_projects: 99, max_metadata_uri_bytes: 64, max_page_limit: 50, max_reason_bytes: 40, payout_address_delay_seconds: 86400, curator: owner, governor: owner, version: 1 }, pause: { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null }, health: { accounting: { active_projects: 1, pending_applications: 0, bond_liability: "1000000", lifetime_bonds_received: "1000000", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" }, actual_native_balance: "1000000", fully_backed: true }, projects: [], applications: [], options: ["do-not-distribute"], observationHeight: 10, refreshedAt: new Date(0), weakConsistency: true },
  project: null, chainTimeNanos: "1800000000000000000", fingerprint: "canonical-fingerprint", ...overrides,
});

describe("registry transaction intent construction", () => {
  it("constructs exact registration contract, action, funds, and fingerprint", () => {
    const intent = buildRegistryIntent(config, owner, context(), input);
    expect(intent).toMatchObject({ chainId: "juno-1", contract: config.registryContract, expectedStateFingerprint: "canonical-fingerprint", funds: [{ denom: "ujuno", amount: "1000000" }], executeMessage: { register_project: { metadata_uri: "ipfs://metadata", metadata_digest: `sha256:${"a".repeat(64)}`, payout_address: owner } } });
  });
  it("enforces schema byte bounds rather than input character counts", () => {
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, metadataUri: "😀".repeat(17) })).toThrow("UTF-8 bytes");
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, metadataDigest: "ab".repeat(32) })).toThrow("sha256:");
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, projectId: 1 })).toThrow("assigned by the registry");
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, address: "juno1invalid" })).toThrow("valid Juno");
  });
  it("accepts a contract as the payout address, because people fund DAOs", () => {
    // A real Juno DAO address: 32 bytes, where an account is 20.
    const dao = "juno18k65at7fkf8elhece0fnhsvuxggqg6cved6trp5fyk3lftfn93xsmpeaac";
    expect(buildRegistryIntent(config, owner, context(), { ...input, address: dao }).executeMessage).toMatchObject({
      register_project: { payout_address: dao },
    });
    expect(buildRegistryIntent(config, owner, context({ project }), {
      ...input, action: "propose_payout_address", projectId: project.id, address: dao,
    }).executeMessage).toEqual({ propose_payout_address: { project_id: project.id, address: dao } });
    // The signer is still an account: a contract cannot sign a transaction.
    expect(() => buildRegistryIntent(config, dao, context(), input)).toThrow("Connect a valid Juno account");
  });
  it("rejects metadata URIs without a bounded HTTPS or IPFS scheme", () => {
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, metadataUri: "javascript:alert(1)" })).toThrow("HTTPS or IPFS");
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, metadataUri: "ftp://example.com/x" })).toThrow("HTTPS or IPFS");
    expect(() => buildRegistryIntent(config, owner, context(), { ...input, metadataUri: "ipfs://with space" })).toThrow("HTTPS or IPFS");
  });
  it("enforces ownership, status, stop, capacity, and backing", () => {
    expect(() => buildRegistryIntent(config, owner, context({ data: { ...context().data, pause: { ...context().data.pause, admissions_stopped: true } } }), input)).toThrow("stopped");
    expect(() => buildRegistryIntent(config, owner, context({ data: { ...context().data, health: { ...context().data.health, accounting: { ...context().data.health.accounting, active_projects: 99 } } } }), input)).toThrow("capacity");
    expect(() => buildRegistryIntent(config, next, context({ project }), { ...input, action: "retire", projectId: project.id })).toThrow("Only the owner");
  });
  it("enforces owner/controller and project-status boundaries for each mutation", () => {
    const pending = { ...project, status: "pending" as const };
    expect(() => buildRegistryIntent(config, next, context({ project: pending }), { ...input, action: "update_pending_metadata", projectId: project.id })).toThrow("Only the owner");
    expect(() => buildRegistryIntent(config, owner, context({ project }), { ...input, action: "update_pending_metadata", projectId: project.id })).toThrow("pending application");
    expect(() => buildRegistryIntent(config, next, context({ project }), { ...input, action: "propose_payout_address", projectId: project.id, address: next })).toThrow("owner or current payout");
    expect(() => buildRegistryIntent(config, owner, context({ project: { ...project, status: "retired" } }), { ...input, action: "propose_payout_address", projectId: project.id, address: next })).toThrow("active or suspended");
    expect(() => buildRegistryIntent(config, owner, context({ project }), { ...input, action: "cancel_payout_address_change", projectId: project.id })).toThrow("pending address change");
  });
  it("uses canonical chain time and proposed-address identity for acceptance", () => {
    const pending = { ...project, pending_payout_address: { address: next, proposed_at: "1", executable_at: "200", proposed_by: owner } };
    expect(() => buildRegistryIntent(config, next, context({ project: pending, chainTimeNanos: "199" }), { ...input, action: "accept_payout_address", projectId: project.id })).toThrow("delay");
    expect(buildRegistryIntent(config, next, context({ project: pending, chainTimeNanos: "200" }), { ...input, action: "accept_payout_address", projectId: project.id }).executeMessage).toEqual({ accept_payout_address: { project_id: project.id } });
  });
  it("rejects proposing the current payout address", () => {
    expect(() => buildRegistryIntent(config, owner, context({ project }), { ...input, action: "propose_payout_address", projectId: project.id, address: project.payout_address })).toThrow("must differ");
  });
  it("permits only the depositor to claim a claimable bond with no funds", () => {
    const intent = buildRegistryIntent(config, owner, context({ project }), { ...input, action: "claim_registration_bond", projectId: project.id });
    expect(intent.funds).toEqual([]); expect(intent.executeMessage).toEqual({ claim_registration_bond: { project_id: project.id } });
    expect(() => buildRegistryIntent(config, next, context({ project }), { ...input, action: "claim_registration_bond", projectId: project.id })).toThrow("Only the depositor");
    expect(() => buildRegistryIntent(config, owner, context({ project: { ...project, bond: { ...project.bond!, state: "claimed" } } }), { ...input, action: "claim_registration_bond", projectId: project.id })).toThrow("claimable");
  });
  it("enforces the live retirement reason byte limit", () => {
    expect(() => buildRegistryIntent(config, owner, context({ project }), { ...input, action: "retire", projectId: project.id, note: "😀".repeat(11) })).toThrow("UTF-8 bytes");
  });
});
