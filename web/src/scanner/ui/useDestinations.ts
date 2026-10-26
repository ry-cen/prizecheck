import { useCallback, useEffect, useMemo, useState } from "react";
import { getLocationTree, type TreeLocation } from "../../location_generated";
import { indexLocations } from "../../workspace/locationTree";

export type Place = { id: string; label: string };

export type Destinations = {
  state: "loading" | "ready" | "failed";
  /** Storage Leaves in tree order, each by its full path. Decks are not offered. */
  leaves: Place[];
  /** The root Unsorted leaf (where an unchosen destination goes). */
  unsortedId: string | null;
  path: (id: string) => string | null;
  reload: () => void;
};

/** The collector's Storage Leaves from the Location tree, for Put cards in. */
export function useDestinations(): Destinations {
  const [nodes, setNodes] = useState<TreeLocation[] | null>(null);
  const [state, setState] = useState<Destinations["state"]>("loading");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    getLocationTree()
      .then((tree) => {
        if (!live) return;
        setNodes(tree.locations);
        setState("ready");
      })
      .catch(() => live && setState("failed"));
    return () => {
      live = false;
    };
  }, [generation]);
  const index = useMemo(() => indexLocations(nodes ?? []), [nodes]);
  const leaves = useMemo(() => {
    const found: Place[] = [];
    const walk = (parent: string | null) => {
      for (const node of index.children(parent)) {
        if (node.kind === "storage_leaf")
          found.push({ id: node.id, label: index.path(node.id) });
        else if (node.kind === "organization") walk(node.id);
      }
    };
    walk(null);
    return found;
  }, [index]);
  const unsortedId = useMemo(
    () =>
      (nodes ?? []).find(
        (n) =>
          n.kind === "storage_leaf" &&
          n.parent_id === null &&
          n.name === "Unsorted"
      )?.id ??
      leaves[0]?.id ??
      null,
    [nodes, leaves]
  );
  const path = useCallback(
    (id: string) => (index.byId.has(id) ? index.path(id) : null),
    [index]
  );
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  // A failed read is read again when the connection returns.
  useEffect(() => {
    if (state !== "failed") return;
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, [state, reload]);
  return { state, leaves, unsortedId, path, reload };
}
