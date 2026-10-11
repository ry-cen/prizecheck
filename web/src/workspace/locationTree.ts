import type { TreeNode } from "../location_generated";

/** Every Location tree (sidebar, drawer, Move explorer, Manage locations) sorts siblings with this order:
 * natural ("Binder 2" before "Binder 10") and case-insensitive. No order is stored. */
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function compareLocationNames(a: TreeNode, b: TreeNode): number {
  return collator.compare(a.name, b.name) || a.id.localeCompare(b.id);
}

/** A folder is an Organizational Location. Storage Leaves and Decks are leaves and can be opened. */
export function isFolder(node: TreeNode): boolean {
  return node.kind === "organization";
}

export type LocationIndex = {
  byId: Map<string, TreeNode>;
  /** Sorted children; pass null for the top level. */
  children: (parentId: string | null) => TreeNode[];
  /** Full path such as "Storage / Binders / Binder 2". */
  path: (id: string) => string;
  /** Ids of every ancestor, nearest first. */
  ancestors: (id: string) => string[];
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
  };
}
