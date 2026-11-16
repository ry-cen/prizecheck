import type { Edition } from "../catalog";
import type { FixtureStore } from "./collectionFixtures";

type Header = {
  revision: number;
  lines: { edition: Edition; quantity: number }[];
};
const lists = new WeakMap<FixtureStore, Map<string, Header>>();
/** Deck metadata belongs to the same owner-scoped store without making inventory snapshots non-cloneable. */
export function deckListHeaders(store: FixtureStore): Map<string, Header> {
  let headers = lists.get(store);
  if (!headers) {
    headers = new Map<string, Header>();
    lists.set(store, headers);
  }
  return headers;
}
type Arrival = { locationId: string; edition: Edition; added: number };
type CapturedArrival = Arrival & { before: number | null };
/** Capture before the Holding statement: one destination key can receive several sources. */
export function captureDeckArrivals(
  store: FixtureStore,
  changes: Arrival[]
): CapturedArrival[] {
  const headers = lists.get(store);
  if (!headers) return [];
  const grouped = new Map<string, CapturedArrival>();
  for (const change of changes) {
    if (!headers.has(change.locationId)) continue;
    const key = JSON.stringify([change.locationId, change.edition.id]);
    const existing = grouped.get(key);
    if (existing) existing.added += change.added;
    else
      grouped.set(key, {
        ...change,
        before:
          store.rows.find(
            (row) =>
              row.locationId === change.locationId &&
              row.edition.id === change.edition.id
          )?.quantity ?? null,
      });
  }
  return [...grouped.values()];
}
/** Mirror deck_list_cover/holding insert+update transition triggers (baseline.sql:1143,1218,2813).
 * Arrivals cover themselves, preserving existing surplus cuts; departures never shrink a list.
 * No Loans/Borrowed Copies or Put away's returns_as_surplus are present in this fixture.
 */
export function coverDeckArrivals(
  store: FixtureStore,
  arrivals: CapturedArrival[]
) {
  const headers = lists.get(store);
  if (!headers) return;
  // An upsert fires separate update and insert statement triggers; each advances growing Decks once.
  for (const inserted of [false, true]) {
    const changed = new Set<Header>();
    for (const arrival of arrivals) {
      if ((arrival.before === null) !== inserted) continue;
      const header = headers.get(arrival.locationId);
      if (!header) continue;
      const line = header.lines.find(
        (line) => line.edition.id === arrival.edition.id
      );
      const listed = line?.quantity ?? 0;
      const quantity = Math.max(
        listed,
        Math.min(listed, arrival.before ?? 0) + arrival.added
      );
      if (quantity <= listed) continue;
      if (line) line.quantity = quantity;
      else header.lines.push({ edition: arrival.edition, quantity });
      changed.add(header);
    }
    for (const header of changed) header.revision++;
  }
}
