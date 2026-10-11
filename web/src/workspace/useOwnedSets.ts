import { useEffect, useRef, useState } from "react";
import { getCollectionSets, type CollectionSet } from "../collection_generated";
import type { WorkspaceView } from "./LocationNav";

/** The sets of the cards in the view, for the Set filter. Fetched once per view and owner revision
 * (the gallery's), so search, filter and sort changes don't refetch. The last list stays while a
 * new one loads, and if loading fails. */
export function useOwnedSets(
  view: WorkspaceView,
  ownerRevision: number | null
): CollectionSet[] {
  const [sets, setSets] = useState<CollectionSet[]>([]);
  // The newest request; an older answer is dropped. The gallery's revision is null while it
  // reloads, so a request is never cancelled just because a reload started.
  const requested = useRef("");
  useEffect(() => {
    if (ownerRevision === null) return;
    const key = `${view}:${ownerRevision}`;
    if (requested.current === key) return;
    requested.current = key;
    getCollectionSets(view === "all" ? undefined : view)
      .then((result) => {
        if (requested.current === key && Array.isArray(result.sets))
          setSets(result.sets);
      })
      .catch(() => {
        /* Keep the last list; the Set filter still offers All and its current value. */
      });
  }, [view, ownerRevision]);
  return sets;
}
