import { tradeCardName } from "../trades/tradeText";
import type { ThreadItem, Timeline, TimelineItem } from "../social_generated";

const EVENTS: Record<string, string> = {
  offered: "Sent an offer",
  requested: "Asked to borrow",
  revised: "Revised the offer",
  countered: "Sent a Counter",
  changed_after_agreement: "Changed the agreed offer",
  accepted: "Agreed",
  partly_accepted: "Agreed to changed Loan terms",
  declined: "Declined",
  withdrawn: "Withdrew the proposal",
  cancelled: "Cancelled the agreement",
  swap_confirmed: "Confirmed the swap",
  swapped: "Swap complete",
  picks_updated: "Updated their picks",
  edited: "Changed the Loan terms",
  handover_confirmed: "Confirmed handover",
  handover_taken_back: "Took back their handover confirmation",
  handed_over: "Handover complete",
  return_recorded: "Recorded a return",
  return_confirmed: "Confirmed the return",
  returned: "All copies are back",
  written_off: "Wrote off copies",
  write_off_choice: "Chose what to do with written-off copies",
  return_by_changed: "Changed the return date",
  more_time_asked: "Asked for more time",
  more_time_approved: "Agreed to more time",
  more_time_declined: "Kept the return date",
};
export function itemState(item: Pick<ThreadItem, "state" | "kind">): string {
  return (
    {
      offered: item.kind === "trade" ? "Proposal" : "Lend offer",
      agreed: "Agreed",
      confirming: "Swap confirmations",
      done: "Swapped",
      requested: "Borrow Request",
      accepted: "Agreed",
      handed_over: "Out now",
      closed: "Closed",
    }[item.state] ?? "Open"
  );
}
function returnDate(value: string | null) {
  if (!value || value === "None") return "No return date";
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.valueOf())
    ? "Return date changed"
    : date.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });
}
/** Deliberately project collector terms only; identities and internal event data are never stringified. */
export function timelineText(
  item: TimelineItem,
  youAre: Timeline["you_are"],
  name: string,
  editionNames: Record<string, string>
): string {
  if (item.message)
    return `${item.message.from === "you" ? "You" : name}: ${item.message.body}`;
  const event = item.event;
  if (!event) return "";
  const labels = { ...editionNames };
  for (const edition of event.editions ?? [])
    labels[edition.edition_id] = tradeCardName(edition);
  const actor = event.actor ? `${event.actor === youAre ? "You" : name}: ` : "";
  const changes = (event.data?.lines ?? []).map(
    (line) =>
      `${line.giver === youAre ? "You give" : "They give"} ${labels[line.edition_id] ?? "copies"}: ${line.from_qty} → ${line.to_qty}`
  );
  const cash = (value: {
    cents?: number | null;
    payer?: "low" | "high" | null;
  }) =>
    value.cents
      ? `${value.payer === youAre ? "You pay" : "They pay"} $${(value.cents / 100).toFixed(2)}`
      : "No cash";
  if (event.data?.cash)
    changes.push(
      `Cash: ${cash(event.data.cash.from)} → ${cash(event.data.cash.to)}`
    );
  if (event.data?.return_by)
    changes.push(
      `Return by: ${returnDate(event.data.return_by.from)} → ${returnDate(event.data.return_by.to)}`
    );
  for (const [field, label] of [
    ["not_lent", "Not lent"],
    [
      "returned",
      event.kind === "return_recorded" ? "Recorded for return" : "Returned",
    ],
  ] as const)
    for (const line of event.data?.[field] ?? [])
      changes.push(
        `${label}: ${line.quantity} ${labels[line.edition_id] ?? "copies"}`
      );
  return `${actor}${EVENTS[event.kind] ?? "Agreement updated"}${changes.map((change) => ` · ${change}`).join("")}`;
}
