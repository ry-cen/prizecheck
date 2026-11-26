import { beforeEach, describe, expect, it, vi } from "vitest";
import { deckFixture, queueDeckFixtureReadEdit } from "./local/deckFixtures";
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
      expect(edits.error).toContain("This Deck changed, so")
    );
    expect(edits.detail.listRevision).toBe(2);
    expect(edits.busy).toBe(!concurrent);
    expect(edits.canRetry).toBe(!concurrent);
    expect(edits.error).toBe(
      concurrent
        ? "This Deck changed, so your last change wasn't saved. Review the refreshed Deck List."
        : "This Deck changed, so your last change wasn't saved. It's up to date now: try again."
    );
    if (!concurrent) {
      edits.retry();
      await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
      expect(change.mock.calls[1][0].listRevision).toBe(2);
    }
    edits.dispose();
  }
});

it("does not say a Deck changed somewhere else when the collector's own Holding arrival moved its Deck List", async () => {
  const api = deckFixture("a"),
    writer = collectionFixtureWriter("a");
  const initial = (await api.deck("deck-2", signal))!;
  const edits = new DeckEdits(initial, api, () => {});
  edits.reload = async () => (await api.deck("deck-2", signal))!;
  // The collector adds a card to the Deck: the arrival extends the Deck List and advances its revision.
  await writer.add(
    { locationId: "deck-2", editionId: "1", quantity: 1 },
    options()
  );
  expect((await api.deck("deck-2", signal))?.listRevision).toBe(2);
  edits.adjust("1", 1);
  await vi.waitFor(() => expect(edits.error).toContain("This Deck changed"));
  expect(edits.error).toBe(
    "This Deck changed, so your last change wasn't saved. Review the refreshed Deck List."
  );
  expect(edits.error).not.toContain("else");
  edits.dispose();
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

for (const mixed of [false, true]) {
  it(`preserves unrelated ${mixed ? "batched" : "later queued"} edits across a retained re-add refusal`, async () => {
    const api = deckFixture("a");
    const initial = (await api.deck("deck-1", signal))!;
    const releases: (() => void)[] = [];
    const change = vi.fn<DeckWriter["changeDeckList"]>(async (input, opts) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return api.changeDeckList(input, opts);
    });
    const edits = new DeckEdits(
      initial,
      { owner: "a", changeDeckList: change },
      () => {}
    );
    edits.reload = (s) => api.deck("deck-1", s);
    edits.adjust("retained", -1);
    edits.adjust("retained", 1);
    if (mixed) edits.adjust("1", 1);
    releases[0]();
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    if (!mixed) edits.adjust("1", 1);
    releases[1]();
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(3));
    expect(edits.error).toBe(
      "That card can't be added any more. Your other changes are still being saved."
    );
    expect(edits.canRetry).toBe(false);
    expect(change.mock.calls[2][0]).toEqual({
      deckId: "deck-1",
      listRevision: 2,
      changes: [{ editionId: "1", quantity: 3 }],
    });
    expect(change.mock.calls[1][0].changes).toHaveLength(mixed ? 2 : 1);
    releases[2]();
    await vi.waitFor(() => expect(edits.busy).toBe(false));
    const final = (await api.deck("deck-1", signal))!;
    expect(final.listRevision).toBe(3);
    expect(final.lines.find((l) => l.edition.id === "1")?.quantity).toBe(3);
    expect(final.lines.some((l) => l.edition.id === "retained")).toBe(false);
    expect(
      new Set(change.mock.calls.map((call) => call[1].idempotencyKey)).size
    ).toBe(3);
    expect(edits.error).toContain("Your other changes were saved");
    edits.dispose();
  });
}
it("keeps a new-line total changed after dispatch and retries kept edits only after a failed reload recovers", async () => {
  const api = deckFixture("a");
  const initial = (await api.deck("deck-2", signal))!;
  let release!: () => void;
  const change = vi
    .fn<DeckWriter["changeDeckList"]>()
    .mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new DeckError("EDITION_UNAVAILABLE");
    })
    .mockImplementation(api.changeDeckList);
  const edits = new DeckEdits(
    initial,
    { owner: "a", changeDeckList: change },
    () => {}
  );
  edits.reload = vi
    .fn()
    .mockRejectedValueOnce(new Error("Read failed"))
    .mockImplementation((s) => api.deck("deck-2", s));
  edits.adjust("retained", 1);
  edits.adjust("retained", -1); // A zero queued after dispatch must survive.
  edits.adjust("1", 1);
  release();
  await vi.waitFor(() => expect(edits.canRetry).toBe(true));
  expect(change).toHaveBeenCalledTimes(1);
  expect(edits.quantity("retained")).toBe(0);
  edits.retry();
  await vi.waitFor(() => expect(edits.busy).toBe(false));
  // The sole refused-candidate line is certainly unavailable: its pending
  // total, even a zero queued after dispatch, is dropped with it.
  expect(change.mock.calls[1][0].changes).toEqual([
    { editionId: "1", quantity: 1 },
  ]);
  expect(change.mock.calls[1][1].idempotencyKey).not.toBe(
    change.mock.calls[0][1].idempotencyKey
  );
  expect(edits.reload).toHaveBeenCalledTimes(2);
  expect((await api.deck("deck-2", signal))?.lines[0]).toMatchObject({
    edition: { id: "1" },
    quantity: 1,
  });
  edits.dispose();
});
it("applies rename Locations immediately while busy and rejects older Location and list reads", async () => {
  const initial = (await deckFixture("a").deck("deck-1", signal))!;
  let resolve!: (d: DeckDetail) => void;
  const edits = new DeckEdits(
    initial,
    {
      owner: "a",
      changeDeckList: () =>
        new Promise<DeckDetail>((r) => {
          resolve = r;
        }),
    },
    () => {}
  );
  edits.adjust("1", 1);
  edits.acceptLocation({
    ...initial.location,
    name: "First rename",
    version: 2,
  });
  edits.acceptRead({
    ...initial,
    location: { ...initial.location, name: "Second rename", version: 3 },
  });
  expect(edits.detail.location).toMatchObject({
    name: "Second rename",
    version: 3,
  });
  expect(edits.quantity("1")).toBe(3);
  edits.acceptLocation({ ...initial.location, name: "Old rename", version: 2 });
  const saved = {
    ...initial,
    listRevision: 2,
    lines: initial.lines.map((l) =>
      l.edition.id === "1" ? { ...l, quantity: 3 } : l
    ),
  };
  resolve(saved);
  await vi.waitFor(() => expect(edits.busy).toBe(false));
  edits.acceptRead(initial);
  expect(edits.detail.location).toMatchObject({
    name: "Second rename",
    version: 3,
  });
  expect(edits.quantity("1")).toBe(3);
  expect(edits.detail.listRevision).toBe(2);
  edits.dispose();
});

