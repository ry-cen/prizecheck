import { beforeEach, describe, expect, it, vi } from "vitest";
import { deckFixture } from "./local/deckFixtures";
import {
  collectionFixtureStore,
  collectionFixtureWriter,
  resetCollectionFixtures,
} from "./local/collectionFixtures";
import { DeckEdits } from "./deckEdits";
import {
  DeckError,
  ownership,
  type DeckDetail,
  type DeckWriter,
} from "./decks";
const signal = new AbortController().signal;
const options = (idempotencyKey = crypto.randomUUID()) => ({
  signal,
  idempotencyKey,
});
beforeEach(() => {
  resetCollectionFixtures();
});
describe("fixture Deck commands", () => {
  it("sets exact Edition totals, removes zero lines, advances only list revision, and replays normalized batches", async () => {
    const api = deckFixture("a");
    const store = collectionFixtureStore("a");
    const before = structuredClone(store);
    const initial = (await api.deck("deck-1", signal))!;
    const input = {
      deckId: "deck-1",
      listRevision: initial.listRevision,
      changes: [
        { editionId: "1", quantity: 3 },
        { editionId: "4", quantity: 2 },
      ],
    };
    const opt = options();
    await expect(
      api.changeDeckList({ ...input, listRevision: 99, changes: [] }, options())
    ).rejects.toMatchObject({ code: "NO_CHANGES" });
    await expect(
      api.changeDeckList(
        {
          ...input,
          listRevision: 99,
          changes: [{ editionId: "1", quantity: -1 }],
        },
        options()
      )
    ).rejects.toMatchObject({ code: "INVALID_QUANTITY" });
    const result = await api.changeDeckList(input, opt);
    expect(result.listRevision).toBe(2);
    expect(result.lines.find((l) => l.edition.id === "4")?.quantity).toBe(2);
    expect(
      await api.changeDeckList(
        {
          changes: [...input.changes].reverse(),
          listRevision: input.listRevision,
          deckId: input.deckId,
        },
        opt
      )
    ).toEqual(result);
    await expect(
      api.changeDeckList(
        { ...input, changes: [{ editionId: "1", quantity: 8 }] },
        opt
      )
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(api.changeDeckList(input, options())).rejects.toMatchObject({
      code: "STALE_DECK_LIST",
    });
    const removed = await api.changeDeckList(
      {
        deckId: "deck-1",
        listRevision: 2,
        changes: [{ editionId: "4", quantity: 0 }],
      },
      options()
    );
    expect(removed.lines.some((l) => l.edition.id === "4")).toBe(false);
    expect(store).toEqual(before);
  });
  it("permits increasing and decreasing a retained line but refuses creating it again", async () => {
    const api = deckFixture("a");
    let revision = 1;
    for (const quantity of [3, 1, 0]) {
      const result = await api.changeDeckList(
        {
          deckId: "deck-1",
          listRevision: revision,
          changes: [{ editionId: "retained", quantity }],
        },
        options()
      );
      expect(
        result.lines.find((l) => l.edition.id === "retained")?.quantity ?? 0
      ).toBe(quantity);
      revision = result.listRevision;
    }
    await expect(
      api.changeDeckList(
        {
          deckId: "deck-1",
          listRevision: revision,
          changes: [{ editionId: "retained", quantity: 1 }],
        },
        options()
      )
    ).rejects.toMatchObject({ code: "EDITION_UNAVAILABLE" });
  });
  it("counts ownership per exact Edition, with no Loans", async () => {
    expect(ownership(4, 2, 1)).toEqual({
      inDeck: 2,
      elsewhere: 1,
      notOwned: 1,
    });
    expect(ownership(2, 5, 6)).toEqual({
      inDeck: 2,
      elsewhere: 0,
      notOwned: 0,
    });
    const deck = (await deckFixture("a").deck("deck-1", signal))!;
    expect(deck.lines.find((l) => l.edition.id === "1")).toMatchObject({
      inDeck: 2,
      elsewhere: 0,
      notOwned: 0,
    });
    expect(deck.lines.find((l) => l.edition.id === "2")).toMatchObject({
      inDeck: 0,
      elsewhere: 2,
      notOwned: 2,
    });
    expect(deck.lines.find((l) => l.edition.id === "3")).toMatchObject({
      inDeck: 0,
      elsewhere: 0,
      notOwned: 2,
    });
  });
  it("requires version/name confirmation and merges deleted holdings into Unsorted once", async () => {
    const api = deckFixture("a");
    const input = { id: "deck-1", confirmName: "First Light", version: 1 };
    const opt = options();
    await expect(
      api.deleteDeck({ ...input, version: 9 }, options())
    ).rejects.toMatchObject({ code: "STALE_LOCATION" });
    await expect(
      api.deleteDeck({ ...input, confirmName: "Wrong" }, options())
    ).rejects.toMatchObject({ code: "LOCATION_NAME_CONFIRMATION_MISMATCH" });
    const result = await api.deleteDeck(input, opt);
    expect(await api.deleteDeck(input, opt)).toEqual(result);
    expect(await api.deck(input.id, signal)).toBeNull();
    const store = collectionFixtureStore("a");
    expect(
      store.rows.find((r) => r.locationId === "1" && r.edition.id === "1")
        ?.quantity
    ).toBe(5);
    expect(store.rows.some((r) => r.locationId === input.id)).toBe(false);
  });
  it("accepts WP2 Move into a Deck and recomputes its in-Deck ownership", async () => {
    const api = deckFixture("a");
    const writer = collectionFixtureWriter("a");
    await api.changeDeckList(
      {
        deckId: "deck-1",
        listRevision: 1,
        changes: [{ editionId: "1", quantity: 4 }],
      },
      options()
    );
    await writer.move(
      {
        items: [
          { editionId: "1", sourceId: "1", quantity: 1, expectedVersion: 1 },
        ],
        destinationId: "deck-1",
      },
      options()
    );
    expect(
      (await api.deck("deck-1", signal))?.lines.find(
        (l) => l.edition.id === "1"
      )
    ).toMatchObject({ quantity: 4, inDeck: 3, elsewhere: 1, notOwned: 0 });
  });
  it("isolates owners with colliding ids and rejects duplicate names", async () => {
    const a = deckFixture("a"),
      b = deckFixture("b");
    const bBefore = await b.deck("deck-1", signal);
    await a.renameDeck(
      { id: "deck-1", name: "Renamed", version: 1 },
      options()
    );
    expect(await b.deck("deck-1", signal)).toEqual(bBefore);
    await expect(
      a.createDeck({ name: " renamed " }, options())
    ).rejects.toMatchObject({ code: "LOCATION_NAME_CONFLICT" });
    const created = await a.createDeck({ name: "Fresh" }, options());
    expect((await a.deck(created.location.id, signal))?.listRevision).toBe(1);
  });
});
describe("serialized Deck edits", () => {
  const detail: DeckDetail = {
    location: {
      id: "deck",
      name: "Deck",
      kind: "deck",
      parent_id: null,
      depth: 1,
      version: 1,
    },
    listRevision: 1,
    lines: [],
  };
  it("coalesces a burst into one next write and uses the returned revision", async () => {
    const resolves: ((d: DeckDetail) => void)[] = [];
    const change = vi.fn(
      (
        _input: Parameters<DeckWriter["changeDeckList"]>[0],
        _options: Parameters<DeckWriter["changeDeckList"]>[1]
      ) => new Promise<DeckDetail>((resolve) => resolves.push(resolve))
    );
    const writer = {
      owner: "a",
      changeDeckList: change,
    };
    const edits = new DeckEdits(detail, writer, () => {});
    edits.adjust("1", 1);
    edits.adjust("1", 1);
    edits.adjust("1", 1);
    expect(change).toHaveBeenCalledTimes(1);
    edits.acceptRead({ ...detail, listRevision: 9 });
    expect(edits.detail.listRevision).toBe(1);
    resolves[0]({ ...detail, listRevision: 2 });
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change.mock.calls[1]).toBeDefined();
    expect(change).toHaveBeenLastCalledWith(
      {
        deckId: "deck",
        listRevision: 2,
        changes: [{ editionId: "1", quantity: 3 }],
      },
      expect.anything()
    );
    resolves[1]({ ...detail, listRevision: 3 });
    await vi.waitFor(() => expect(edits.busy).toBe(false));
    edits.acceptRead({ ...detail, listRevision: 4 });
    expect(edits.detail.listRevision).toBe(4);
    edits.dispose();
  });
  it("keeps the same payload/key after failure and ignores a late completion after unmount", async () => {
    let resolve!: (d: DeckDetail) => void;
    const change = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(
        () =>
          new Promise<DeckDetail>((r) => {
            resolve = r;
          })
      );
    const changed = vi.fn();
    const edits = new DeckEdits(
      detail,
      { owner: "a", changeDeckList: change },
      changed
    );
    edits.adjust("1", 1);
    await vi.waitFor(() =>
      expect(edits.error).toBe(
        "Your last Deck List change may not have been saved. Try again to check safely."
      )
    );
    edits.retry();
    expect(change.mock.calls[1]).toEqual(change.mock.calls[0]);
    edits.dispose();
    changed.mockClear();
    resolve({ ...detail, listRevision: 2 });
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(edits.detail.listRevision).toBe(1);
  });
});

