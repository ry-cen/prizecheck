import { MoveError } from "../moves_generated";
import type { CollectionHoldingView } from "../collection_generated";
import { plural } from "./galleryModel";
import type { SelectedGroup } from "./selectionModel";

/** Manifest items per staging request (the API's MAX_BATCH). */
export const STAGE_BATCH = 500;

/** What a Move or Inventory Removal applies to: a destination Storage Leaf, or none for a Removal. */
export type ActionTarget =
  { kind: "move"; destinationId: string } | { kind: "remove" };

/** Display facts for one selected Holding, kept after the gallery reloads. */
export type CardLabel = {
  name: string;
  set: string;
  number: string;
  /** The source Location's full path, as the listing gave it. */
  path: string;
};

export const cardLabel = (holding: CollectionHoldingView): CardLabel => ({
  name: holding.printing_name,
  set: holding.set_name,
  number: holding.collector_number,
  path: holding.location_path,
});

/** "Pikachu (Base Set 25)" */
export const cardText = (label: CardLabel) =>
  `${label.name} (${label.set} ${label.number})`;

/** A decimal count string ("1", "25000") with its singular or plural noun. */
export function countText(decimal: string, one: string, many: string) {
  let value: bigint;
  try {
    value = BigInt(decimal);
  } catch {
    return `${decimal} ${many}`;
  }
  return `${value.toLocaleString("en-US")} ${value === 1n ? one : many}`;
}

/** The spec's MovePreview: copies that move, and copies already at the destination that stay. */
export function movePreview(groups: SelectedGroup[], destinationId: string) {
  let moving = 0;
  let alreadyThere = 0;
  for (const group of groups) {
    const copies = Number(group.quantity);
    if (group.source_id === destinationId) alreadyThere += copies;
    else moving += copies;
  }
  return { moving, alreadyThere };
}

/** "3 copies · 2 editions": the drag badge. */
export function carriedText(groups: SelectedGroup[]) {
  const copies = groups.reduce((sum, group) => sum + Number(group.quantity), 0);
  const editions = new Set(groups.map((group) => group.edition_id)).size;
  return `${plural(copies, "copy", "copies")} · ${plural(editions, "edition", "editions")}`;
}

/** One line of the Inventory Removal confirmation. */
export type RemovalRow = {
  key: string;
  quantity: number;
  card: string;
  locationId: string;
  path: string;
};

/** Removal rows grouped by source Location: Locations by path, then cards by name, natural order. */
export function groupRemovalRows(rows: RemovalRow[]) {
  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  const byLocation = new Map<string, { path: string; rows: RemovalRow[] }>();
  for (const row of rows) {
    const group = byLocation.get(row.locationId);
    if (group) group.rows.push(row);
    else byLocation.set(row.locationId, { path: row.path, rows: [row] });
  }
  const groups = Array.from(byLocation, ([locationId, group]) => ({
    locationId,
    ...group,
  }));
  groups.sort((a, b) => collator.compare(a.path, b.path));
  for (const group of groups)
    group.rows.sort((a, b) => collator.compare(a.card, b.card));
  return groups;
}

/** How a failed Move or Removal is reported and recovered. */
export type Failure = {
  /** Shown where the action ran (dialog or selection bar), next to the kept selection. */
  text: string;
  /** The same report without any word about the selection, for the toast when the refresh after
   * the failure leaves nothing selected. */
  toastText: string;
  /** Reload the gallery so the kept selection takes the current versions and quantities. */
  reloadGallery: boolean;
  reloadTree: boolean;
  /** The outcome is unknown (5xx or no response): a retry reuses the same manifest and key. */
  retrySame: boolean;
};

type Names = {
  /** A Location's full path, or a fallback when nothing knows it. */
  place: (locationId: string) => string;
  /** A selected Card Edition in one source, as "Name (Set Number)", or "a card". */
  card: (sourceId: string, editionId: string) => string;
};

/** The inline message for a failed Move or Inventory Removal. It always says nothing changed (or that
 * the outcome is unknown), keeps the selection, and names the affected Location when the API does. */
export function describeFailure(
  target: ActionTarget,
  error: unknown,
  names: Names
): Failure {
  const move = target.kind === "move";
  const noun = move ? "Move" : "Inventory Removal";
  const nothing = move ? "Nothing moved." : "Nothing was removed.";
  const kept = "Your selection is kept";
  const refreshed = `${kept} and the cards have been refreshed; review it and try again.`;
  const destination = move ? names.place(target.destinationId) : "";
  if (!(error instanceof MoveError) || error.status >= 500)
    return {
      text: `The ${noun} may not have finished. Try again to check safely; ${kept.toLowerCase()}.`,
      toastText: `The ${noun} may not have finished. Check your cards before trying again.`,
      reloadGallery: false,
      reloadTree: false,
      retrySame: true,
    };
  const { source_id: sourceId, edition_id: editionId } = error.detail;
  const card =
    sourceId && editionId ? names.card(sourceId, editionId) : "a card";
  const source = sourceId ? names.place(sourceId) : "A source Location";
  /** `lead` says what happened; `tail` adds the selection advice shown beside the kept selection. */
  const result = (
    lead: string,
    tail: string,
    reloadGallery = false,
    reloadTree = false
  ) => ({
    text: tail ? `${lead} ${tail}` : lead,
    toastText: reloadGallery ? `${lead} The cards have been refreshed.` : lead,
    reloadGallery,
    reloadTree,
    retrySame: false,
  });
  switch (error.code) {
    case "STALE_HOLDING":
      return result(
        `${card.charAt(0).toUpperCase()}${card.slice(1)} in ${source} changed since you selected it. ${nothing}`,
        refreshed,
        true
      );
    case "INSUFFICIENT_QUANTITY":
      return result(
        `${source} no longer has enough copies of ${card}. ${nothing}`,
        refreshed,
        true
      );
    case "QUANTITY_OVERFLOW":
      return result(
        `${destination} can't hold that many copies of ${card}. ${nothing}`,
        `${kept}.`
      );
    case "SAME_LOCATION":
      return result(
        `Every selected copy is already in ${destination}. ${nothing}`,
        ""
      );
    case "LOCATION_NOT_FOUND":
      if (error.detail.destination_id)
        // The destination went elsewhere, which moved the owner revision: refresh the cards too, so the tree and the gallery agree and no stale banner follows.
        return result(
          `${destination} can no longer hold cards. ${nothing}`,
          `Choose another destination; ${kept.toLowerCase()}.`,
          true,
          true
        );
      return result(
        `${source} can no longer hold cards. ${nothing}`,
        refreshed,
        true,
        true
      );
    case "MOVE_MANIFEST_EXPIRED":
    case "MOVE_MANIFEST_NOT_FOUND":
      return result(
        `This ${noun} took too long to prepare. ${nothing}`,
        `Try again; ${kept.toLowerCase()}.`
      );
    case "REPLAY_OUTCOME_UNAVAILABLE": {
      const replayUnavailable = `The ${noun} may have already finished, and the cards have been refreshed. Review them before trying again.`;
      return {
        text: replayUnavailable,
        toastText: replayUnavailable,
        reloadGallery: true,
        reloadTree: true,
        retrySame: false,
      };
    }
    default:
      return result(
        `The ${noun} couldn't be completed. ${nothing}`,
        refreshed,
        true
      );
  }
}

/** Drops the oldest entries (Map insertion order) until at most `limit` remain. */
export function trimOldest<K, V>(map: Map<K, V>, limit: number) {
  for (const key of map.keys()) {
    if (map.size <= limit) return;
    map.delete(key);
  }
}
