import { captureDeckArrivals, coverDeckArrivals } from "./deckListFixtures";
import type { TreeNode } from "../../../location_generated";
import type { CollectionReader, HoldingRow } from "../collection";
import { expandCopies, pageHoldings } from "../collection";
import { locationCommands } from "./locationCommands";
import { editions } from "./fixtures";
export type CollectionScenario =
  | "normal"
  | "empty"
  | "failure"
  | "slow"
  | "write-failure"
  | "write-slow"
  | "stale"
  | "location-failure"
  | "location-slow"
  | "location-stale";
export type FixtureStore = {
  locations: TreeNode[];
  rows: HoldingRow[];
  revision: number;
};
export type LocationFixtureChange =
  | { kind: "stock" | "delete"; id: string }
  | { kind: "cycle"; id: string; parentId: string };
const pendingLocationChanges = new Map<string, LocationFixtureChange>();
/** Test-only concurrent-edit hook, consumed immediately before the next Location command. */
export function queueLocationFixtureChange(
  owner: "a" | "b",
  change: LocationFixtureChange,
  scenario: CollectionScenario = "normal"
) {
  pendingLocationChanges.set(storeKey(owner, scenario), change);
}
const stores = new Map<string, FixtureStore>();
const storeKey = (owner: string, scenario: CollectionScenario) =>
  JSON.stringify([owner, scenario]);
export function collectionFixtureReader(
  owner: "a" | "b",
  scenario: CollectionScenario = "normal"
): CollectionReader {
  const node = (
    id: string,
    name: string,
    parent_id: string | null = null,
    kind = "storage_leaf"
  ) => ({
    id,
    name,
    parent_id,
    kind,
    version: 1,
    depth: parent_id ? 2 : 1,
    hidden: false,
    for_trade: false,
    lent_copies: "0",
    borrowed_copies: "0",
  });
  const locations: TreeNode[] = [
    node("1", "Unsorted"),
    ...(scenario === "empty"
      ? []
      : [
          node("2", "Binders", null, "organization"),
          node("3", "Blue binder", "2"),
          node("4", "Red binder", "2"),
          node("5", "Empty binder"),
        ]),
  ];
  const holding = (
    edition: HoldingRow["edition"],
    locationId: string,
    quantity: number
  ): HoldingRow => ({ edition, locationId, quantity, version: 1 });
  const initialRows =
    scenario === "empty"
      ? []
      : owner === "b"
        ? [holding({ ...editions[0], name: "Beacon Keeper" }, "1", 2)]
        : [
            holding(editions[0], "1", 3),
            holding(editions[0], "3", 2),
            holding(editions[1], "4", 2),
            holding(editions[3], "3", 1),
            holding(
              {
                ...editions[2],
                id: "retained",
                printingId: "retained-printing",
                name: "Forgotten Sentinel",
              },
              "4",
              1
            ),
            ...editions.slice(5).map((e) => holding(e, "3", 3)),
          ];
  const key = storeKey(owner, scenario);
  if (!stores.has(key))
    stores.set(key, { locations, rows: initialRows, revision: 1 });
  const store = stores.get(key)!;
  const failed = new Set<string>();
  async function read<T>(
    value: T,
    signal: AbortSignal,
    operation: string
  ): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        scenario === "slow" ? 900 : 120
      );
      function abort() {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    if (
      scenario === "failure" &&
      !failed.has(operation) &&
      operation !== "holdings"
    ) {
      failed.add(operation);
      throw new Error("Synthetic failure");
    }
    return structuredClone(value);
  }
  return {
    scope: "riftbound",
    owner,
    locations: (signal) =>
      read(
        store.locations.map((n) => ({
          ...n,
          copyCount: store.rows
            .filter((r) => r.locationId === n.id)
            .reduce((sum, r) => sum + r.quantity, 0),
        })),
        signal,
        "locations"
      ),
    holdings: (id, signal) =>
      read(
        store.rows.filter((r) => r.edition.id === id),
        signal,
        "holdings"
      ),
    list: (q, signal) => {
      const search = q.search.trim().toLowerCase();
      const matches = store.rows
        .filter(
          (r) =>
            (q.location === "all" || q.location === r.locationId) &&
            (!search ||
              r.edition.name.toLowerCase().includes(search) ||
              r.edition.number.toLowerCase().includes(search))
        )
        .sort(
          (a, b) =>
            a.edition.name.localeCompare(b.edition.name) ||
            a.edition.set.code.localeCompare(b.edition.set.code) ||
            a.edition.number.localeCompare(b.edition.number) ||
            a.edition.id.localeCompare(b.edition.id)
        );
      const copies = expandCopies(matches);
      return read(
        {
          rows: pageHoldings(matches, q.page),
          totals: {
            copies: copies.length,
            editions: new Set(matches.map((r) => r.edition.id)).size,
          },
          pages: Math.max(1, Math.ceil(copies.length / 24)),
          collectionEmpty: store.rows.length === 0,
        },
        signal,
        "list"
      );
    },
  };
}