it("retains unambiguous stale intent at the new revision and drops intent when quantities changed", async () => {
  const initial = (await deckFixture("a").deck("deck-1", signal))!;
  for (const concurrent of [false, true]) {
    const fresh = structuredClone(initial);
    fresh.listRevision = 2;
    if (concurrent) fresh.lines[0].quantity++;
    const change = vi
      .fn<DeckWriter["changeDeckList"]>()
      .mockRejectedValueOnce(new DeckError("STALE_DECK_LIST"))
      .mockResolvedValue({ ...fresh, listRevision: 3 });
    const edits = new DeckEdits(
      initial,
      { owner: "a", changeDeckList: change },
      () => {}
    );
    edits.reload = async () => fresh;
    edits.adjust(initial.lines[0].edition.id, 1);
    await vi.waitFor(() =>
      expect(edits.error).toContain("This Deck changed somewhere else")
    );
    expect(edits.detail.listRevision).toBe(2);
    expect(edits.busy).toBe(!concurrent);
    expect(edits.canRetry).toBe(!concurrent);
    expect(edits.error).toBe(
      concurrent
        ? "This Deck changed somewhere else, so your last change wasn't saved. Review the refreshed Deck List."
        : "This Deck changed somewhere else, so your last change wasn't saved. It's up to date now: try again."
    );
    if (!concurrent) {
      edits.retry();
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
      expect(change.mock.calls[1][0].listRevision).toBe(2);
    }
    edits.dispose();
  }
});

