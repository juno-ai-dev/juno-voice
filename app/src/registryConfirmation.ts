import type { Project } from "./registry";
import type { RegistryAction, RegistryActionContext } from "./registryActions";
import type { Coin } from "./transactions";

export interface RegistryEvent {
  type: string;
  attributes: readonly { key: string; value: string }[];
}

const eventNames: Record<RegistryAction, string> = {
  register_project: "hack_juno_registry.project_registered",
  update_pending_metadata: "hack_juno_registry.pending_metadata_updated",
  propose_payout_address: "hack_juno_registry.payout_address_proposed",
  cancel_payout_address_change: "hack_juno_registry.payout_address_cancelled",
  accept_payout_address: "hack_juno_registry.payout_address_accepted",
  retire: "hack_juno_registry.project_retired",
  claim_registration_bond: "hack_juno_registry.registration_bond_claimed",
};

function bodyOf(message: Readonly<Record<string, unknown>>, action: RegistryAction): Record<string, unknown> {
  const body = message[action];
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("Canonical registry mutation message is unavailable.");
  return body as Record<string, unknown>;
}

function assertProject(action: RegistryAction, project: Project, body: Record<string, unknown>, sender: string, funds: readonly Coin[]) {
  if (action === "register_project") {
    if (project.status !== "pending" || project.owner !== sender || project.payout_address !== body.payout_address ||
      project.metadata_uri !== body.metadata_uri || project.metadata_digest !== body.metadata_digest ||
      project.bond?.depositor !== sender || project.bond.state !== "deposited" || project.bond.amount !== funds[0]?.amount)
      throw new Error("Registered project did not match the reviewed transaction.");
  } else if (action === "update_pending_metadata") {
    if (project.status !== "pending" || project.metadata_uri !== body.metadata_uri || project.metadata_digest !== body.metadata_digest)
      throw new Error("Pending project metadata was not canonically updated.");
  } else if (action === "propose_payout_address") {
    if (project.pending_payout_address?.address !== body.address)
      throw new Error("Payout-address proposal was not canonically recorded.");
  } else if (action === "cancel_payout_address_change") {
    if (project.pending_payout_address !== null)
      throw new Error("Payout-address cancellation was not canonically recorded.");
  } else if (action === "accept_payout_address") {
    if (project.payout_address !== sender || project.pending_payout_address !== null)
      throw new Error("Payout-address acceptance was not canonically recorded.");
  } else if (action === "retire") {
    if (project.status !== "retired")
      throw new Error("Project retirement was not canonically recorded.");
  } else if (project.bond?.state !== "claimed") {
    throw new Error("Registration-bond claim was not canonically recorded.");
  }
}

/** Require both the contract event and fresh canonical state before reporting confirmation. */
export function confirmRegistryMutation({
  action,
  events,
  refreshed,
  sender,
  executeMessage,
  funds,
}: {
  action: RegistryAction;
  events: readonly RegistryEvent[];
  refreshed: RegistryActionContext;
  sender: string;
  executeMessage: Readonly<Record<string, unknown>>;
  funds: readonly Coin[];
}) {
  const body = bodyOf(executeMessage, action);
  const projectId = body.project_id;
  if (typeof projectId !== "string" || refreshed.project?.id !== projectId)
    throw new Error("Canonical registry project could not be refreshed.");
  const matches = events.filter((item) => item.type === eventNames[action] || item.type === `wasm-${eventNames[action]}`);
  if (matches.length !== 1 || matches[0].attributes.find((item) => item.key === "project_id")?.value !== projectId)
    throw new Error("Registry mutation event is missing, ambiguous, or did not match the reviewed project.");
  assertProject(action, refreshed.project, body, sender, funds);
}
