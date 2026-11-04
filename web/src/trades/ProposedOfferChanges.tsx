import type { TradeCash } from "../social_generated";
import {
  centsAmount,
  parseCents,
  type CashDraft,
  type Proposal,
} from "./proposalModel";
import { tradeCardName } from "./tradeText";

/** Presentation only: compare the draft with the exact offer already reviewed. */
export function ProposedOfferChanges({
  before,
  after,
  cashBefore,
  cashAfter,
  other,
}: {
  before: Proposal;
  after: Proposal;
  cashBefore: TradeCash | null;
  cashAfter: CashDraft;
  other: string;
}) {
  const changes: string[] = [];
  for (const side of ["give", "get"] as const) {
    const ids = new Set(
      [...before[side], ...after[side]].map((card) => card.edition_id)
    );
    for (const id of ids) {
      const old = before[side].find((card) => card.edition_id === id),
        next = after[side].find((card) => card.edition_id === id);
      if ((old?.quantity ?? 0) === (next?.quantity ?? 0)) continue;
      changes.push(
        `You ${side} ${tradeCardName((next ?? old)!)}: ${old?.quantity ?? 0} → ${next?.quantity ?? 0}`
      );
    }
  }
  const cashText = (cash: TradeCash | null) =>
    cash
      ? `${cash.payer === "you" ? "You pay" : `${other} pays`} $${centsAmount(cash.cents)}`
      : "No cash";
  const cents =
    cashAfter.payer === "none" ? null : parseCents(cashAfter.amount);
  if (cashAfter.payer !== "none" && cents === null)
    changes.push("Complete the cash amount before sending.");
  else {
    const next: TradeCash | null =
      cashAfter.payer === "none"
        ? null
        : { payer: cashAfter.payer, cents: cents! };
    if (cashBefore?.payer !== next?.payer || cashBefore?.cents !== next?.cents)
      changes.push(`Cash: ${cashText(cashBefore)} → ${cashText(next)}`);
  }
  return (
    <section
      aria-label="Proposed changes"
      className="flex min-w-0 flex-col gap-2 rounded-panel border border-border p-3"
    >
      <h2 className="m-0 text-heading font-semibold">Proposed changes</h2>
      <p className="m-0 text-meta text-text-muted">
        Compared with the offer you reviewed.
      </p>
      {changes.length ? (
        <ul className="m-0 pl-5 text-body">
          {changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-body">No changes yet.</p>
      )}
    </section>
  );
}
