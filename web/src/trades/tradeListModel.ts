import type { FriendTradeCard } from "../social_generated";
import type {
  OwnTradeList,
  TradeListCard,
  TradeListLocation,
} from "../trades_generated";
import type { SegmentedOption } from "../ui/Segmented";
import { FRIENDS_PATH } from "../social/friendCards";
import { compareNames } from "../workspace/locationTree";

/** The Trades tab's views (Trading #269, #270 and #276, prototype verdict variant A: `Trades · Find trades · My Trade
 * List`): the Trades list (/trades), Find trades (/trades/find) and My Trade List (/trades/list). */
export type TradesTabView = "trades" | "find" | "list";

export const TRADES_VIEWS: readonly SegmentedOption<TradesTabView>[] = [
  { value: "trades", label: "Trades" },
  { value: "find", label: "Find trades" },
  { value: "list", label: "My Trade List" },
];

/** The Trades list's address: the Trades tab itself. */
export const TRADES_PATH = "/trades";

/** Find trades' address (#276): Friends who have cards you want, or want cards you have. */
export const TRADE_FIND_PATH = "/trades/find";

/** My Trade List's address. */
export const TRADE_LIST_PATH = "/trades/list";

/** The Trade Proposal draft's address (#270). */
export const TRADE_DRAFT_PATH = "/trades/draft";

/** The address of one of the Trades tab's views. */
export function tradesViewPath(view: TradesTabView): string {
  switch (view) {
    case "trades":
      return TRADES_PATH;
    case "find":
      return TRADE_FIND_PATH;
    case "list":
      return TRADE_LIST_PATH;
  }
}

/** One Trade's address (#270): /trades/<Trade id>. */
export function tradePath(id: string): string {
  return `${TRADES_PATH}/${encodeURIComponent(id)}`;
}

/** What the Trades tab shows for its address's section (``sectionAt``): a view, the draft, or one Trade by id. */
export type TradesRoute =
  | { kind: "view"; view: TradesTabView }
  | { kind: "draft" }
  | { kind: "trade"; id: string }
  | { kind: "missing" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tradesRoute(section: string | null): TradesRoute {
  if (section === null) return { kind: "view", view: "trades" };
  if (section === "find") return { kind: "view", view: "find" };
  if (section === "list") return { kind: "view", view: "list" };
  if (section === "draft") return { kind: "draft" };
  let id = section;
  try {
    id = decodeURIComponent(section);
  } catch {
    // Left as written: it is not a Trade id.
  }
  return UUID.test(id) ? { kind: "trade", id } : { kind: "missing" };
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
