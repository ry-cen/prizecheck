import type { FriendTradeCard } from "../social_generated";
import type {
  OwnTradeList,
  TradeListCard,
  TradeListLocation,
} from "../trades_generated";
import type { SegmentedOption } from "../ui/Segmented";
import { FRIENDS_PATH } from "../social/friendCards";
import { compareNames } from "../workspace/locationTree";

/** The Trades tab's views (Trading #269, prototype verdict variant A: `Trades · Find trades · My Trade List`). My
 * Trade List is the first to exist; the Trades list (/trades) and Find trades (/trades/find) join it in later
 * tickets, in that order before it. */
export type TradesView = "list";

export const TRADES_VIEWS: readonly SegmentedOption<TradesView>[] = [
  { value: "list", label: "My Trade List" },
];

/** My Trade List's address. */
export const TRADE_LIST_PATH = "/trades/list";

/** The address of one of the Trades tab's views. */
export function tradesViewPath(view: TradesView): string {
  switch (view) {
    case "list":
      return TRADE_LIST_PATH;
  }
}

/** A Friend's Trade List (Trading #269): /friends/<Handle>/trade-list, beside their Collection at /friends/<Handle>. */
export function friendTradeListPath(handle: string): string {
  return `${FRIENDS_PATH}/${encodeURIComponent(handle)}/trade-list`;
}

/** The Handle a Friend's Trade List address names, or null for any other address. */
export function friendTradeListHandleAt(path: string): string | null {
  const match = new RegExp(`^${FRIENDS_PATH}/([^/]+)/trade-list$`).exec(path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** One panel of My Trade List: one of the collector's own Locations, with the cards on offer from it. */
export type TradeListPanel = {
  location: TradeListLocation;
  /** The Location's path, as the Location tree writes it ("Storage / Binder 2"). */
  title: string;
  /** In card order, each with the copies on offer from this Location. */
  cards: { card: TradeListCard; copies: string }[];
};

/** Compares two Location paths in tree order: parents before children, siblings as the Location tree sorts them. */
export function comparePaths(a: readonly string[], b: readonly string[]) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const order = compareNames(a[index], b[index]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

/** My Trade List's panels: one per Location a card sits in, in tree order, each with its cards in card order. */
export function tradeListPanels(list: OwnTradeList): TradeListPanel[] {
  const locations = [...list.locations].sort(
    (a, b) => comparePaths(a.path, b.path) || a.id.localeCompare(b.id)
  );
  return locations
    .map((location) => ({
      location,
      title: location.path.join(" / "),
      cards: list.cards.flatMap((card) =>
        card.places
          .filter((place) => place.location_id === location.id)
          .map((place) => ({ card, copies: place.copies }))
      ),
    }))
    .filter((panel) => panel.cards.length > 0);
}

/** A Friend's Trade List grouped by card name, as the prototype groups it: the names in the order the cards come
 * (card order), each with its Editions. */
export function groupByName(
  cards: readonly FriendTradeCard[]
): { name: string; cards: FriendTradeCard[] }[] {
  const groups = new Map<string, { name: string; cards: FriendTradeCard[] }>();
  for (const card of cards) {
    const group = groups.get(card.name);
    if (group) group.cards.push(card);
    else groups.set(card.name, { name: card.name, cards: [card] });
  }
  return [...groups.values()];
}
