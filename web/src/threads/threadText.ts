import { tradeCardName } from "../trades/tradeText";
import type {
  LoanView,
  ThreadItem,
  Timeline,
  TimelineItem,
} from "../social_generated";

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
export function itemState(
  item: Pick<ThreadItem, "state" | "kind" | "other"> & {
    waiting?: string | null;
  }
): string {
  if (item.kind === "trade" && item.state === "confirming")
    return item.waiting === "confirm_swap"
      ? `${item.other.display_name} confirmed the swap`
      : !item.waiting
        ? `Waiting for ${item.other.display_name} to confirm the swap`
        : "Agreed";
  return (
    {
      offered: item.kind === "trade" ? "Proposal" : "Lend offer",
      agreed: "Agreed",
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
  editionNames: Record<string, string>,
  kind: "trade" | "loan" = "trade"
): string {
  if (item.message)
    return `${item.message.from === "you" ? "You" : name}: ${item.message.body}`;
  const event = item.event;
  if (!event) return "";
  const labels = { ...editionNames };
  for (const edition of event.editions ?? [])
    labels[edition.edition_id] = tradeCardName(edition);
  const actor = event.actor ? `${event.actor === youAre ? "You" : name}: ` : "";
  const changes = (event.data?.lines ?? []).map((line) => {
    const card = labels[line.edition_id] ?? "copies";
    const side = line.giver === youAre ? "you" : name;
    const action = kind === "loan" ? "lend" : "give";
    const detail =
      line.from_qty === 0
        ? `Added ${line.to_qty} ${card}`
        : line.to_qty === 0
          ? `Removed ${line.from_qty} ${card}`
          : `Changed ${card} to ${line.to_qty}`;
    return `${detail} for ${side} to ${action}`;
  });
  const cash = (value: {
    cents?: number | null;
    payer?: "low" | "high" | null;
  }) =>
    value.cents
      ? `${value.payer === youAre ? "You pay" : "They pay"} $${(value.cents / 100).toFixed(2)}`
      : "No cash";
  if (event.data?.cash) changes.push(`Cash now: ${cash(event.data.cash.to)}`);
  if (event.data?.return_by)
    changes.push(
      event.data.return_by.to
        ? `Return by ${returnDate(event.data.return_by.to)}`
        : "Removed the return date"
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

/** Current terms only: the timeline owns the history of edits. */
export function agreementText(
  row: Pick<ThreadItem, "kind" | "summary"> & { state?: string }
): string {
  const { summary } = row;
  if (row.kind === "loan") {
    if (row.state === "closed") {
      const total = Number(summary.you_give) + Number(summary.you_get);
      return `${total} ${total === 1 ? "card" : "cards"}`;
    }
    return Number(summary.you_give) > 0
      ? `Lending ${summary.you_give}`
      : `Borrowing ${summary.you_get}`;
  }
  const cash = cashText(row);
  return `You give ${summary.you_give} · You get ${summary.you_get}${cash ? ` · ${cash}` : ""}`;
}

export function cashText(row: Pick<ThreadItem, "summary">): string {
  const cash = row.summary.cash;
  return cash
    ? `${cash.payer === "you" ? "You pay" : "They pay"} $${(Number(cash.cents) / 100).toFixed(2)}`
    : "";
}

export function currentCardsText(
  row: Pick<ThreadItem, "kind" | "summary">
): string {
  // The list names at most three cards; the side totals count every copy, so what the names miss is the difference.
  const more = (shown: number, total: string) => {
    const left = Number(total) - shown;
    return left > 0 ? `, +${left} more` : "";
  };
  const cards = (side: "you_give" | "you_get") => {
    const own = row.summary.cards.filter((card) => card.side === side);
    const total = Number(row.summary[side]);
    // A side whose cards all fell past the previews has no names to add to, so it says how many.
    if (own.length === 0)
      return total > 0 ? `${total} ${total === 1 ? "card" : "cards"}` : "";
    return (
      own.map((card) => `${card.copies} ${card.name}`).join(", ") +
      more(
        own.reduce((sum, card) => sum + Number(card.copies), 0),
        row.summary[side]
      )
    );
  };
  if (row.kind === "trade")
    return [
      cards("you_give") && `You give ${cards("you_give")}`,
      cards("you_get") && `You get ${cards("you_get")}`,
    ]
      .filter(Boolean)
      .join(" · ");
  const shown = row.summary.cards.reduce(
    (sum, card) => sum + Number(card.copies),
    0
  );
  const left =
    Number(row.summary.you_give) + Number(row.summary.you_get) - shown;
  return (
    row.summary.cards.map((card) => `${card.copies} ${card.name}`).join(" · ") +
    (left > 0 ? ` · +${left} more` : "")
  );
}

export function loanOutcome(reason: LoanView["closed_reason"]): string {
  if (!reason) return "Closed";
  return (
    {
      returned: "Returned",
      written_off: "Written off",
      declined: "Declined",
      withdrawn: "Withdrawn",
      cancelled: "Cancelled",
    } as const
  )[reason];
}
