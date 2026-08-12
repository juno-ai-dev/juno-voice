import { describe, expect, it } from "vitest";
import type { Project, RegistryData } from "./registry";
import { confirmRegistryMutation } from "./registryConfirmation";
import type { RegistryAction, RegistryActionContext } from "./registryActions";

const sender = "juno10d07y265gmmuvt4z0w9aw880jnsr700jvss730";
const other = "juno1lk5htm0xu0t340wtp5dnyxq4q38c8n6fphcw0p";
const baseProject: Project = { id: "alpha", owner: sender, payout_address: sender,
  metadata_uri: "ipfs://old", metadata_digest: `sha256:${"a".repeat(64)}`, status: "active",
  created_at: "1", updated_at: "2", status_history_count: 1, address_history_count: 0,
  provenance: { kind: "bonded_registration", applicant: sender },
  bond: { amount: "1000000", depositor: sender, state: "claimable" },
  pending_payout_address: null, latest_review: null };
const data = { observationHeight: 12 } as RegistryData;
const context = (project: Project): RegistryActionContext => ({ data, project, chainTimeNanos: "3", fingerprint: "f" });
const event = (action: RegistryAction) => [{ type: `wasm-${({
  register_project: "hack_juno_registry.project_registered",
  update_pending_metadata: "hack_juno_registry.pending_metadata_updated",
  propose_payout_address: "hack_juno_registry.payout_address_proposed",
  cancel_payout_address_change: "hack_juno_registry.payout_address_cancelled",
  accept_payout_address: "hack_juno_registry.payout_address_accepted",
  retire: "hack_juno_registry.project_retired",
  claim_registration_bond: "hack_juno_registry.registration_bond_claimed",
})[action]}`, attributes: [{ key: "project_id", value: "alpha" }] }];

describe("registry canonical transaction confirmation", () => {
  it.each([
    ["register_project", { project_id: "alpha", metadata_uri: "ipfs://new", metadata_digest: `sha256:${"b".repeat(64)}`, payout_address: other },
      { ...baseProject, status: "pending", owner: sender, payout_address: other, metadata_uri: "ipfs://new", metadata_digest: `sha256:${"b".repeat(64)}`, bond: { amount: "1000000", depositor: sender, state: "deposited" } }, [{ denom: "ujuno", amount: "1000000" }]],
    ["update_pending_metadata", { project_id: "alpha", metadata_uri: "ipfs://new", metadata_digest: `sha256:${"b".repeat(64)}` },
      { ...baseProject, status: "pending", metadata_uri: "ipfs://new", metadata_digest: `sha256:${"b".repeat(64)}` }, []],
    ["propose_payout_address", { project_id: "alpha", address: other },
      { ...baseProject, pending_payout_address: { address: other, proposed_at: "2", executable_at: "3", proposed_by: sender } }, []],
    ["cancel_payout_address_change", { project_id: "alpha" }, baseProject, []],
    ["accept_payout_address", { project_id: "alpha" }, { ...baseProject, payout_address: sender, pending_payout_address: null }, []],
    ["retire", { project_id: "alpha", reason: { code: "voluntary_retirement", note: "done" } }, { ...baseProject, status: "retired" }, []],
    ["claim_registration_bond", { project_id: "alpha" }, { ...baseProject, bond: { ...baseProject.bond!, state: "claimed" } }, []],
  ] as const)("confirms %s only from matching event and canonical state", (action, body, project, funds) => {
    expect(() => confirmRegistryMutation({ action, events: event(action), refreshed: context(project), sender,
      executeMessage: { [action]: body }, funds })).not.toThrow();
  });

  it("rejects a matching-looking receipt when canonical state does not prove the mutation", () => {
    expect(() => confirmRegistryMutation({ action: "retire", events: event("retire"), refreshed: context(baseProject), sender,
      executeMessage: { retire: { project_id: "alpha", reason: { code: "voluntary_retirement", note: "done" } } }, funds: [] }))
      .toThrow(/not canonically recorded/);
  });
});
