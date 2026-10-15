import { useEffect, useState } from "react";
import type { ReviewImport } from "../../decks_generated";

/** The owned-cards setting the review is posted with (#214): "exact" or "owned". */
export type OwnedCards = NonNullable<ReviewImport["owned"]>;

/**
 * The owned-cards setting's two choices (decklist import spec "Owned cards"), in the order the review's side column
 * lists them, with the line that explains each.
 */
export const OWNED_OPTIONS: readonly {
  value: OwnedCards;
  label: string;
  explainer: string;
}[] = [
  {
    value: "exact",
    label: "Exact printings",
    explainer:
      "Uses cards you own only in the printing each line names, in any finish. The rest get the cheapest priced Edition.",
  },
  {
    value: "owned",
    label: "Use cards I own",
    explainer:
      "Also uses cards you own in other printings of the same card. The rest get the cheapest priced Edition.",
  },
];

export const DEFAULT_OWNED_CARDS: OwnedCards = "owned";

/** Where this browser keeps the choice. Like the other display preferences it stays on the device; it isn't per
 * account, because the review shows what each choice does before anything is saved. */
export const OWNED_CARDS_KEY = "prizecheck:import:owned-cards:v1";

/** A stored value, or the default (Use cards I own) when nothing valid is stored. */
export const parseOwnedCards = (raw: string | null): OwnedCards =>
  raw === "exact" || raw === "owned" ? raw : DEFAULT_OWNED_CARDS;

function readOwnedCards(): OwnedCards {
  try {
    return parseOwnedCards(window.localStorage.getItem(OWNED_CARDS_KEY));
  } catch {
    return DEFAULT_OWNED_CARDS;
  }
}

/** The owned-cards setting, read before the first review is posted and written back on every change. When storage
 * is unavailable (private mode, quota) the choice lasts only for this visit. */
export function useOwnedCards() {
  const [owned, setOwned] = useState<OwnedCards>(readOwnedCards);
  useEffect(() => {
    try {
      window.localStorage.setItem(OWNED_CARDS_KEY, owned);
    } catch {
      /* The choice stays in memory for this visit. */
    }
  }, [owned]);
  return [owned, setOwned] as const;
}
