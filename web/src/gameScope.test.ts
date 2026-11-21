// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  announceDeckListChanged,
  useDeckListChanged,
} from "./decks/deckListChanged";
import {
  hasStoredAddQueue,
  forgetAddQueues,
} from "./catalog/useStoredAddQueue";
import { GAME_IDS, scopedPrefix } from "./gameScope";
import {
  prefsStorageKey,
  useGalleryPrefs,
  type GalleryPrefs,
} from "./workspace/galleryPrefs";
import {
  moveActivityKey,
  moveLockName,
  withMoveWriter,
} from "./workspace/moveRecovery";
import { pendingMovePrefix, pendingMoves } from "./workspace/pendingMove";
import { createOperation } from "./workspace/moveOperation";
import {
  ownerRevisionChannelName,
  sharedRevision,
  useStaleCollection,
} from "./workspace/useStaleCollection";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

test("pokemon keys are byte-identical to the legacy literals", () => {
  const owner = "user 1/é";
  const enc = encodeURIComponent(owner);
  for (const game of [undefined, "pokemon"] as const) {
    expect(game ? prefsStorageKey("u1", game) : prefsStorageKey("u1")).toBe(
      "prizecheck:workspace:preferences:v1:u1"
    );
    expect(
      game ? pendingMovePrefix(owner, game) : pendingMovePrefix(owner)
    ).toBe(`prizecheck:mixed-move:v1:${enc}:`);
    expect(game ? moveLockName(owner, game) : moveLockName(owner)).toBe(
      `prizecheck:mixed-move:${enc}`
    );
    expect(game ? moveActivityKey(owner, game) : moveActivityKey(owner)).toBe(
      `prizecheck:mixed-move:${enc}:activity`
    );
    expect(
      game
        ? ownerRevisionChannelName("u1", game)
        : ownerRevisionChannelName("u1")
    ).toBe("prizecheck-owner-revision:u1");
  }
  sessionStorage.setItem(
    "prizecheck:add-queue:acct:page",
    JSON.stringify({
      items: [{ editionId: "e", printingId: "p", quantity: 1 }],
      target: null,
      uncertain: false,
    })
  );
  expect(hasStoredAddQueue("acct", "page")).toBe(true);
  expect(hasStoredAddQueue("acct", "page", "pokemon")).toBe(true);
  expect(scopedPrefix("riftbound", "add-queue")).toBe(
    "prizecheck:riftbound:add-queue:"
  );
});

test("another game never shares a key, lock, channel or event with Pokémon", () => {
  const owner = "user-1";
  const other = "riftbound" as const;
  expect(prefsStorageKey("u1", other)).not.toBe(prefsStorageKey("u1"));
  expect(pendingMovePrefix(owner, other)).not.toBe(pendingMovePrefix(owner));
  expect(moveLockName(owner, other)).not.toBe(moveLockName(owner));
  expect(moveActivityKey(owner, other)).not.toBe(moveActivityKey(owner));
  expect(ownerRevisionChannelName("u1", other)).not.toBe(
    ownerRevisionChannelName("u1")
  );
  // Neither game's keys are a prefix of the other's, so a prefix scan cannot cross over.
  expect(
    pendingMovePrefix(owner, other).startsWith(pendingMovePrefix(owner))
  ).toBe(false);
  expect(
    pendingMovePrefix(owner).startsWith(pendingMovePrefix(owner, other))
  ).toBe(false);
});

test("the move writer lock and activity key are the game's own", async () => {
  const names: string[] = [];
  const locks = {
    request: (async (
      name: string,
      _o: unknown,
      cb: (l: unknown) => unknown
    ) => {
      names.push(name);
      return cb({});
    }) as unknown as LockManager["request"],
    query: async () => ({ held: [], pending: [] }),
  };
  await withMoveWriter("o", async () => 1, locks);
  await withMoveWriter("o", async () => 1, locks, "riftbound");
  expect(names).toEqual([moveLockName("o"), moveLockName("o", "riftbound")]);
  expect(
    localStorage.getItem(moveActivityKey("o", "riftbound"))
  ).not.toBeNull();
  localStorage.clear();
});

