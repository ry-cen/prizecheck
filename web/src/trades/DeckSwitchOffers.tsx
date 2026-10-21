import { useCallback, useEffect, useId, useState } from "react";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getTradeSide,
  type DeckSwitchOffer,
  type DeckSwitchRequest,
} from "../trades_generated";
import { switchHelpText, switchOfferText } from "./tradeText";

const keyOf = (offer: DeckSwitchOffer) =>
  `${offer.deck_id} ${offer.from_edition_id} ${offer.to_edition_id}`;

export type DeckSwitchState = "idle" | "loading" | "ready" | "failed";

/**
 * The Deck switches Confirm swap offers (Trading #279), read from the reader's own side while `active` (the dialog is
 * open and they get cards), for the place the cards go (`destination`, "" for Unsorted). They are read again whenever
 * the dialog opens, the destination changes or `reload` runs, each time ticking every offer again, unless an unsettled
 * confirm is held (the screen then keeps showing and sending that confirm's own choice). `chosen` is what
 * Confirm swap sends: the ticked offers, in the order the API answered.
 */
export function useDeckSwitchOffers(
  tradeId: string,
  active: boolean,
  destination: string
): {
  state: DeckSwitchState;
  offers: DeckSwitchOffer[];
  ticked: (offer: DeckSwitchOffer) => boolean;
  toggle: (offer: DeckSwitchOffer) => void;
  chosen: () => DeckSwitchRequest[];
  reload: () => void;
} {
  const [state, setState] = useState<DeckSwitchState>("idle");
  const [offers, setOffers] = useState<DeckSwitchOffer[]>([]);
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!active) {
      setState("idle");
      setOffers([]);
      return;
    }
    const controller = new AbortController();
    setState("loading");
    setOffers([]);
    getTradeSide(tradeId, controller.signal, destination || null).then(
      (side) => {
        if (controller.signal.aborted) return;
        setOffers(side.deck_switches);
        setUnticked(new Set());
        setState("ready");
      },
      () => {
        if (!controller.signal.aborted) setState("failed");
      }
    );
    return () => controller.abort();
  }, [tradeId, active, destination, generation]);
  const ticked = useCallback(
    (offer: DeckSwitchOffer) => !unticked.has(keyOf(offer)),
    [unticked]
  );
  const toggle = useCallback((offer: DeckSwitchOffer) => {
    setUnticked((current) => {
      const next = new Set(current);
      const key = keyOf(offer);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  return {
    state,
    offers,
    ticked,
    toggle,
    chosen: () =>
      offers.filter(ticked).map((offer) => ({
        deck_id: offer.deck_id,
        from_edition_id: offer.from_edition_id,
        to_edition_id: offer.to_edition_id,
        count: offer.count,
      })),
    reload: () => setGeneration((value) => value + 1),
  };
}

/** The Confirm swap dialog's Deck switches: one ticked checkbox per offer, with both cards' images. */
export function DeckSwitchOffers({
  offers,
  ticked,
  disabled,
  onToggle,
}: {
  offers: DeckSwitchOffer[];
  ticked: (offer: DeckSwitchOffer) => boolean;
  disabled: boolean;
  onToggle: (offer: DeckSwitchOffer) => void;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1">
      <h3 id={headingId} className="m-0 text-meta text-text-muted">
        Deck switches
      </h3>
      <ul
        aria-label="Deck switches"
        className="m-0 flex list-none flex-col gap-2 p-0"
      >
        {offers.map((offer) => (
          <li
            key={`${offer.deck_id} ${offer.from_edition_id} ${offer.to_edition_id}`}
            className="flex flex-col gap-1"
          >
            <label className="flex min-h-control cursor-pointer items-center gap-2 text-body phone:min-h-tap">
              <input
                type="checkbox"
                className="m-0 size-4 accent-accent"
                checked={ticked(offer)}
                disabled={disabled}
                onChange={() => onToggle(offer)}
              />
              <span className="min-w-0 wrap-anywhere">
                {switchOfferText(offer)}
              </span>
              <span className="w-10 shrink-0">
                <CardImage url={offer.from_card.image_url} />
              </span>
              <span aria-hidden="true">→</span>
              <span className="w-10 shrink-0">
                <CardImage url={offer.to_card.image_url} />
              </span>
            </label>
            <p className="m-0 text-meta text-text-muted">
              {switchHelpText(offer)}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
