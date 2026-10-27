import type { TreeLocation } from "../location_generated";
import { indexLocations, isFolder, type LocationIndex } from "./locationTree";

/** The deepest a Location may sit; the server enforces the same limit (LOCATION_DEPTH_LIMIT). */
export const MAX_LOCATION_DEPTH = 12;

/** A drop or picker target: a Location id, or null for Top level. */
export type ParentTarget = string | null;

/** Decks are renamed and moved through their own command (PATCH /api/decks/{id}), every other
 * Location through the Location edit. Both enforce the same rules. Decks can't be deleted here. */
export function isDeck(node: TreeLocation): boolean {
  return node.kind === "deck";
}

/** A Storage Leaf that holds cards. Nesting anything inside it converts it to a folder. */
export function isStockedLeaf(node: TreeLocation): boolean {
  return node.kind === "storage_leaf" && node.copy_count !== "0";
}

export function copiesLabel(count: string): string {
  return `${count} ${count === "1" ? "copy" : "copies"}`;
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The trimmed name, or null when it breaks the server's rule: 1–120 characters, no control characters. */
export function cleanLocationName(raw: string): string | null {
  const value = raw.trim();
  const length = [...value].length;
  if (length < 1 || length > 120) return null;
  for (const char of value) if (char.charCodeAt(0) < 32) return null;
  return value;
}

export type ManageModel = {
  index: LocationIndex;
  get: (id: string) => TreeLocation | undefined;
  /** Every id in the Location's subtree, itself first. */
  subtree: (id: string) => string[];
  /** Valid new parents, Top level (null) first, then the tree in preorder with natural sibling order.
   * Excludes the Location itself, its descendants, Decks, its current parent (Top level for a
   * top-level Location) and any parent that would put part of the subtree deeper than 12 levels. */
  validParents: (id: string) => ParentTarget[];
  /** "Folder", "Deck · 3 copies" or "3 copies". */
  kindLabel: (node: TreeLocation) => string;
  deletable: (node: TreeLocation) => boolean;
  /** Add child is offered on every non-Deck row that still has room for a child. */
  canAddChild: (node: TreeLocation) => boolean;
  /** True when a sibling under parentId already uses the name, ignoring case. The server is the authority. */
  siblingNameTaken: (
    name: string,
    parentId: string | null,
    exceptId?: string
  ) => boolean;
  /** The full path the Location would have under the target. */
  newPath: (id: string, target: ParentTarget) => string;
};

export function buildManageModel(nodes: TreeLocation[]): ManageModel {
  const index = indexLocations(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const get = (id: string) => byId.get(id);
  const subtree = (id: string): string[] => [
    id,
    ...index.children(id).flatMap((child) => subtree(child.id)),
  ];
  const validParents = (id: string): ParentTarget[] => {
    const moving = byId.get(id);
    if (!moving) return [];
    const branch = new Set(subtree(id));
    let height = 1;
    for (const nodeId of branch)
      height = Math.max(
        height,
        (byId.get(nodeId)?.depth ?? moving.depth) - moving.depth + 1
      );
    const currentParent =
      moving.parent_id && byId.has(moving.parent_id) ? moving.parent_id : null;
    const result: ParentTarget[] = currentParent === null ? [] : [null];
    const walk = (parentId: string | null) => {
      for (const child of index.children(parentId)) {
        const node = byId.get(child.id)!;
        if (branch.has(node.id)) continue;
        if (
          !isDeck(node) &&
          node.id !== currentParent &&
          node.depth + height <= MAX_LOCATION_DEPTH
        )
          result.push(node.id);
        walk(node.id);
      }
    };
    walk(null);
    return result;
  };
  const childCount = (id: string) => index.children(id).length;
  return {
    index,
    get,
    subtree,
    validParents,
    kindLabel: (node) =>
      isDeck(node)
        ? `Deck · ${copiesLabel(node.copy_count)}`
        : isFolder(node) || childCount(node.id) > 0
          ? "Folder"
          : copiesLabel(node.copy_count),
    deletable: (node) =>
      !isDeck(node) && childCount(node.id) === 0 && node.copy_count === "0",
    canAddChild: (node) => !isDeck(node) && node.depth < MAX_LOCATION_DEPTH,
    siblingNameTaken: (name, parentId, exceptId) =>
      index
        .children(parentId)
        .some(
          (node) =>
            node.id !== exceptId &&
            node.name.toLowerCase() === name.toLowerCase()
        ),
    newPath: (id, target) => {
      const name = byId.get(id)?.name ?? "Unknown location";
      return target ? `${index.path(target)} / ${name}` : name;
    },
  };
}

/** Codes that mean the panel's copy of the tree is out of date: the change was refused without
 * effect, so the panel reloads the tree and says so. */
export const STALE_CODES = new Set([
  "STALE_LOCATION",
  "LOCATION_NOT_FOUND",
  "DECK_NOT_FOUND",
  "STOCKED_LOCATION_REQUIRES_CONVERSION",
  "INVALID_LOCATION_CONVERSION",
  "LOCATION_CYCLE",
]);

export const STALE_MESSAGE =
  "Your locations changed in another tab or window, so nothing was changed. The list has been refreshed; review it and try again.";

/** Inline error text for a refused Location command. */
export function locationErrorMessage(
  code: string,
  context: {
    action: "rename" | "move" | "delete" | "add" | "hide" | "for_trade";
    name?: string;
    where?: string;
  }
): string {
  switch (code) {
    case "LOCATION_NAME_CONFLICT":
      if (context.action === "move")
        return `${context.where ?? "That parent"} already has a Location named ${context.name ?? "that"}.`;
      return "A sibling already has that name.";
    case "INVALID_LOCATION_NAME":
      return "Enter a name of 1 to 120 characters, without control characters.";
    case "LOCATION_DEPTH_LIMIT":
      return "Locations can be nested at most 12 levels deep.";
    case "DECK_CANNOT_HAVE_CHILDREN":
      return "A Deck can't contain Locations.";
    case "DECK_REQUIRES_DECK_COMMAND":
      return "Decks can't be deleted here.";
    case "LOCATION_NOT_EMPTY":
      return context.action === "delete"
        ? "Only an empty Location with no children can be deleted."
        : "The top-level Unsorted Location can only be renamed or moved once it is empty.";
    case "LOCATION_HIDDEN_BY_PARENT":
      return `This Location is inside ${context.where ?? "a hidden Location"}, so it stays hidden. Show that one to Friends first.`;
    case "DECK_NOT_FOR_TRADE":
      return "A Deck can't be marked For trade.";
    case "LOCATION_FOR_TRADE_BY_PARENT":
      return `${context.name ?? "This Location"} is For trade because ${context.where ?? "a Location above it"} is. Change it on ${context.where ?? "that Location"}.`;
    case "LOCATION_NAME_CONFIRMATION_MISMATCH":
      return `Type ${context.name ?? "the name"} exactly to confirm.`;
    default:
      return "This change couldn't be saved. Try again.";
  }
}