test("a reload reads only the same game's stored queue and recovery", () => {
  const queue = JSON.stringify({
    items: [{ editionId: "e", printingId: "p", quantity: 2 }],
    target: null,
    uncertain: false,
  });
  sessionStorage.setItem("prizecheck:add-queue:acct:page", queue);
  expect(hasStoredAddQueue("acct", "page", "riftbound")).toBe(false);
  sessionStorage.setItem(
    scopedPrefix("riftbound", "add-queue") + "acct2:page",
    queue
  );
  expect(hasStoredAddQueue("acct2", "page")).toBe(false);
  expect(hasStoredAddQueue("acct2", "page", "riftbound")).toBe(true);
  expect(hasStoredAddQueue("acct", "page")).toBe(true);

  // Recovery: an unresolved record saved for one game is read only by that game's scan.
  const disk = memoryStorage();
  const witness = memoryStorage();
  const ops = [
    {
      source_id: "s",
      edition_id: "e",
      quantity: "1",
      expected_version: 1,
    },
  ];
  const held = createOperation(
    "dest",
    ops,
    [
      {
        loan_id: "loan",
        edition_id: "e",
        from_location_id: "s",
        quantity: "1",
      },
    ],
    Date.now()
  );
  pendingMoves("o", disk, witness).save(held);
  expect(pendingMoves("o", disk, witness, "riftbound").load()).toBeNull();
  expect(pendingMoves("o", disk, witness).load()?.op.id).toBe(held.op.id);
  expect(pendingMoves("o", disk, witness, "pokemon").load()?.op.id).toBe(
    held.op.id
  );
  expect([...Array(disk.length).keys()].map((i) => disk.key(i)!)).toEqual([
    pendingMovePrefix("o") + held.op.id,
  ]);
});

test("signing out clears every game's add queue", () => {
  sessionStorage.setItem("prizecheck:add-queue:acct:page", "x");
  sessionStorage.setItem("prizecheck:riftbound:add-queue:acct:page", "x");
  forgetAddQueues();
  expect(sessionStorage.length).toBe(0);
  expect(GAME_IDS).toContain("riftbound");
});

test("a revision message naming another game is ignored by the receiver", () => {
  expect(
    sharedRevision({ revision: 7, game: "riftbound" }, "pokemon")
  ).toBeNull();
  expect(
    sharedRevision({ revision: 7, game: "pokemon" }, "riftbound")
  ).toBeNull();
  expect(sharedRevision({ revision: 7, game: "riftbound" }, "riftbound")).toBe(
    7
  );
});

test("a legacy channel message without game still reaches Pokémon", () => {
  expect(sharedRevision({ revision: 5 })).toBe(5);
  expect(sharedRevision({ revision: 5 }, "pokemon")).toBe(5);
  expect(sharedRevision({ revision: 5 }, "riftbound")).toBeNull();
  expect(sharedRevision({ revision: 0 })).toBeNull();
  expect(sharedRevision(null)).toBeNull();
});

test("a Deck event for the other game with the same deckId does not fire", async () => {
  const calls: string[] = [];
  const Probe = ({ game }: { game?: "pokemon" | "riftbound" }) => {
    useDeckListChanged("d1", () => calls.push(game ?? "default"), game);
    return null;
  };
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement("div", null, [
        createElement(Probe, { key: "a" }),
        createElement(Probe, { key: "b", game: "riftbound" }),
      ])
    );
  });
  announceDeckListChanged("d1");
  expect(calls).toEqual(["default"]);
  announceDeckListChanged("d1", "riftbound");
  expect(calls).toEqual(["default", "riftbound"]);
  announceDeckListChanged("other", "riftbound");
  expect(calls).toHaveLength(2);
  // An older caller's bare string detail means a Pokémon Deck.
  window.dispatchEvent(
    new CustomEvent("prizecheck:deck-list-changed", { detail: "d1" })
  );
  expect(calls).toEqual(["default", "riftbound", "default"]);
  await act(async () => root.unmount());
});

async function mount(render: () => ReturnType<typeof createElement>) {
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(render()));
  return {
    rerender: (next: () => ReturnType<typeof createElement>) =>
      act(async () => root.render(next())),
    unmount: () => act(async () => root.unmount()),
  };
}

