import { useEffect, useId, useState } from "react";
import {
  getTradeCardMatches,
  type TradeCardMatches,
} from "../social_generated";
import { Pill } from "../ui/Pill";
import { variantLabel } from "../ui/variantLabel";
import { Button } from "../ui/Button";
import { useOpenProposal } from "./openProposal";
import { tradeCardName } from "./tradeText";

/**
 * Ask to trade in Catalog's card popup (Trading #276, spec stories 58 to 62): the Friends with a copy of the Card
 * Printing on their Trade List, each Edition with its Variant and how many copies they offer, and **Ask to trade**,
 * which opens the proposal builder for that Friend with one copy of the card in You get (Trading #284); the popup
 * closes as the page changes. Nothing shows while it loads, when it fails, outside the signed-in shell, or when no
 * Friend offers the card: Ask to trade appears only for Friends with a copy on offer. It never names a Location or a Deck.
 */
export function AskToTrade({ printingId }: { printingId: string }) {
  const headingId = useId();
  const open = useOpenProposal();
  // Outside the signed-in shell there is no way to open a builder, so nothing is read.
  const signedIn = open !== null;
  const [answer, setAnswer] = useState<{
    printingId: string;
    matches: TradeCardMatches;
  } | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    const controller = new AbortController();
    getTradeCardMatches(printingId, controller.signal).then(
      (matches) => {
        if (!controller.signal.aborted) setAnswer({ printingId, matches });
      },
      () => {
        if (!controller.signal.aborted) setAnswer(null);
      }
    );
    return () => controller.abort();
  }, [printingId, signedIn]);

  if (!open || !answer || answer.printingId !== printingId) return null;
  const { offers } = answer.matches;
  if (offers.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h3
        id={headingId}
        className="m-0 text-meta font-semibold text-text-muted"
      >
        Friends with this on their Trade List
      </h3>
      <ul
        aria-labelledby={headingId}
        className="m-0 flex list-none flex-col gap-1 p-0"
      >
        {offers.map((offer) => {
          return (
            <li
              key={`${offer.collector_id}:${offer.edition_id}`}
              className="flex flex-wrap items-center gap-x-2 gap-y-1"
            >
              <span className="min-w-0 flex-1 text-meta wrap-anywhere">
                <span className="font-semibold text-text">
                  {offer.display_name}
                </span>{" "}
                <span className="text-text-subtle">@{offer.handle}</span>
              </span>
              <span className="flex flex-wrap gap-1">
                <Pill>{variantLabel(offer.descriptor)}</Pill>
                <Pill>×{offer.copies}</Pill>
              </span>
              <Button
                aria-label={`Ask ${offer.display_name} to trade ${tradeCardName(offer)}`}
                onClick={() => open(offer.handle, offer)}
              >
                Ask to trade
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
