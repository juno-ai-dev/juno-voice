import type { Bounty } from "./types";
export interface CanonicalEvent { type: string; attributes: readonly { key: string; value: string }[] }
const attrs = (event: CanonicalEvent) => new Map(event.attributes.map((item) => [item.key, item.value]));
export function confirmBountyMutation(options: {
  action: "create_bounty" | "contribute"; events: readonly CanonicalEvent[]; refreshed: Bounty;
  sender: string; amount: string; priorTotal?: string;
}): { bountyId: number; eventType: string } {
  const eventType = options.action === "create_bounty"
    ? "juno_voice_bounties.bounty_created" : "juno_voice_bounties.contributed";
  const matches = options.events.filter((event) => event.type === eventType);
  if (matches.length !== 1) throw new Error("Canonical transaction event is missing or ambiguous.");
  const values = attrs(matches[0]), id = values.get("bounty_id");
  if (!id || !/^\d+$/.test(id) || Number(id) !== options.refreshed.id || values.get("amount") !== options.amount)
    throw new Error("Canonical event does not match refreshed bounty state.");
  if (options.action === "create_bounty") {
    if (values.get("creator") !== options.sender || options.refreshed.creator !== options.sender ||
      options.refreshed.total_contribution !== options.amount)
      throw new Error("Created bounty was not confirmed by refreshed canonical state.");
  } else {
    if (values.get("contributor") !== options.sender || values.get("bounty_total") !== options.refreshed.total_contribution ||
      options.priorTotal === undefined || BigInt(options.priorTotal) + BigInt(options.amount) !== BigInt(options.refreshed.total_contribution))
      throw new Error("Contribution was not confirmed by refreshed canonical state.");
  }
  return { bountyId: options.refreshed.id, eventType };
}
