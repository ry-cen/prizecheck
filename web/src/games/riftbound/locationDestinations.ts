import type { LocationNode } from "./collection";
export const CHOOSE_LOCATION_PARENT = "__choose__";
export const LOCATION_RELOAD_FAILED_MESSAGE =
  "Your locations changed in another tab or window, so nothing was changed. The list couldn't be refreshed. Try Reload and retry.";
export const LOCATION_REVIEW_MESSAGE =
  "Your locations changed in another tab or window, so nothing was changed. The list has been refreshed; review it and try again.";
export function locationParents(
  nodes: LocationNode[],
  id: string | undefined,
  create: boolean
) {
  const node = nodes.find((n) => n.id === id);
  const branch = new Set(id ? [id] : []);
  let size = -1;
  while (size !== branch.size) {
    size = branch.size;
    for (const n of nodes)
      if (n.parent_id && branch.has(n.parent_id)) branch.add(n.id);
  }
  const height = node
    ? Math.max(
        ...nodes
          .filter((n) => branch.has(n.id))
          .map((n) => n.depth - node.depth + 1)
      )
    : 1;
  return nodes.filter(
    (n) =>
      n.kind !== "deck" &&
      !(n.name === "Unsorted" && n.parent_id === null) &&
      !branch.has(n.id) &&
      (create || n.id !== node?.parent_id) &&
      n.depth + height <= 12
  );
}
export function reviewedLocationParent(
  nodes: LocationNode[],
  id: string | undefined,
  create: boolean,
  parentId: string
): string {
  if (parentId === CHOOSE_LOCATION_PARENT) return parentId;
  if (!parentId)
    return create || nodes.find((n) => n.id === id)?.parent_id != null
      ? ""
      : CHOOSE_LOCATION_PARENT;
  const parent = locationParents(nodes, id, create).find(
    (n) => n.id === parentId
  );
  return parent &&
    (create || parent.kind !== "storage_leaf" || !(parent.copyCount ?? 0))
    ? parentId
    : CHOOSE_LOCATION_PARENT;
}
export function validLocationDestination(
  nodes: LocationNode[],
  id: string | undefined,
  create: boolean,
  parentId: string,
  conversion: boolean
): boolean {
  if (
    parentId === CHOOSE_LOCATION_PARENT ||
    reviewedLocationParent(nodes, id, create, parentId) !== parentId
  )
    return false;
  const parent = nodes.find((n) => n.id === parentId);
  return (
    !create ||
    parent?.kind !== "storage_leaf" ||
    !(parent.copyCount ?? 0) ||
    conversion
  );
}
