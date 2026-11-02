import type { NeedGroup, TradeMatchCard } from "../social_generated";

/** The viewer's Deck need only, never the combined Trade Wants quantity. Group ids belong to this one response.
 * Even an exact match may share a widened need, so accepts_as never decides the wording. Missing groups say nothing. */
export function tradeDeckNeed(
  card: TradeMatchCard | undefined,
  groups: readonly NeedGroup[] | undefined
): string | null {
  if (!card || !groups || !card.need_groups?.length) return null;
  const need = Number(card.want_list_need);
  if (!Number.isSafeInteger(need) || need <= 0) return null;
  const referenced = card.need_groups.map((id) =>
    groups.find((group) => group.id === id)
  );
  if (referenced.some((group) => !group)) return null;
  const shared = referenced.some((group) => Number(group?.cards) > 1);
  return `Your Decks need ${need} ${card.name}${shared ? ", including need shared across printings." : "."}`;
}

/** Own-only fallback for an unlisted incoming card. Widening is shared need, never a per-printing instruction. */
export function ownTradeDeckNeed(
  row: { want_list_need: string; widened: boolean } | undefined
): string | null {
  const need = Number(row?.want_list_need);
  if (!Number.isSafeInteger(need) || need <= 0) return null;
  return `Your Decks need ${need}${row?.widened ? ", including need shared across accepted printings." : "."}`;
}
