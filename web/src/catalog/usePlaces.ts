import { useCallback, useEffect, useMemo, useState } from "react";
import { getLocationTree, type TreeLocation } from "../location_generated";
import { indexLocations, type LocationIndex } from "../workspace/locationTree";

export type Place = { id: string; label: string };

export type Places = {
  state: "loading" | "ready" | "failed";
  /** Storage Leaves in tree order, each named by its full path ("Shelf / Binder 2"): where Add N puts copies. */
  leaves: Place[];
  /** A Location's full path, or null when the tree doesn't know it. */
  path: (id: string) => string | null;
  reload: () => void;
};

function leavesInTreeOrder(index: LocationIndex): Place[] {
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
}

/**
 * The collector's Locations for the popup's Add rows, read from the Location tree (GET /api/location-tree) each time
 * the popup opens, so a Location made meanwhile is offered.
 */
export function usePlaces(open: boolean): Places {
  const [nodes, setNodes] = useState<TreeLocation[] | null>(null);
  const [state, setState] = useState<Places["state"]>("loading");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (!open) return;
    let live = true;
    getLocationTree()
      .then((tree) => {
        if (!live) return;
        setNodes(tree.locations);
        setState("ready");
      })
      .catch(() => {
        if (live) setState("failed");
      });
    return () => {
      live = false;
    };
  }, [open, generation]);
  const index = useMemo(() => indexLocations(nodes ?? []), [nodes]);
  const leaves = useMemo(() => leavesInTreeOrder(index), [index]);
  const path = useCallback(
    (id: string) => (index.byId.has(id) ? index.path(id) : null),
    [index]
  );
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { state, leaves, path, reload };
}
