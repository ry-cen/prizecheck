import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import {
  getCardMatches,
  type CardMatches,
  type FriendCopy,
} from "../social_generated";
import { Pill } from "../ui/Pill";
import { lendableText, otherEditionText, readPrintings } from "./friendCards";

/**
 * "Friends who have this" in Catalog's card popup (#251, the Friends' cards verdict): each Friend's copies of the Card
 * Printing, and of the other Printings of its Reprint Group under Use cards I own, with their Display Name, Handle,
 * spare and in-a-Deck counts and the Edition when it isn't the one picked. A collector with no Friends sees nothing
 * here; one whose Friends have none reads "None of your Friends have this card." Nothing shows while it loads or when
 * it fails: the popup is complete without it.
 *
 * Ask to borrow arrives with Borrow Requests (#252): it passes `action` for each Friend's row.
 */
export function FriendsWhoHaveThis({
  printingId,
  editionId,
  action,
}: {
  printingId: string;
  /** The Edition the popup has picked: another Edition of the Printing says its Variant. */
  editionId: string | null;
  action?: (copy: FriendCopy) => ReactNode;
}) {
  const headingId = useId();
  const printings = useMemo(readPrintings, []);
  const [answer, setAnswer] = useState<{
    printingId: string;
    matches: CardMatches;
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getCardMatches(printingId, { printings }, controller.signal).then(
      (matches) => setAnswer({ printingId, matches }),
      () => {
        if (!controller.signal.aborted) setAnswer(null);
      }
    );
    return () => controller.abort();
  }, [printingId, printings]);

  if (!answer || answer.printingId !== printingId) return null;
  if (!answer.matches.has_friends) return null;
  const { copies } = answer.matches;
  return (
    <div className="flex flex-col gap-1">
      <h3
        id={headingId}
        className="m-0 text-meta font-semibold text-text-muted"
      >
        Friends who have this
      </h3>
      {copies.length === 0 ? (
        <p className="m-0 text-meta text-text-muted">
          None of your Friends have this card.
        </p>
      ) : (
        <ul
          aria-labelledby={headingId}
          className="m-0 flex list-none flex-col gap-1 p-0"
        >
          {copies.map((copy) => {
            const other = otherEditionText(copy, editionId);
            return (
              <li
                key={`${copy.collector_id}:${copy.edition_id}`}
                className="flex flex-wrap items-center gap-x-2 gap-y-1"
              >
                <span className="min-w-0 flex-1 text-meta wrap-anywhere">
                  <span className="font-semibold text-text">
                    {copy.display_name}
                  </span>{" "}
                  <span className="text-text-subtle">@{copy.handle}</span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <Pill>{lendableText(copy)}</Pill>
                  {other && <Pill>{other}</Pill>}
                </span>
                {action?.(copy)}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