it("isolates ambiguous additions so an available new Edition survives repeated batch refusals", async () => {
  const api = deckFixture("a");
  const initial = (await api.deck("deck-1", signal))!;
  let release!: () => void;
  const change = vi
    .fn<DeckWriter["changeDeckList"]>()
    .mockImplementationOnce(async (input, opts) => {
      await new Promise<void>((r) => {
        release = r;
      });
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
  edits.adjust("4", 1);
  edits.adjust("1", 1);
  release();
  await vi.waitFor(() => expect(edits.busy).toBe(false));
  const final = (await api.deck("deck-1", signal))!;
  expect(final.lines.find((l) => l.edition.id === "4")?.quantity).toBe(1);
  expect(final.lines.find((l) => l.edition.id === "1")?.quantity).toBe(3);
  expect(final.lines.some((l) => l.edition.id === "retained")).toBe(false);
  expect(
    change.mock.calls.slice(2).map((c) => c[0].changes.map((x) => x.editionId))
  ).toEqual([["1"], ["retained"], ["4"]]);
  expect(new Set(change.mock.calls.map((c) => c[1].idempotencyKey)).size).toBe(
    change.mock.calls.length
  );
  edits.dispose();
});
for (const failed of [false, true])
  it(`reviews per-Edition conflicts during ${failed ? "Retry" : "automatic refusal reload"}`, async () => {
    const { changeFixtureDeckLine } = await import("./local/deckTestHooks");
    const api = deckFixture("a");
    const initial = (await api.deck("deck-1", signal))!;
    let release!: () => void;
    const change = vi
      .fn<DeckWriter["changeDeckList"]>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((r) => {
          release = r;
        });
        throw new DeckError("EDITION_UNAVAILABLE");
      })
      .mockImplementation(api.changeDeckList);
    const edits = new DeckEdits(
      initial,
      { owner: "a", changeDeckList: change },
      () => {}
    );
    let reads = 0;
    edits.reload = async (s) => {
      reads++;
      if (failed && reads === 1) throw Error("offline");
      queueDeckFixtureReadEdit("a", () =>
        changeFixtureDeckLine("a", "deck-1", "1", 7)
      );
      return api.deck("deck-1", s);
    };
    edits.adjust("missing", 1);
    edits.adjust("1", 1);
    edits.adjust("2", 1);
    release();
    if (failed) {
      await vi.waitFor(() => expect(edits.canRetry).toBe(true));
      edits.retry();
    }
    await vi.waitFor(() =>
      expect(edits.error).toContain("Review the Deck List")
    );
    expect(edits.error).toBe(
      "That card can't be added any more, and this Deck changed, so some changes weren’t saved. Review the Deck List."
    );
    expect(change).toHaveBeenCalledTimes(1);
    expect(edits.canRetry).toBe(true);
    edits.retry();
    await vi.waitFor(() => expect(edits.busy).toBe(false));
    const final = (await api.deck("deck-1", signal))!;
    expect(final.lines.find((l) => l.edition.id === "1")?.quantity).toBe(7);
    expect(final.lines.find((l) => l.edition.id === "2")?.quantity).toBe(5);
    expect(change.mock.calls[1][0].changes).toEqual([
      { editionId: "2", quantity: 5 },
    ]);
    edits.dispose();
  });

