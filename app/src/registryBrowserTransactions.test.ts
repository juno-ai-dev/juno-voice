import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTransactionAccess } from "./browserTransactions";
import type { VoiceDataSource } from "./client";
import type { Project, RegistryDataSource } from "./registry";
import { buildRegistryIntent, type RegistryActionContext } from "./registryActions";
import { config, ledger } from "./test/bountyFixtures";

const cosmwasm = vi.hoisted(() => ({ connectWithSigner: vi.fn() }));
vi.mock("@cosmjs/cosmwasm-stargate", () => ({
  SigningCosmWasmClient: { connectWithSigner: cosmwasm.connectWithSigner },
}));

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const digest = `sha256:${"a".repeat(64)}`;
const registryData = {
  config: { native_denom: "ujuno", registration_bond: "100000000", max_active_projects: 99,
    max_metadata_uri_bytes: 512, max_page_limit: 100, max_reason_bytes: 2048,
    payout_address_delay_seconds: 86400, curator: sender, governor: sender, version: 1 },
  pause: { admissions_stopped: false, adapter_stopped: false, reason: null, actor: null, changed_at: null },
  health: { accounting: { active_projects: 0, pending_applications: 0, bond_liability: "0",
    lifetime_bonds_received: "0", lifetime_bonds_refunded: "0", lifetime_bonds_forfeited: "0" },
    actual_native_balance: "0", fully_backed: true },
  projects: [], applications: [], options: ["do-not-distribute"], observationHeight: 100,
  refreshedAt: new Date(0), weakConsistency: true as const,
};
const before: RegistryActionContext = { data: registryData, project: null, chainTimeNanos: "10", fingerprint: "registry-before" };
const registered: Project = { id: 1, owner: sender, payout_address: sender, metadata_uri: "ipfs://alpha",
  metadata_digest: digest, status: "pending", created_at: "10", updated_at: "10", status_history_count: 1,
  address_history_count: 0, provenance: { kind: "bonded_registration", applicant: sender },
  bond: { amount: "100000000", depositor: sender, state: "deposited" }, pending_payout_address: null, latest_review: null };
const after: RegistryActionContext = { ...before, data: { ...registryData, health: { ...registryData.health,
  accounting: { ...registryData.health.accounting, pending_applications: 1, bond_liability: "100000000", lifetime_bonds_received: "100000000" }, actual_native_balance: "100000000" } },
  project: registered, fingerprint: "registry-after" };
const intent = buildRegistryIntent(config, sender, before, { action: "register_project", projectId: null,
  metadataUri: "ipfs://alpha", metadataDigest: digest, address: sender, note: "" });
const success = { transactionHash: "REGISTRY_HASH", height: 101, gasWanted: 1n, gasUsed: 1n,
  events: [{ type: "wasm-hack_juno_registry.project_registered", attributes: [
    { key: "project_id", value: "1" }, { key: "applicant", value: sender },
  ] }] };

function setup() {
  const getKey = vi.fn(async () => ({ bech32Address: sender }));
  Object.defineProperty(window, "keplr", { configurable: true, value: {
    enable: vi.fn(async () => undefined), getKey, getOfflineSigner: vi.fn(() => ({})),
  } });
  const signing = { simulate: vi.fn(async () => 100_000), execute: vi.fn(async () => success), disconnect: vi.fn() };
  cosmwasm.connectWithSigner.mockResolvedValue(signing);
  const loadActionContext = vi.fn()
    .mockResolvedValueOnce(before).mockResolvedValueOnce(before).mockResolvedValueOnce(after).mockResolvedValueOnce(after);
  const registrySource: RegistryDataSource = { loadRegistry: vi.fn().mockResolvedValue(registryData), loadProject: vi.fn(), loadActionContext };
  const bountySource: VoiceDataSource = { loadLedger: vi.fn(async () => ledger) };
  const access = createBrowserTransactionAccess(config, bountySource, "keplr", registrySource);
  return { access, getKey, signing, loadActionContext };
}

async function reviewed(fixture: ReturnType<typeof setup>) {
  await fixture.access.connect();
  return fixture.access.prepare(intent);
}

describe("production registry browser transaction adapter", () => {
  beforeEach(() => { cosmwasm.connectWithSigner.mockReset(); delete (window as Window & { keplr?: unknown }).keplr; });

  it("uses live canonical context, exact reviewed funds/message, final identity revalidation, and post-transaction confirmation", async () => {
    const fixture = setup();
    const review = await reviewed(fixture);
    const result = await fixture.access.submit(review);
    expect(result).toEqual({ status: "confirmed", txHash: "REGISTRY_HASH", height: 101,
      confirmationStatus: "confirmed", refreshStatus: "refreshed",
      explorerUrl: "https://www.mintscan.io/juno/tx/REGISTRY_HASH" });
    expect(fixture.signing.execute).toHaveBeenCalledWith(sender, config.registryContract,
      intent.executeMessage, review.fee, "", [{ denom: "ujuno", amount: "100000000" }]);
    expect(fixture.loadActionContext.mock.calls).toEqual([
      [null], [null], [1],
    ]);
    expect(fixture.getKey.mock.invocationCallOrder.at(-1)).toBeLessThan(fixture.signing.execute.mock.invocationCallOrder[0]);
  });

  it("preserves a known hash when canonical confirmation fails and consumes the review", async () => {
    const fixture = setup(); const review = await reviewed(fixture);
    fixture.loadActionContext.mockReset().mockResolvedValueOnce(before).mockRejectedValueOnce(new Error("RPC unavailable"));
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown", txHash: "REGISTRY_HASH",
      explorerUrl: "https://www.mintscan.io/juno/tx/REGISTRY_HASH" });
    await expect(fixture.access.submit(review)).rejects.toThrow(/no longer available/);
    expect(fixture.signing.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps hashless post-sign uncertainty non-retryable", async () => {
    const fixture = setup(); const review = await reviewed(fixture);
    fixture.signing.execute.mockRejectedValueOnce(new Error("transport ended after signing began"));
    await expect(fixture.access.submit(review)).resolves.toEqual({ status: "unknown" });
    await expect(fixture.access.submit(review)).rejects.toThrow(/no longer available/);
    expect(fixture.signing.execute).toHaveBeenCalledTimes(1);
  });

  it("rechecks chain-time authorization from fresh canonical context before signing", async () => {
    const fixture = setup();
    const project = { ...registered, status: "active" as const,
      pending_payout_address: { address: sender, proposed_at: "10", executable_at: "20", proposed_by: registered.owner } };
    const eligible = { ...before, project, chainTimeNanos: "20", fingerprint: "accept-state" };
    const tooEarly = { ...eligible, chainTimeNanos: "19" };
    const accept = buildRegistryIntent(config, sender, eligible, { action: "accept_payout_address", projectId: 1,
      metadataUri: "", metadataDigest: "", address: "", note: "" });
    fixture.loadActionContext.mockReset().mockResolvedValueOnce(eligible).mockResolvedValueOnce(tooEarly);
    await fixture.access.connect();
    const review = await fixture.access.prepare(accept);
    await expect(fixture.access.submit(review)).rejects.toThrow(/delay is still open/);
    expect(fixture.signing.execute).not.toHaveBeenCalled();
  });
});
