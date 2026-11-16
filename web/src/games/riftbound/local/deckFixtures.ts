import type { Edition } from "../catalog";
import { CollectionError, type WriteOptions } from "../collection";
import {
  DeckError,
  ownership,
  type DeckDetail,
  type DeckReader,
  type DeckWriter,
} from "../decks";
import {
  collectionFixtureStore,
  type CollectionScenario,
  type FixtureStore,
} from "./collectionFixtures";
import { editions } from "./fixtures";
import { cleanLocationName } from "./locationCommands";
import { casefold } from "./locationNames";
export type DeckScenario =
  "normal" | "decks-empty" | "decks-failure" | "decks-slow" | "deck-stale";
type Header = {
  revision: number;
  lines: { edition: Edition; quantity: number }[];
};
const fixtures = new WeakMap<
  FixtureStore,
  Map<string, DeckReader & DeckWriter>
>();
export function deckFixture(
  owner: "a" | "b",
  scenario: DeckScenario = "normal",
  collectionScenario: CollectionScenario = "normal"
): DeckReader & DeckWriter {
  const store = collectionFixtureStore(owner, collectionScenario);
  let variants = fixtures.get(store);
  if (!variants) {
    variants = new Map();
    fixtures.set(store, variants);
  }
  const existing = variants.get(scenario);
  if (existing) return existing;
  const headers = new Map<string, Header>();
  if (scenario !== "decks-empty") {
    const deck = {
      id: "deck-1",
      name: owner === "a" ? "First Light" : "Beacon Brigade",
      kind: "deck",
      version: 1,
      parent_id: null,
      depth: 1,
    };
    store.locations.push(deck, { ...deck, id: "deck-2", name: "New ideas" });
    const retained = store.rows.find(
      (r) => r.edition.id === "retained"
    )?.edition;
    headers.set(deck.id, {
      revision: 1,
      lines:
        owner === "b"
          ? [
              {
                edition: { ...editions[0], name: "Beacon Keeper" },
                quantity: 1,
              },
            ]
          : [
              { edition: editions[0], quantity: 2 },
              { edition: editions[1], quantity: 4 },
              { edition: editions[2], quantity: 2 },
              ...(retained ? [{ edition: retained, quantity: 1 }] : []),
            ],
    });
    headers.set("deck-2", { revision: 1, lines: [] });
    if (collectionScenario !== "empty")
      store.rows.push({
        edition:
          owner === "b"
            ? { ...editions[0], name: "Beacon Keeper" }
            : editions[0],
        locationId: deck.id,
        quantity: 2,
        version: 1,
      });
  }
  let failedRead = false,
    failedWrite = false,
    stale = false;
  const replay = new Map<string, { digest: string; result: unknown }>();
  async function delay(signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        scenario === "decks-slow" ? 1600 : 120
      );
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  }
  const fail = (code: ConstructorParameters<typeof DeckError>[0]): never => {
    throw new DeckError(code);
  };
  function get(id: string) {
    return (
      store.locations.find((n) => n.id === id && n.kind === "deck") ??
      fail("DECK_NOT_FOUND")
    );
  }
  function detail(id: string): DeckDetail | null {
    const location = store.locations.find(
      (n) => n.id === id && n.kind === "deck"
    );
    if (!location) return null;
    const header = headers.get(id)!;
    return structuredClone({
      location,
      listRevision: header.revision,
      lines: header.lines.map((line) => ({
        ...line,
        ...ownership(
          line.quantity,
          store.rows
            .filter(
              (r) => r.locationId === id && r.edition.id === line.edition.id
            )
            .reduce((n, r) => n + r.quantity, 0),
          store.rows
            .filter(
              (r) => r.locationId !== id && r.edition.id === line.edition.id
            )
            .reduce((n, r) => n + r.quantity, 0)
        ),
      })),
    });
  }
  function name(raw: string, except?: string) {
    let value: string;
    try {
      value = cleanLocationName(raw);
    } catch (e) {
      if (e instanceof CollectionError) fail("INVALID_LOCATION_NAME");
      throw e;
    }
    if (
      store.locations.some(
        (n) =>
          n.id !== except &&
          n.parent_id === null &&
          casefold(n.name) === casefold(value)
      )
    )
      fail("LOCATION_NAME_CONFLICT");
    return value;
  }
  async function command<T>(
    action: string,
    input: unknown,
    options: WriteOptions,
    apply: () => T
  ): Promise<T> {
    await delay(options.signal);
    const digest = JSON.stringify([action, input], (_key, value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(
            Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
          )
        : value
    );
    const previous = replay.get(options.idempotencyKey);
    if (previous) {
      if (digest !== previous.digest) fail("IDEMPOTENCY_KEY_REUSED");
      return structuredClone(previous.result) as T;
    }
    if (scenario === "decks-failure" && !failedWrite) {
      failedWrite = true;
      throw new Error("Synthetic save failure");
    }
    const result = apply();
    replay.set(options.idempotencyKey, {
      digest,
      result: structuredClone(result),
    });
    return result;
  }
  const api: DeckReader & DeckWriter = {
    owner,
    async decks(signal) {
      await delay(signal);
      if (scenario === "decks-failure" && !failedRead) {
        failedRead = true;
        throw new Error("Synthetic read failure");
      }
      return store.locations
        .filter((n) => n.kind === "deck")
        .map((n) => ({
          id: n.id,
          name: n.name,
          version: n.version,
          cardCount: headers
            .get(n.id)!
            .lines.reduce((n, l) => n + l.quantity, 0),
          listRevision: headers.get(n.id)!.revision,
        }));
    },
    async deck(id, signal) {
      await delay(signal);
      return detail(id);
    },
    async createDeck(input, options) {
      // Core cleans before replay, then checks sibling uniqueness after replay.
      try {
        cleanLocationName(input.name);
      } catch {
        fail("INVALID_LOCATION_NAME");
      }
      return command("create", input, options, () => {
        const location = {
          id: crypto.randomUUID(),
          name: name(input.name),
          kind: "deck",
          parent_id: null,
          version: 1,
          depth: 1,
        };
        store.locations.push(location);
        headers.set(location.id, { revision: 1, lines: [] });
        return {
          location: structuredClone(location),
          ownerRevision: ++store.revision,
        };
      });
    },
    async renameDeck(input, options) {
      try {
        cleanLocationName(input.name);
      } catch {
        fail("INVALID_LOCATION_NAME");
      }
      return command("rename", input, options, () => {
        const location = get(input.id);
        if (location.version !== input.version) fail("STALE_LOCATION");
        location.name = name(input.name, input.id);
        location.version++;
        return {
          location: structuredClone(location),
          ownerRevision: ++store.revision,
        };
      });
    },
    async deleteDeck(input, options) {
      let confirmation: string;
      try {
        confirmation = cleanLocationName(input.confirmName);
      } catch {
        return fail("INVALID_LOCATION_NAME");
      }
      return command("delete", input, options, () => {
        const deck = get(input.id);
        if (deck.version !== input.version) fail("STALE_LOCATION");
        if (confirmation !== deck.name)
          fail("LOCATION_NAME_CONFIRMATION_MISMATCH");
        const held = store.rows.filter((r) => r.locationId === deck.id);
        let unsorted = store.locations.find(
          (n) =>
            n.id !== deck.id &&
            n.parent_id === null &&
            casefold(n.name.trim()) === "unsorted"
        );
        if (held.length && unsorted && unsorted.kind !== "storage_leaf")
          fail("UNSORTED_UNAVAILABLE");
        for (const row of held) {
          const target = store.rows.find(
            (r) =>
              r.locationId === unsorted?.id && r.edition.id === row.edition.id
          );
          if (
            BigInt(target?.quantity ?? 0) + BigInt(row.quantity) >
            2n ** 63n - 1n
          )
            fail("QUANTITY_OVERFLOW");
        }
        if (held.length && !unsorted) {
          unsorted = {
            id: crypto.randomUUID(),
            name: "Unsorted",
            kind: "storage_leaf",
            parent_id: null,
            version: 1,
            depth: 1,
          };
          store.locations.push(unsorted);
        }
        store.revision++;
        for (const row of held) {
          const target = store.rows.find(
            (r) =>
              r.locationId === unsorted!.id && r.edition.id === row.edition.id
          );
          if (target) {
            target.quantity += row.quantity;
            target.version = store.revision;
          } else
            store.rows.push({
              ...row,
              locationId: unsorted!.id,
              version: store.revision,
            });
        }
        store.rows = store.rows.filter((r) => r.locationId !== deck.id);
        store.locations = store.locations.filter((n) => n.id !== deck.id);
        headers.delete(deck.id);
        return { ownerRevision: store.revision };
      });
    },
    async changeDeckList(input, options) {
      if (!input.changes.length) fail("NO_CHANGES");
      const seen = new Set<string>();
      for (const change of input.changes) {
        if (seen.has(change.editionId)) fail("DUPLICATE_EDITION");
        seen.add(change.editionId);
        if (!Number.isSafeInteger(change.quantity) || change.quantity < 0)
          fail("INVALID_QUANTITY");
      }
      const changes = [...input.changes].sort((a, b) =>
        a.editionId.localeCompare(b.editionId)
      );
      return command("change", { ...input, changes }, options, () => {
        get(input.deckId);
        const header = headers.get(input.deckId)!;
        if (scenario === "deck-stale" && !stale) {
          stale = true;
          header.revision++;
        }
        if (header.revision !== input.listRevision) fail("STALE_DECK_LIST");
        for (const c of changes)
          if (
            c.quantity &&
            !header.lines.some((l) => l.edition.id === c.editionId) &&
            !editions.some((e) => e.id === c.editionId)
          )
            fail("EDITION_UNAVAILABLE");
        for (const c of changes) {
          const line = header.lines.find((l) => l.edition.id === c.editionId);
          if (!c.quantity)
            header.lines = header.lines.filter((l) => l !== line);
          else if (line) line.quantity = c.quantity;
          else
            header.lines.push({
              edition: editions.find((e) => e.id === c.editionId)!,
              quantity: c.quantity,
            });
        }
        header.revision++;
        return detail(input.deckId)!;
      });
    },
  };
  variants.set(scenario, api);
  return api;
}