function gatedWriter(api: ReturnType<typeof deckFixture>, gated: number) {
  const releases: (() => void)[] = [];
  let n = 0;
  const change = vi.fn<DeckWriter["changeDeckList"]>(async (input, opts) => {
    if (n++ < gated)
      await new Promise<void>((resolve) => releases.push(resolve));
    return api.changeDeckList(input, opts);
  });
  return { change, releases };
}
const editionsOf = (change: ReturnType<typeof gatedWriter>["change"]) =>
  change.mock.calls.map((c) => c[0].changes.map((x) => x.editionId));
for (const reclick of ["again", "to zero"])
  it(`keeps an available Edition when the refused line is changed ${reclick} while their batch is in flight`, async () => {
    const api = deckFixture("a");
    const initial = (await api.deck("deck-1", signal))!;
    const { change, releases } = gatedWriter(api, 2);
    const edits = new DeckEdits(
      initial,
      { owner: "a", changeDeckList: change },
      () => {}
    );
    edits.reload = (s) => api.deck("deck-1", s);
    edits.adjust("retained", -1);
    edits.adjust("retained", 1);
    edits.adjust("4", 1);
    releases[0]();
    await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
    expect(change.mock.calls[1][0].changes).toEqual([
      { editionId: "retained", quantity: 1 },
      { editionId: "4", quantity: 1 },
    ]);
    edits.adjust("retained", reclick === "again" ? 1 : -1);
    releases[1]();
    await vi.waitFor(() => expect(edits.busy).toBe(false));
    const final = (await api.deck("deck-1", signal))!;
    expect(final.lines.find((l) => l.edition.id === "4")?.quantity).toBe(1);
    expect(final.lines.some((l) => l.edition.id === "retained")).toBe(false);
    expect(edits.quantity("retained")).toBe(0);
    expect(editionsOf(change).slice(2)).toEqual(
      reclick === "again" ? [["retained"], ["4"]] : [["4"]]
    );
    expect(
      new Set(change.mock.calls.map((c) => c[1].idempotencyKey)).size
    ).toBe(change.mock.calls.length);
    edits.dispose();
  });