test("switching game on a mounted gallery loads the new game's preferences and overwrites neither", async () => {
  const pokemon = { sort: "set-desc", display: { names: true } };
  const riftbound = { sort: "quantity-desc", display: { prices: true } };
  const pokemonKey = prefsStorageKey("u1");
  const riftboundKey = prefsStorageKey("u1", "riftbound");
  localStorage.setItem(pokemonKey, JSON.stringify(pokemon));
  localStorage.setItem(riftboundKey, JSON.stringify(riftbound));
  const seen: GalleryPrefs[] = [];
  const Probe = ({ game }: { game: "pokemon" | "riftbound" }) => {
    const [prefs] = useGalleryPrefs("u1", game);
    seen.push(prefs);
    return null;
  };
  const view = await mount(() => createElement(Probe, { game: "pokemon" }));
  const fromPokemon = seen.at(-1)!;
  await view.rerender(() => createElement(Probe, { game: "riftbound" }));
  const fromRiftbound = seen.at(-1)!;
  expect(fromRiftbound).not.toEqual(fromPokemon);
  expect(fromRiftbound.sort).toBe("quantity-desc");
  expect(fromRiftbound.display.prices).toBe(true);
  expect(fromRiftbound.display.names).toBe(false);
  expect(JSON.parse(localStorage.getItem(pokemonKey)!).sort).toBe("set-desc");
  expect(JSON.parse(localStorage.getItem(riftboundKey)!).sort).toBe(
    "quantity-desc"
  );
  expect(JSON.parse(localStorage.getItem(riftboundKey)!).display.prices).toBe(
    true
  );
  // No render between the switch and its load ever showed the old game's values for the new game.
  await view.rerender(() => createElement(Probe, { game: "pokemon" }));
  expect(seen.at(-1)).toEqual(fromPokemon);
  await view.unmount();
  localStorage.clear();
});

test("the revision hook sends, counts and probes for the game it is on", async () => {
  const listen = (name: string) => {
    const got: unknown[] = [];
    const channel = new BroadcastChannel(name);
    channel.onmessage = (e) => got.push(e.data);
    return { got, channel };
  };
  const pokemonSide = listen(ownerRevisionChannelName("u1", "pokemon"));
  const riftboundSide = listen(ownerRevisionChannelName("u1", "riftbound"));
  const riftboundRead = vi.fn(async () => ({ owner_revision: 4 }));
  const base = {
    userId: "u1",
    galleryStatus: "ready" as const,
    byKey: new Map(),
    galleryKey: "k",
    reloadGallery: () => {},
    treeReady: true,
    reloadTree: () => {},
    selected: new Set() as never,
    clearSelection: () => {},
    busy: false,
  };
  const Probe = (props: {
    game: "pokemon" | "riftbound";
    revision: number;
    active: boolean;
  }) => {
    const common = {
      ...base,
      galleryRevision: props.revision,
      treeRevision: props.revision,
      active: props.active,
    };
    useStaleCollection(
      props.game === "pokemon"
        ? { ...common, game: "pokemon" }
        : { ...common, game: "riftbound", readRevision: riftboundRead }
    );
    return null;
  };
  const wait = () => new Promise((r) => setTimeout(r, 50));
  const view = await mount(() =>
    createElement(Probe, { game: "pokemon", revision: 5, active: true })
  );
  await wait();
  expect(pokemonSide.got).toEqual([{ revision: 5, game: "pokemon" }]);
  expect(riftboundSide.got).toEqual([]);

  // Switch game: the counter starts over, so a lower revision is still sent, and it carries the new game.
  await view.rerender(() =>
    createElement(Probe, { game: "riftbound", revision: 3, active: true })
  );
  await wait();
  expect(riftboundSide.got).toEqual([{ revision: 3, game: "riftbound" }]);
  expect(pokemonSide.got).toHaveLength(1);

  // Coming back to the shown Collection reads through the game's own reader.
  await view.rerender(() =>
    createElement(Probe, { game: "riftbound", revision: 3, active: false })
  );
  await view.rerender(() =>
    createElement(Probe, { game: "riftbound", revision: 3, active: true })
  );
  await wait();
  expect(riftboundRead).toHaveBeenCalled();
  expect(riftboundSide.got.at(-1)).toEqual({ revision: 4, game: "riftbound" });
  await view.unmount();
  pokemonSide.channel.close();
  riftboundSide.channel.close();
});