describe("Holdings arriving in Decks cover their Deck Lists", () => {
  const item = (
    store: ReturnType<typeof collectionFixtureStore>,
    sourceId: string,
    editionId: string,
    quantity = 1
  ) => ({
    sourceId,
    editionId,
    quantity,
    expectedVersion: store.rows.find(
      (row) => row.locationId === sourceId && row.edition.id === editionId
    )!.version,
  });
  it("covers new and extended lines, including mixed upsert phases, without replaying arrivals", async () => {
    const api = deckFixture("a"),
      other = deckFixture("b");
    const writer = collectionFixtureWriter("a"),
      store = collectionFixtureStore("a");
    const otherBefore = await other.deck("deck-2", signal);
    await writer.add(
      { locationId: "deck-2", editionId: "1", quantity: 1 },
      options()
    );
    expect((await api.deck("deck-2", signal))?.listRevision).toBe(2);
    const input = {
      items: [item(store, "1", "1"), item(store, "4", "2")],
      destinationId: "deck-2",
    };
    const key = options();
    const result = await writer.move(input, key);
    const deck = (await api.deck("deck-2", signal))!;
    expect(deck.listRevision).toBe(4); // One growing update phase, one growing insert phase.
    expect(
      deck.lines.map((line) => [line.edition.id, line.quantity, line.inDeck])
    ).toEqual([
      ["1", 2, 2],
      ["2", 1, 1],
    ]);
    expect(await writer.move(input, key)).toEqual(result);
    expect(await api.deck("deck-2", signal)).toEqual(deck);
    expect(await other.deck("deck-2", signal)).toEqual(otherBefore);
  });
  it("fills a covered line without changing its revision and preserves surplus cuts", async () => {
    const api = deckFixture("a"),
      writer = collectionFixtureWriter("a"),
      store = collectionFixtureStore("a");
    await api.changeDeckList(
      {
        deckId: "deck-1",
        listRevision: 1,
        changes: [{ editionId: "1", quantity: 4 }],
      },
      options()
    );
    await writer.move(
      { items: [item(store, "1", "1")], destinationId: "deck-1" },
      options()
    );
    let deck = (await api.deck("deck-1", signal))!;
    expect(deck.listRevision).toBe(2);
    expect(deck.lines.find((line) => line.edition.id === "1")).toMatchObject({
      quantity: 4,
      inDeck: 3,
    });
    await api.changeDeckList(
      {
        deckId: "deck-1",
        listRevision: 2,
        changes: [{ editionId: "1", quantity: 1 }],
      },
      options()
    );
    await writer.move(
      { items: [item(store, "1", "1")], destinationId: "deck-1" },
      options()
    );
    deck = (await api.deck("deck-1", signal))!;
    expect(deck.listRevision).toBe(4);
    expect(deck.lines.find((line) => line.edition.id === "1")).toMatchObject({
      quantity: 2,
      inDeck: 2,
    });
    expect(
      store.rows.find(
        (row) => row.locationId === "deck-1" && row.edition.id === "1"
      )?.quantity
    ).toBe(4);
  });
  it("allows an owned retained Edition to arrive even though explicit new-line creation is unavailable", async () => {
    const api = deckFixture("a"),
      writer = collectionFixtureWriter("a"),
      store = collectionFixtureStore("a");
    await expect(
      api.changeDeckList(
        {
          deckId: "deck-2",
          listRevision: 1,
          changes: [{ editionId: "retained", quantity: 1 }],
        },
        options()
      )
    ).rejects.toMatchObject({ code: "EDITION_UNAVAILABLE" });
    await writer.move(
      { items: [item(store, "4", "retained")], destinationId: "deck-2" },
      options()
    );
    const deck = (await api.deck("deck-2", signal))!;
    expect(deck.listRevision).toBe(2);
    expect(deck.lines[0]).toMatchObject({
      edition: { id: "retained" },
      quantity: 1,
      inDeck: 1,
      notOwned: 0,
    });
  });
  it("does not shrink on removal and covers ordinary Inventory Undo returns", async () => {
    const api = deckFixture("a"),
      writer = collectionFixtureWriter("a"),
      store = collectionFixtureStore("a");
    await writer.add(
      { locationId: "deck-2", editionId: "1", quantity: 1 },
      options()
    );
    const removed = await writer.remove(
      { items: [item(store, "deck-2", "1")] },
      options()
    );
    expect((await api.deck("deck-2", signal))?.listRevision).toBe(2);
    await api.changeDeckList(
      {
        deckId: "deck-2",
        listRevision: 2,
        changes: [{ editionId: "1", quantity: 0 }],
      },
      options()
    );
    await writer.undo(removed.undo.id, options());
    const deck = (await api.deck("deck-2", signal))!;
    expect(deck.listRevision).toBe(4);
    expect(deck.lines[0]).toMatchObject({ quantity: 1, inDeck: 1 });
  });
});