it("flushes ordinary totals first, then isolates and drops each of two refused additions", async () => {
  const api = deckFixture("a");
  const initial = (await api.deck("deck-1", signal))!;
  const { change, releases } = gatedWriter(api, 2);
  const edits = new DeckEdits(
    initial,
    { owner: "a", changeDeckList: change },
    () => {}
  );
  edits.reload = (s) => api.deck("deck-1", s);
  edits.adjust("1", 1);
  edits.adjust("missing", 1);
  edits.adjust("gone", 1);
  edits.adjust("4", 1);
  edits.adjust("2", 1);
  releases[0]();
  await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(2));
  releases[1]();
  await vi.waitFor(() => expect(edits.busy).toBe(false), { timeout: 8000 });
  expect(editionsOf(change)).toEqual([
    ["1"],
    ["missing", "gone", "4", "2"],
    ["2"],
    ["missing"],
    ["gone"],
    ["4"],
  ]);
  const final = (await api.deck("deck-1", signal))!;
  expect(final.lines.find((l) => l.edition.id === "4")?.quantity).toBe(1);
  expect(final.lines.find((l) => l.edition.id === "2")?.quantity).toBe(5);
  expect(
    final.lines.some((l) => ["missing", "gone"].includes(l.edition.id))
  ).toBe(false);
  expect(edits.quantity("missing")).toBe(0);
  expect(edits.quantity("gone")).toBe(0);
  edits.dispose();
});
it("forgets isolated additions when a stale Deck List clears the pending edits", async () => {
  const { changeFixtureDeckLine } = await import("./local/deckTestHooks");
  const api = deckFixture("a");
  const initial = (await api.deck("deck-1", signal))!;
  const releases: (() => void)[] = [];
  let n = 0;
  const change = vi.fn<DeckWriter["changeDeckList"]>(async (input, opts) => {
    const call = n++;
    if (call === 0 || call === 3)
      await new Promise<void>((resolve) => releases.push(resolve));
    if (call === 1) throw new DeckError("EDITION_UNAVAILABLE");
    if (call === 2) {
      changeFixtureDeckLine("a", "deck-1", "2", 9);
      throw new DeckError("STALE_DECK_LIST");
    }
    return api.changeDeckList(input, opts);
  });
  const edits = new DeckEdits(
    initial,
    { owner: "a", changeDeckList: change },
    () => {}
  );
  edits.reload = (s) => api.deck("deck-1", s);
  edits.adjust("1", 1);
  edits.adjust("missing", 1);
  edits.adjust("gone", 1);
  edits.adjust("2", 1);
  releases[0]();
  await vi.waitFor(() => expect(edits.busy).toBe(false), { timeout: 8000 });
  expect(editionsOf(change)).toEqual([["1"], ["missing", "gone", "2"], ["2"]]);
  expect(edits.error).toContain("Review the refreshed Deck List");
  edits.adjust("2", 1);
  await vi.waitFor(() => expect(change).toHaveBeenCalledTimes(4));
  edits.adjust("missing", 1);
  edits.adjust("1", 1);
  releases[1]();
  await vi.waitFor(() => expect(edits.busy).toBe(false));
  // A leftover isolation mark would have sent "1" without "missing".
  expect(change.mock.calls[4][0].changes.map((c) => c.editionId)).toEqual([
    "missing",
    "1",
  ]);
  edits.dispose();
});
