import type { BrowseEdition } from "../catalog_browse_generated";
import { variantLabel } from "../ui/variantLabel";
import type { AddItem } from "./cardActions";
import { MAX_ADD, MAX_BATCH_EDITIONS } from "./catalogText";

/** One queued Card Edition: its gallery row as it was when queued (for the bar's names), and its copies to add. */
export type Queued = { edition: BrowseEdition; count: number };

/**
 * Add mode's queue (#175): Card Editions in the order they were first queued, each with 1–MAX_ADD copies. It lives
 * outside the gallery's rows, so a new search, a filter or a restart of the walk never empties it.
 */
export type AddQueue = ReadonlyMap<string, Queued>;

export const EMPTY_QUEUE: AddQueue = new Map();

/** The queue after one more (`by` 1) or one fewer (`by` -1) copy of `edition`. A count that reaches 0 leaves the
 * queue; a new Edition isn't taken once the queue holds MAX_BATCH_EDITIONS. */
export function bump(
  queue: AddQueue,
  edition: BrowseEdition,
  by: 1 | -1
): AddQueue {
  const current = queue.get(edition.edition_id);
  if (!current && (by < 0 || queue.size >= MAX_BATCH_EDITIONS)) return queue;
  const count = Math.min(MAX_ADD, (current?.count ?? 0) + by);
  const next = new Map(queue);
  if (count <= 0) next.delete(edition.edition_id);
  else
    next.set(edition.edition_id, {
      edition: current?.edition ?? edition,
      count,
    });
  return next;
}

export function without(queue: AddQueue, editionId: string): AddQueue {
  if (!queue.has(editionId)) return queue;
  const next = new Map(queue);
  next.delete(editionId);
  return next;
}

/** The queue less what a settled batch added: each Edition's count drops by its copies, and leaves at 0. */
export function minus(queue: AddQueue, items: readonly AddItem[]): AddQueue {
  const next = new Map(queue);
  for (const item of items) {
    const current = next.get(item.editionId);
    if (!current) continue;
    const count = current.count - item.quantity;
    if (count <= 0) next.delete(item.editionId);
    else next.set(item.editionId, { ...current, count });
  }
  return next;
}

export function totalCopies(queue: AddQueue): number {
  let total = 0;
  for (const queued of queue.values()) total += queued.count;
  return total;
}

/** The batch add's items, in queue order. */
export function queueItems(queue: AddQueue): AddItem[] {
  return Array.from(queue.values(), (queued) => ({
    editionId: queued.edition.edition_id,
    quantity: queued.count,
  }));
}

/** True when a new Edition can still be queued. */
export function hasRoom(queue: AddQueue): boolean {
  return queue.size < MAX_BATCH_EDITIONS;
}

/** A Card Edition in a few words: "Bulbasaur MEG 001 Reverse Holo". */
export function editionWords(edition: BrowseEdition): string {
  return `${edition.name} ${edition.set_code} ${edition.collector_number} ${variantLabel(edition.descriptor)}`;
}
