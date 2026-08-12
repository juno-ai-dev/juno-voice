import { canonicalDecimal, GAUGE_ID, type Ballot, type GaugeActionContext, type GaugeVote } from "./gauge";
import type { GaugeAction } from "./gaugeActions";
import type { Coin } from "./transactions";

export interface GaugeEvent { type: string; attributes: readonly { key: string; value: string }[] }
const attribute = (event: GaugeEvent, key: string) => event.attributes.find((item) => item.key === key)?.value;
const equalVotes = (left: readonly GaugeVote[], right: readonly GaugeVote[]) =>
  left.length === right.length && left.every((vote, index) => vote.option === right[index]?.option && canonicalDecimal(vote.weight) === canonicalDecimal(right[index]?.weight ?? ""));
const messageBody = (message: Readonly<Record<string, unknown>>, key: string) => {
  const body = message[key]; if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Canonical gauge message is unavailable.");
  return body as Record<string, unknown>;
};

/** Require matching gauge event attributes and refreshed semantic state. */
export function confirmGaugeMutation({ action, events, refreshed, before, sender, executeMessage, funds }: {
  action: GaugeAction; events: readonly GaugeEvent[]; refreshed: GaugeActionContext; before: GaugeActionContext;
  sender: string; executeMessage: Readonly<Record<string, unknown>>; funds: readonly Coin[];
}) {
  if (funds.length !== 0) throw new Error("Gauge actions must not attach funds.");
  const expectedAction = action === "open_epoch" ? "open_snapshot_epoch" : action === "execute" ? "execute_snapshot_epoch" : "place_snapshot_vote";
  const event = events.find((item) => attribute(item, "action") === expectedAction);
  if (!event || attribute(event, "gauge_id") !== String(GAUGE_ID) || attribute(event, "sender") !== sender) throw new Error("Gauge mutation event did not match the reviewed action.");
  if (action === "open_epoch") {
    const current = refreshed.data.current;
    if (!current || current.outcome !== "open" || current.epochId <= (before.data.current?.epochId ?? 0) || attribute(event, "epoch_id") !== String(current.epochId) || attribute(event, "snapshot_height") !== String(current.snapshotHeight))
      throw new Error("Opened epoch was not canonically refreshed.");
    return;
  }
  const epoch = refreshed.data.current;
  if (!epoch || epoch.epochId !== before.data.current?.epochId || attribute(event, "epoch_id") !== String(epoch.epochId)) throw new Error("Canonical epoch identity changed after gauge mutation.");
  if (action === "execute") {
    if (epoch.outcome === "open") throw new Error("Epoch execution is not canonically terminal.");
    const expected = epoch.outcome === "distributed" ? "distributed" : epoch.outcome;
    if (attribute(event, "outcome") !== expected) throw new Error("Epoch execution outcome did not match canonical state.");
    return;
  }
  const body = messageBody(executeMessage, "place_votes"), votes = body.votes;
  if (action === "remove_votes") {
    if (votes !== null || refreshed.data.ballot !== null || attribute(event, "option_count") !== "0") throw new Error("Ballot removal was not canonically confirmed.");
    return;
  }
  if (!Array.isArray(votes)) throw new Error("Reviewed preference ballot is unavailable.");
  const reviewed = votes as GaugeVote[], ballot = refreshed.data.ballot as Ballot | null;
  if (!ballot || ballot.voter !== sender || !equalVotes(reviewed, ballot.votes) || attribute(event, "option_count") !== String(reviewed.length))
    throw new Error("Refreshed ballot did not semantically match the reviewed preferences.");
}