it("releases a definitive retained re-add refusal, accepts ownership reads and starts new edits with new keys", async () => {
  const api = deckFixture("a");
  const initial = (await api.deck("deck-1", signal))!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const change = vi.fn<DeckWriter["changeDeckList"]>();
  change
    .mockImplementationOnce(async (input, opts) => {
      await gate;
      return api.changeDeckList(input, opts);
    })
    .mockImplementation(api.changeDeckList);
  const edits = new DeckEdits(
    initial,
    { owner: "a", changeDeckList: change },
    () => {}
  );
  edits.reload = (s) => api.deck("deck-1", s);
  edits.adjust("retained", -1);
  edits.adjust("retained", 1);
  release();
  await vi.waitFor(() => expect(edits.error).toContain("can't be added"));
  await vi.waitFor(() => expect(edits.busy).toBe(false));
  expect(edits.canRetry).toBe(false);
  expect(edits.detail.lines.some((l) => l.edition.id === "retained")).toBe(
    false
  );
  edits.retry();
  expect(change).toHaveBeenCalledTimes(2);
  await collectionFixtureWriter("a").add(
    { locationId: "deck-1", editionId: "1", quantity: 1 },
    options()
  );
  edits.acceptRead((await api.deck("deck-1", signal))!);
  expect(edits.detail.lines.find((l) => l.edition.id === "1")?.inDeck).toBe(3);
  edits.adjust("1", 1);
  await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(3));
  await vi.waitFor(() => expect(edits.busy).toBe(false));
  expect(edits.error).toBe("");
  expect(edits.quantity("1")).toBe(4);
  expect(
    new Set(change.mock.calls.map((call) => call[1].idempotencyKey)).size
  ).toBe(3);
  edits.dispose();
});
