import { plural, type LocationNode } from "./collection";
import { indexLocations } from "../../workspace/locationTree";
export const CHOOSE_LOCATION_PARENT = "__choose__";
// These describe only the read of the Locations, never what happened to a change or who made one.
export const LOCATION_REFRESHING_MESSAGE = "Refreshing the list…";
export const LOCATION_RELOAD_FAILED_MESSAGE =
  "The list couldn't be refreshed. Try Reload and retry.";
export const LOCATION_REVIEW_MESSAGE =
  "The list has been refreshed. Review it and try again.";
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
  /** What the collector reads. Two different Locations can show the same text. */
  value: string;
  /** What is compared: the ancestor chain of [id, name] pairs, or the value for a count. Never shown. */
  identity: string;
  /** Which kind of destination a parent fact states; a Location may be named "Not chosen" or "Top level". */
  choice?: "top" | "chosen" | "unchosen";
};
export type LocationFactChange = {
  key: LocationFact["key"];
  label: string;
  before: string;
  after: string;
  /** Plain words for a change the displayed text alone would hide. */
  note?: string;
};
/** The [id, name] pairs from the top level down to this Location, stopping if a cycle repeats one. */
function lineage(nodes: LocationNode[], id: string): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: [string, string][] = [];
  const seen = new Set<string>();
  for (
    let at = byId.get(id);
    at && !seen.has(at.id);
    at = at.parent_id ? byId.get(at.parent_id) : undefined
  ) {
    seen.add(at.id);
    chain.unshift([at.id, at.name]);
  }
  return JSON.stringify(chain);
}
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
      identity: JSON.stringify(
        !parentId
          ? ["top"]
          : parent
            ? ["chosen", lineage(tree, parent.id)]
            : ["unchosen"]
      ),
      choice: !parentId ? "top" : parent ? "chosen" : "unchosen",
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
        identity: plural(parent.copyCount ?? 0, "copy", "copies"),
      });
    return facts;
  }
  const target = tree.find((n) => n.id === id);
  if (!target) return [];
  facts.push({
    key: "path",
    label: "Location",
    value: where.path(target.id),
    identity: lineage(tree, target.id),
  });
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
      identity: plural(copies, "copy", "copies"),
    },
    {
      key: "inside",
      label: "Locations inside",
      value: String(inside),
      identity: String(inside),
    }
  );
  if (step === "move") parentFact("Moving to");
  return facts;
}
const describeChoice = (f: LocationFact) =>
  f.choice === "unchosen"
    ? "no parent chosen"
    : f.choice === "top"
      ? "Top level"
      : `the Location “${f.value}”`;
/** Why two facts that read the same differ, in words that need no ids. */
function sameTextNote(was: LocationFact, now: LocationFact): string {
  if (now.key !== "parent")
    return `The Location changed. Its displayed path is still ${now.value}.`;
  if (was.choice === now.choice)
    return `The parent Location changed. Its displayed path is still ${now.value}.`;
  if (now.choice === "unchosen")
    return `Previously selected “${was.value}”. Choose a parent Location.`;
  return `The parent changed from ${describeChoice(was)} to ${describeChoice(now)}.`;
}
/** What differs between two renderings of the same form. A fact missing on one side is compared by presence, never by its text. */
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
    if (!was && !now) return [];
    if (was && now && was.identity === now.identity) return [];
    return [
      {
        key,
        label: (now ?? was)!.label,
        before: was?.value ?? "none",
        after: now?.value ?? "none",
        ...((was?.value ?? "none") === (now?.value ?? "none")
          ? {
              note:
                was && now
                  ? sameTextNote(was, now)
                  : `The ${(now ?? was)!.label.toLowerCase()} changed.`,
            }
          : {}),
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
