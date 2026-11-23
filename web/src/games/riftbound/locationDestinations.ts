import { plural, type LocationNode } from "./collection";
import { indexLocations } from "../../workspace/locationTree";
export const CHOOSE_LOCATION_PARENT = "__choose__";
export const LOCATION_RELOAD_FAILED_MESSAGE =
  "Your locations changed in another tab or window, so nothing was changed. The list couldn't be refreshed. Try Reload and retry.";
export const LOCATION_REVIEW_MESSAGE =
  "Your locations changed in another tab or window, so nothing was changed. The list has been refreshed; review it and try again.";
/** A Location and everything inside it, found without following a cycle twice. */
export function locationBranch(
  nodes: LocationNode[],
  id: string | undefined
): Set<string> {
  const branch = new Set(id ? [id] : []);
  let size = -1;
  while (size !== branch.size) {
    size = branch.size;
    for (const n of nodes)
      if (n.parent_id && branch.has(n.parent_id)) branch.add(n.id);
  }
  return branch;
}
export type LocationStep = "create" | "rename" | "move" | "delete";
export type LocationFact = {
  key: "path" | "copies" | "inside" | "parent" | "stock";
  label: string;
  value: string;
};
export type LocationFactChange = {
  key: LocationFact["key"];
  label: string;
  before: string;
  after: string;
};
/** Every fact the write form states about the Location and its destination, in the order it shows them. */
export function locationFacts(
  step: LocationStep,
  tree: LocationNode[],
  id: string | undefined,
  parentId: string
): LocationFact[] {
  const where = indexLocations(tree);
  const facts: LocationFact[] = [];
  const parentFact = (label: string) => {
    const parent =
      parentId === CHOOSE_LOCATION_PARENT
        ? undefined
        : tree.find((n) => n.id === parentId);
    facts.push({
      key: "parent",
      label,
      value: !parentId
        ? "Top level"
        : parent
          ? where.path(parent.id)
          : "Not chosen",
    });
    return parent;
  };
  if (step === "create") {
    const parent = parentFact("Adding to");
    if (parent?.kind === "storage_leaf" && (parent.copyCount ?? 0) > 0)
      facts.push({
        key: "stock",
        label: "Copies to move",
        value: plural(parent.copyCount ?? 0, "copy", "copies"),
      });
    return facts;
  }
  const target = tree.find((n) => n.id === id);
  if (!target) return [];
  facts.push({ key: "path", label: "Location", value: where.path(target.id) });
  if (step === "rename") return facts;
  const branch = locationBranch(tree, target.id);
  const copies = tree
    .filter((n) => branch.has(n.id))
    .reduce((total, n) => total + (n.copyCount ?? 0), 0);
  const inside = branch.size - 1;
  facts.push(
    {
      key: "copies",
      label: inside ? "Copies, including Locations inside" : "Copies",
      value: plural(copies, "copy", "copies"),
    },
    { key: "inside", label: "Locations inside", value: String(inside) }
  );
  if (step === "move") parentFact("Moving to");
  return facts;
}
/** What differs between two renderings of the same form; a fact missing on one side reads as "none". */
export function changedLocationFacts(
  before: LocationFact[],
  after: LocationFact[]
): LocationFactChange[] {
  const keys = [
    ...new Set([...after.map((f) => f.key), ...before.map((f) => f.key)]),
  ];
  return keys.flatMap((key) => {
    const was = before.find((f) => f.key === key);
    const now = after.find((f) => f.key === key);
    return (was?.value ?? "none") === (now?.value ?? "none")
      ? []
      : [
          {
            key,
            label: (now ?? was)!.label,
            before: was?.value ?? "none",
            after: now?.value ?? "none",
          },
        ];
  });
}
export function locationParents(
  nodes: LocationNode[],
  id: string | undefined,
  create: boolean
) {
  const node = nodes.find((n) => n.id === id);
  const branch = locationBranch(nodes, id);
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
