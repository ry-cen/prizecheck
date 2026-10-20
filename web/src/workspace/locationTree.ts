import type { TreeLocation, TreeNode } from "../location_generated";

/** Every Location tree (sidebar, drawer, Move explorer, Manage locations) sorts siblings with this order:
 * natural ("Binder 2" before "Binder 10") and case-insensitive. No order is stored. */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareLocationNames(a: TreeNode, b: TreeNode): number {
  return collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

/** Two Location names in the trees' sibling order, for lists that have names but no tree nodes (My Trade List). */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

/** A folder is an Organizational Location. Storage Leaves and Decks are leaves and can be opened. */
export function isFolder(node: TreeNode): boolean {
  return node.kind === "organization";
}

/** Whether Friends can see a Location (social network #249): visible, hidden by the collector ("own"), or hidden
 * because a Location above it is ("parent", naming the nearest one the collector hid). A hidden parent wins over the
 * Location's own choice, since the Location can't be shown on its own. Read from the tree read's `hidden` and
 * `hidden_by`; nodes from any other read are visible. */
export type Hiding =
  { kind: "visible" } | { kind: "own" } | { kind: "parent"; by: TreeNode };

/** Whether a Location's cards are offered for trade (Trading #267): not, marked For trade by the collector ("own"),
 * or For trade because a Location above it is ("parent", naming the nearest marked one). A marked parent wins over the
 * Location's own mark, since the Location can't be un-marked on its own. A Deck is never For trade. Read from the
 * tree read's `for_trade` and `for_trade_by`; nodes from any other read are not For trade. */
export type ForTrade =
  { kind: "none" } | { kind: "own" } | { kind: "parent"; by: TreeNode };

export type LocationIndex = {
  byId: Map<string, TreeNode>;
  /** Sorted children; pass null for the top level. */
  children: (parentId: string | null) => TreeNode[];
  /** Full path such as "Storage / Binders / Binder 2". */
  path: (id: string) => string;
  /** Ids of every ancestor, nearest first. */
  ancestors: (id: string) => string[];
  hiding: (id: string) => Hiding;
  forTrade: (id: string) => ForTrade;
};

export function indexLocations(nodes: TreeNode[]): LocationIndex {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const grouped = new Map<string | null, TreeNode[]>();
  for (const node of nodes) {
    const parent =
      node.parent_id && byId.has(node.parent_id) ? node.parent_id : null;
    const siblings = grouped.get(parent);
    if (siblings) siblings.push(node);
    else grouped.set(parent, [node]);
  }
  for (const siblings of grouped.values()) siblings.sort(compareLocationNames);
  const ancestors = (id: string): string[] => {
    const result: string[] = [];
    const seen = new Set<string>([id]);
    for (
      let parent = byId.get(id)?.parent_id ?? null;
      parent && byId.has(parent) && !seen.has(parent);
      parent = byId.get(parent)?.parent_id ?? null
    ) {
      seen.add(parent);
      result.push(parent);
    }
    return result;
  };
  return {
    byId,
    children: (parentId) => grouped.get(parentId) ?? [],
    path: (id) =>
      [...ancestors(id).reverse(), id]
        .map((nodeId) => byId.get(nodeId)?.name ?? "Unknown location")
        .join(" / "),
    ancestors,
    hiding: (id) => {
      const node = byId.get(id) as Partial<TreeLocation> | undefined;
      const by = node?.hidden_by ? byId.get(node.hidden_by) : undefined;
      if (by) return { kind: "parent", by };
      return node?.hidden === true ? { kind: "own" } : { kind: "visible" };
    },
    forTrade: (id) => {
      const node = byId.get(id) as Partial<TreeLocation> | undefined;
      if (!node || node.kind === "deck") return { kind: "none" };
      const by = node.for_trade_by ? byId.get(node.for_trade_by) : undefined;
      if (by) return { kind: "parent", by };
      return node.for_trade === true ? { kind: "own" } : { kind: "none" };
    },
  };
}

/** The words for a hidden Location, on the collector's own screens: "Hidden from Friends", or "Hidden because
 * <parent> is hidden". Empty for a visible one. */
export function hidingLabel(hiding: Hiding): string {
  if (hiding.kind === "own") return "Hidden from Friends";
  if (hiding.kind === "parent")
    return `Hidden because ${hiding.by.name} is hidden`;
  return "";
}

/** The words for a For trade Location, on the collector's own screens: "For trade", or "For trade because <parent> is.". Empty when its cards are not offered. */
export function forTradeLabel(forTrade: ForTrade): string {
  if (forTrade.kind === "own") return "For trade";
  if (forTrade.kind === "parent")
    return `For trade because ${forTrade.by.name} is.`;
  return "";
}

/** What a Location that is both hidden from Friends and For trade says on My Trade List
 * (Trading #269, the prototype's wording), so the collector knows its cards are still offered. */
export const HIDDEN_AND_FOR_TRADE =
  "Hidden from Friends · still on your Trade List";

/** The line a Location that is both hidden from Friends and For trade shows in Manage locations, where its caption
 * already says it is hidden (owner, 2026-10-20). Empty otherwise. */
export const STILL_ON_TRADE_LIST = "Still on your Trade List";
export function stillOfferedLine(hiding: Hiding, forTrade: ForTrade): string {
  return hiding.kind !== "visible" && forTrade.kind !== "none"
    ? STILL_ON_TRADE_LIST
    : "";
}
