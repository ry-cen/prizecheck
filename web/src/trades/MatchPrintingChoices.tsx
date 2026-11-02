import { lineEdition } from "../loans/loanText";
import { Button } from "../ui/Button";
import { tradeCardName } from "./tradeText";
import {
  chooseMatchedPrinting,
  matchSide,
  remainingGroupNeed,
  type Proposal,
  type ProposalMatch,
  type ProposalSide,
} from "./proposalModel";

/** Each prompt uses the builder's existing full-match response, with no id joins to the discovery response. */
export function MatchPrintingChoices({
  side,
  row,
  proposal,
  onChoose,
}: {
  side: ProposalSide;
  row: ProposalMatch;
  proposal: Proposal;
  onChoose: (groupId: string, editionId: string) => void;
}) {
  const { cards, groups } = matchSide(row, side);
  const ambiguous = groups.filter((group) => Number(group.cards) > 1);
  if (ambiguous.length === 0) return null;
  const label = side === "get" ? "You get" : "You give";
  return (
    <section
      aria-label={`Choose printings for ${label}`}
      className="flex min-w-0 flex-col gap-3"
    >
      <h3 className="m-0 text-body font-semibold">
        Choose printings for {label}
      </h3>
      {ambiguous.map((group) => {
        const remaining = remainingGroupNeed(proposal, side, row, group.id);
        const members = cards.filter((card) =>
          card.need_groups?.includes(group.id)
        );
        return (
          <div
            key={group.id}
            className="flex min-w-0 flex-col gap-2 rounded-panel border border-border p-3"
          >
            <p className="m-0 text-body">
              {group.need} wanted across these printings
            </p>
            <p className="m-0 text-meta text-text-muted">
              {remaining} left to choose
            </p>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {members.map((card) => (
                <li
                  key={card.edition_id}
                  className="flex min-w-0 flex-wrap items-center gap-2"
                >
                  <span className="min-w-0 flex-1 text-meta wrap-anywhere">
                    {tradeCardName(card)} · {lineEdition(card)} · {card.copies}{" "}
                    available
                  </span>
                  <Button
                    aria-label={`Choose this printing: ${tradeCardName(card)} · ${lineEdition(card)} for ${label}`}
                    disabled={
                      chooseMatchedPrinting(
                        proposal,
                        side,
                        row,
                        group.id,
                        card.edition_id
                      ) === proposal
                    }
                    onClick={() => onChoose(group.id, card.edition_id)}
                  >
                    Choose this printing
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