/** Local fixture inspection seam for tests; never installed on window or persisted. */
export function collectionFixtureStore(
  owner: "a" | "b",
  scenario: CollectionScenario = "normal"
) {
  if (!stores.has(storeKey(owner, scenario)))
    collectionFixtureReader(owner, scenario);
  return stores.get(storeKey(owner, scenario))!;
}
export function resetCollectionFixtures() {
  stores.clear();
  pendingLocationChanges.clear();
  writers.clear();
}

import {
  CollectionError,
  type CollectionWriter,
  type SelectionItem,
  type UndoRecord,
} from "../collection";
const writers = new Map<string, CollectionWriter>();
const CORE_MAX = 2n ** 63n - 1n;
/** The clock is explicit so expiry tests need no wall-clock waiting. */
export function collectionFixtureWriter(
  owner: "a" | "b",
  scenario: CollectionScenario = "normal",
  clock: () => number = Date.now
): CollectionWriter {
  const key = storeKey(owner, scenario);
  const existing = writers.get(key);
  if (existing) return existing;
  const store = collectionFixtureStore(owner, scenario);
  type Entry = {
    record: UndoRecord;
    items: SelectionItem[];
    destinationId: string | null;
    editions: HoldingRow["edition"][];
  };
  let records: Entry[] = [];
  const replay = new Map<string, { payload: string; result: unknown }>();
  let failed = false;
  let stale = false;
  const row = (location: string, edition: string) =>
    store.rows.find(
      (r) => r.locationId === location && r.edition.id === edition
    );
  const leaf = (id: string) =>
    store.locations.some(
      (n) => n.id === id && (n.kind === "storage_leaf" || n.kind === "deck")
    ) && !store.locations.some((n) => n.parent_id === id);
  function change(
    locationId: string,
    edition: HoldingRow["edition"],
    delta: number
  ) {
    const current = row(locationId, edition.id);
    const quantity = (current?.quantity ?? 0) + delta;
    if (!quantity) store.rows = store.rows.filter((r) => r !== current);
    else if (current) {
      current.quantity = quantity;
      current.version = store.revision;
    } else
      store.rows.push({
        locationId,
        edition,
        quantity,
        version: store.revision,
      });
  }
  async function command<T>(
    action: string,
    input: unknown,
    options: { signal: AbortSignal; idempotencyKey?: string },
    apply: () => T
  ): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(
        () => {
          options.signal.removeEventListener("abort", abort);
          resolve();
        },
        scenario === "write-slow" ||
          (scenario === "location-slow" && action.endsWith("Location"))
          ? 1600
          : 120
      );
      if (options.signal.aborted) abort();
      else options.signal.addEventListener("abort", abort, { once: true });
    });
    if (action === "undoList" || action === "dismissUndo")
      return structuredClone(apply());
    const payload = JSON.stringify([action, input], (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          )
        : value
    );
    const requestKey = options.idempotencyKey;
    if (!requestKey) throw new Error("Idempotency key required");
    const previous = replay.get(requestKey);
    if (previous) {
      if (previous.payload !== payload)
        throw new CollectionError("IDEMPOTENCY_KEY_REUSED");
      return structuredClone(previous.result) as T;
    }
    if (
      (scenario === "write-failure" ||
        (scenario === "location-failure" && action.endsWith("Location"))) &&
      !failed
    ) {
      failed = true;
      throw new Error("Synthetic write failure");
    }
    if (
      scenario === "stale" &&
      !stale &&
      (action === "move" || action === "remove")
    ) {
      stale = true;
      throw new CollectionError("STALE_HOLDING");
    }
    if (scenario === "location-stale" && !stale && action === "editLocation") {
      stale = true;
      const edit = input as { id: string; parentId?: string | null };
      const target = store.locations.find(
        (n) => n.id === (edit.parentId ?? edit.id)
      );
      if (target) target.version++;
      throw new CollectionError("STALE_LOCATION");
    }
    const concurrent = action.endsWith("Location")
      ? pendingLocationChanges.get(key)
      : undefined;
    if (concurrent) {
      pendingLocationChanges.delete(key);
      if (concurrent.kind === "stock")
        store.rows.push({
          edition: editions[0],
          locationId: concurrent.id,
          quantity: 1,
          version: store.revision,
        });
      else if (concurrent.kind === "cycle") {
        const node = store.locations.find((n) => n.id === concurrent.id)!;
        node.parent_id = concurrent.parentId;
        store.locations.find((n) => n.id === concurrent.parentId)!.kind =
          "organization";
        for (const descendant of store.locations) {
          let above = descendant.parent_id;
          descendant.depth = 1;
          while (above) {
            descendant.depth++;
            above = store.locations.find((n) => n.id === above)!.parent_id;
          }
        }
      } else {
        const removed = new Set([concurrent.id]);
        let count = -1;
        while (count !== removed.size) {
          count = removed.size;
          for (const node of store.locations)
            if (node.parent_id && removed.has(node.parent_id))
              removed.add(node.id);
        }
        store.locations = store.locations.filter((n) => !removed.has(n.id));
        store.rows = store.rows.filter((r) => !removed.has(r.locationId));
      }
    }
    const result = apply();
    replay.set(requestKey, {
      payload,
      result: structuredClone(result),
    });
    return result;
  }
  function select(items: SelectionItem[], destinationId: string | null) {
    if (
      !items.length ||
      new Set(items.map((i) => JSON.stringify([i.sourceId, i.editionId])))
        .size !== items.length
    )
      throw new Error("Invalid selection");
    if (items.some((i) => i.sourceId === destinationId))
      throw new CollectionError("SAME_LOCATION");
    if (destinationId && !leaf(destinationId))
      throw new Error("Choose a storage leaf");
    for (const i of items) {
      if (
        !Number.isSafeInteger(i.quantity) ||
        i.quantity < 1 ||
        !leaf(i.sourceId)
      )
        throw new Error("Invalid selection");
      const holding = row(i.sourceId, i.editionId);
      if (!holding || holding.version !== i.expectedVersion)
        throw new CollectionError("STALE_HOLDING");
      if (holding.quantity < i.quantity)
        throw new CollectionError("INSUFFICIENT_QUANTITY");
    }
    const arrivals = new Map<string, number>();
    for (const i of items)
      arrivals.set(i.editionId, (arrivals.get(i.editionId) ?? 0) + i.quantity);
    if (destinationId)
      for (const [id, quantity] of arrivals) {
        if (
          BigInt(row(destinationId, id)?.quantity ?? 0) + BigInt(quantity) >
          CORE_MAX
        )
          throw new Error("Quantity overflow");
      }
  }
  const writer: CollectionWriter = {
    ...locationCommands(store, command),
    owner,
    add: (input, options) =>
      command("add", input, options, () => {
        const edition = editions.find((e) => e.id === input.editionId);
        if (
          !edition ||
          !leaf(input.locationId) ||
          !Number.isSafeInteger(input.quantity) ||
          input.quantity < 1
        )
          throw new Error("Invalid Add");
        if (
          BigInt(row(input.locationId, edition.id)?.quantity ?? 0) +
            BigInt(input.quantity) >
          CORE_MAX
        )
          throw new Error("Quantity overflow");
        const arrivals = captureDeckArrivals(store, [
          { locationId: input.locationId, edition, added: input.quantity },
        ]);
        store.revision++;
        change(input.locationId, edition, input.quantity);
        coverDeckArrivals(store, arrivals);
        return {
          ...input,
          quantity: row(input.locationId, edition.id)!.quantity,
          version: store.revision,
          ownerRevision: store.revision,
        };
      }),
    move: (input, options) =>
      command("move", input, options, () =>
        applySelection(
          "move",
          input.items,
          input.destinationId,
          options.idempotencyKey
        )
      ),
    remove: (input, options) =>
      command("remove", input, options, () =>
        applySelection("remove", input.items, null, options.idempotencyKey)
      ),
    undoList: (options) =>
      command("undoList", null, options, () =>
        records
          .filter((e) => Date.parse(e.record.expiresAt) > clock())
          .slice(0, 5)
          .map((e) => e.record)
      ),
    dismissUndo: (id, options) =>
      command("dismissUndo", id, options, () => {
        if (!records.some((e) => e.record.id === id))
          throw new CollectionError("UNDO_NOT_FOUND");
        records = records.filter((e) => e.record.id !== id);
        // Core dismissal does not mutate Holdings or bump the inventory revision.
        return { ownerRevision: store.revision };
      }),
    undo: (id, options) =>
      command("undo", id, options, () => {
        const entry = records.find((e) => e.record.id === id);
        if (!entry) throw new CollectionError("UNDO_NOT_FOUND");
        if (Date.parse(entry.record.expiresAt) <= clock())
          throw new CollectionError("UNDO_EXPIRED");
        if (
          records.find((e) => Date.parse(e.record.expiresAt) > clock()) !==
          entry
        )
          throw new CollectionError("UNDO_NOT_NEWEST");
        for (const i of entry.items) {
          if (
            !leaf(i.sourceId) ||
            (entry.destinationId && !leaf(entry.destinationId)) ||
            BigInt(row(i.sourceId, i.editionId)?.quantity ?? 0) +
              BigInt(i.quantity) >
              CORE_MAX
          )
            throw new CollectionError("UNDO_INCOMPATIBLE");
        }
        const departures = new Map<string, number>();
        for (const i of entry.items)
          departures.set(
            i.editionId,
            (departures.get(i.editionId) ?? 0) + i.quantity
          );
        if (entry.destinationId)
          for (const [editionId, quantity] of departures) {
            if ((row(entry.destinationId, editionId)?.quantity ?? 0) < quantity)
              throw new CollectionError("UNDO_INCOMPATIBLE");
          }
        const arrivals = captureDeckArrivals(
          store,
          entry.items.map((item, index) => ({
            locationId: item.sourceId,
            edition: entry.editions[index],
            added: item.quantity,
          }))
        );
        store.revision++;
        entry.items.forEach((i, n) => {
          if (entry.destinationId)
            change(entry.destinationId, entry.editions[n], -i.quantity);
          change(i.sourceId, entry.editions[n], i.quantity);
        });
        coverDeckArrivals(store, arrivals);
        records = records.filter(
          (e) => e !== entry && Date.parse(e.record.expiresAt) > clock()
        );
        return { ownerRevision: store.revision };
      }),
  };
  function applySelection(
    action: "move" | "remove",
    items: SelectionItem[],
    destinationId: string | null,
    id: string
  ) {
    if (
      destinationId &&
      items.length &&
      items.every((i) => i.sourceId === destinationId)
    )
      throw new CollectionError("SAME_LOCATION");
    items = items.filter((i) => i.sourceId !== destinationId);
    select(items, destinationId);
    const snapshots = items.map((i) => row(i.sourceId, i.editionId)!.edition);
    const arrivals = captureDeckArrivals(
      store,
      destinationId
        ? items.map((item, index) => ({
            locationId: destinationId,
            edition: snapshots[index],
            added: item.quantity,
          }))
        : []
    );
    store.revision++;
    items.forEach((i, n) => {
      change(i.sourceId, snapshots[n], -i.quantity);
      if (destinationId) change(destinationId, snapshots[n], i.quantity);
    });
    coverDeckArrivals(store, arrivals);
    const undo = {
      id: JSON.stringify([owner, id]),
      action,
      expiresAt: new Date(clock() + 600_000).toISOString(),
    };
    records = [
      {
        record: undo,
        items: structuredClone(items),
        destinationId,
        editions: snapshots,
      },
      ...records.filter((e) => Date.parse(e.record.expiresAt) > clock()),
    ].slice(0, 5);
    return { ownerRevision: store.revision, undo };
  }
  writers.set(key, writer);
  return writer;
}
