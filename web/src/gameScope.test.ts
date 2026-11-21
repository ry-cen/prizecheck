// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  announceDeckListChanged,
  deckListChangedEvent,
  useDeckListChanged,
} from "./decks/deckListChanged";
import {
  AddQueueAccount,
  hasStoredAddQueue,
  forgetAddQueues,
  useStoredAddQueue,
} from "./catalog/useStoredAddQueue";
import { GAME_IDS, scopedPrefix, useFixedGame, type GameId } from "./gameScope";
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
import {
  Component,
  StrictMode,
  Suspense,
  createElement,
  startTransition,
  useLayoutEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { act } from "react";

vi.mock("./catalog_browse_generated", () => ({ browseEditions: vi.fn() }));
vi.mock("./location_generated", () => ({ getLocationTree: vi.fn() }));

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
  expect(deckListChangedEvent()).toBe("prizecheck:deck-list-changed");
  expect(deckListChangedEvent("pokemon")).toBe("prizecheck:deck-list-changed");
  expect(ownerRevisionChannelName("u1", "riftbound")).toBe(
    "prizecheck:riftbound:owner-revision:u1"
  );
  expect(deckListChangedEvent("riftbound")).toBe(
    "prizecheck:riftbound:deck-list-changed"
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
  expect(deckListChangedEvent(other)).not.toBe(deckListChangedEvent());
  // A user id that looks like a game prefix cannot reach the other game's channel.
  expect(ownerRevisionChannelName("riftbound:x")).not.toBe(
    ownerRevisionChannelName("x", "riftbound")
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

test("an account change clears every game's other-account queues, and one game's mount-time clear spares the other's", () => {
  sessionStorage.setItem("prizecheck:add-queue:a:page", "p");
  sessionStorage.setItem("prizecheck:riftbound:add-queue:b:page", "r");
  forgetAddQueues("a", ["pokemon"]);
  expect(sessionStorage.getItem("prizecheck:add-queue:a:page")).toBe("p");
  expect(sessionStorage.getItem("prizecheck:riftbound:add-queue:b:page")).toBe(
    "r"
  );
  forgetAddQueues("c", ["riftbound"]);
  expect(sessionStorage.getItem("prizecheck:add-queue:a:page")).toBe("p");
  expect(
    sessionStorage.getItem("prizecheck:riftbound:add-queue:b:page")
  ).toBeNull();
  forgetAddQueues("c");
  expect(sessionStorage.getItem("prizecheck:add-queue:a:page")).toBeNull();
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
  // A game tag that is present must name the receiver's own game; absence alone means Pokémon.
  for (const game of [null, undefined, 0, 1, "", "Pokemon", {}, "riftbound"])
    expect(sharedRevision({ revision: 7, game }, "pokemon")).toBeNull();
  expect(sharedRevision({ revision: 7, game: null }, "riftbound")).toBeNull();
  // Primitives and arrays are ignored, never thrown on, as they were before game tags existed.
  for (const payload of [
    "invalid message",
    "",
    7,
    0,
    true,
    false,
    undefined,
    [7],
    [{ revision: 7 }],
  ]) {
    expect(() => sharedRevision(payload)).not.toThrow();
    expect(sharedRevision(payload)).toBeNull();
    expect(sharedRevision(payload, "riftbound")).toBeNull();
  }
  expect(sharedRevision({ revision: 7, game: "pokemon" })).toBe(7);
  expect(sharedRevision({ revision: 0 })).toBeNull();
  expect(sharedRevision(null)).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------
// One game per hook instance: a switch is a keyed remount, and a mismatched render throws before it writes.
// ---------------------------------------------------------------------------------------------------------------

let caught: Error | null = null;
class Boundary extends Component<
  { children?: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    caught = error;
    return { error };
  }
  render() {
    return this.state.error ? null : this.props.children;
  }
}

let held: Promise<void> | null = null;
let release: () => void = () => {};
let suspendedRenders = 0;
function hold() {
  held = new Promise<void>((resolve) => {
    release = () => {
      held = null;
      resolve();
    };
  });
}
function Gate({ game }: { game: GameId }) {
  if (game === "riftbound" && held) {
    suspendedRenders++;
    throw held;
  }
  return null;
}
const sleep = (ms = 50) => new Promise((r) => setTimeout(r, ms));
async function until(done: () => boolean, ms = 3000) {
  for (let waited = 0; !done() && waited < ms; waited += 20) await sleep(20);
}

type Extra = { active: boolean };
/** Mounts `Owner` for Pokémon; `switchTo` shows Riftbound, keyed (`key={game}`) or not. */
function harness(
  Owner: ComponentType<{ game: GameId; active?: boolean }>,
  mode: "keyed" | "unkeyed",
  gated: boolean,
  wrap: (children: ReactNode) => ReactNode = (children) => children
) {
  let setGameRaw!: (g: GameId) => void;
  let setExtraRaw!: (e: Extra) => void;
  function App() {
    const [game, setGame] = useState<GameId>("pokemon");
    const [extra, setExtra] = useState<Extra>({ active: true });
    setGameRaw = setGame;
    setExtraRaw = setExtra;
    const props = { game, active: extra.active };
    return wrap(
      createElement(
        Boundary,
        null,
        createElement(
          Suspense,
          { fallback: null },
          createElement(
            Owner,
            mode === "keyed" ? { key: game, ...props } : props
          ),
          gated ? createElement(Gate, { game }) : null
        )
      )
    );
  }
  const root = createRoot(document.createElement("div"));
  return {
    mount: () => act(async () => root.render(createElement(App))),
    /** A transition switch stays pending while the gate holds it. */
    switchTo: async (g: GameId, transition = false) => {
      if (transition) act(() => startTransition(() => setGameRaw(g)));
      else await act(async () => setGameRaw(g));
    },
    /** Commits the switch synchronously, ahead of any transition already queued. */
    switchSync: (g: GameId) => flushSync(() => setGameRaw(g)),
    setActive: (active: boolean) => act(async () => setExtraRaw({ active })),
    unmount: () => act(async () => root.unmount()),
  };
}

type Committed = {
  game: GameId;
  stale?: boolean;
  sort?: string;
  prices?: boolean;
};
let committed: Committed[] = [];
const MODES = ["keyed", "unkeyed"] as const;

const baseStale = {
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
const cfg = {
  pokemonRev: 5,
  riftboundRev: 3,
  idle: false,
  pokemonRead: vi.fn(async () => ({ owner_revision: 5 })),
  riftboundRead: vi.fn(async () => ({ owner_revision: 3 })),
  pokemonRefresh: vi.fn(() => true),
  riftboundRefresh: vi.fn(() => true),
  pokemonCb: vi.fn(),
  riftboundCb: vi.fn(),
};

function PrefsOwner({ game }: { game: GameId }) {
  const [prefs] = useGalleryPrefs("u1", game);
  useLayoutEffect(() => {
    committed.push({
      game,
      sort: prefs.sort,
      prices: prefs.display.prices,
    });
  });
  return null;
}
function StaleOwner({
  game,
  active = true,
}: {
  game: GameId;
  active?: boolean;
}) {
  const rev = game === "pokemon" ? cfg.pokemonRev : cfg.riftboundRev;
  const common = {
    ...baseStale,
    galleryRevision: rev,
    treeRevision: rev,
    active,
    idle: cfg.idle,
  };
  const { stale } = useStaleCollection(
    game === "pokemon"
      ? {
          ...common,
          game,
          readRevision: cfg.pokemonRead,
          refreshGallery: cfg.pokemonRefresh,
        }
      : {
          ...common,
          game,
          readRevision: cfg.riftboundRead,
          refreshGallery: cfg.riftboundRefresh,
        }
  );
  useLayoutEffect(() => {
    committed.push({ game, stale });
  });
  return null;
}
function DeckOwner({ game }: { game: GameId }) {
  useDeckListChanged(
    "d1",
    game === "pokemon" ? cfg.pokemonCb : cfg.riftboundCb,
    game
  );
  return null;
}
function QueueOwner({ game }: { game: GameId }) {
  useStoredAddQueue("page", game);
  return null;
}
const withAccount = (children: ReactNode) =>
  createElement(AddQueueAccount.Provider, { value: "a" }, children);

function listen(name: string) {
  const got: unknown[] = [];
  const channel = new BroadcastChannel(name);
  channel.onmessage = (e) => got.push(e.data);
  return { got, channel };
}

const PREFS = {
  pokemon: JSON.stringify({ sort: "set-desc", display: { names: true } }),
  riftbound: JSON.stringify({
    sort: "quantity-desc",
    display: { prices: true },
  }),
};

beforeEach(() => {
  caught = null;
  held = null;
  suspendedRenders = 0;
  committed = [];
  localStorage.clear();
  sessionStorage.clear();
  cfg.pokemonRev = 5;
  cfg.riftboundRev = 3;
  cfg.idle = false;
  for (const fn of [
    cfg.pokemonRead,
    cfg.riftboundRead,
    cfg.pokemonRefresh,
    cfg.riftboundRefresh,
    cfg.pokemonCb,
    cfg.riftboundCb,
  ])
    fn.mockClear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});
const quiet = () =>
  vi.spyOn(console, "error").mockImplementation(() => undefined);

test("useFixedGame keeps the first game and accepts the same game on every render", async () => {
  quiet();
  function Fixed({ game }: { game: GameId }) {
    useFixedGame(game, "useProbe");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = (game: GameId) =>
    act(async () =>
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Boundary, null, createElement(Fixed, { game }))
        )
      )
    );
  for (let i = 0; i < 3; i++) await render("pokemon");
  expect(caught).toBeNull();
  await render("riftbound");
  expect(caught?.message).toContain("useProbe");
  expect(caught?.message).toContain("key");
  await act(async () => root.unmount());
});

test.each([
  ["useGalleryPrefs", PrefsOwner],
  ["useStaleCollection", StaleOwner],
  ["useStoredAddQueue", QueueOwner],
  ["useDeckListChanged", DeckOwner],
] as const)(
  "a game change on a mounted %s instance never leaks",
  async (hook, Owner) => {
    quiet();
    localStorage.setItem(
      "prizecheck:riftbound:workspace-preferences:v1:u1",
      PREFS.riftbound
    );
    const rQueue = '{"items":[],"target":null,"uncertain":false}';
    sessionStorage.setItem("prizecheck:riftbound:add-queue:a:page", rQueue);
    const sets = vi.spyOn(Storage.prototype, "setItem");
    const side = listen(ownerRevisionChannelName("u1", "riftbound"));
    const events: unknown[] = [];
    const onRift = (e: Event) => events.push(e);
    window.addEventListener(deckListChangedEvent("riftbound"), onRift);
    const view = harness(Owner, "unkeyed", false, withAccount);
    await view.mount();
    sets.mockClear();
    await view.switchTo("riftbound");
    await sleep();
    window.dispatchEvent(new Event("focus"));
    announceDeckListChanged("d1");
    await sleep();
    expect(
      localStorage.getItem("prizecheck:riftbound:workspace-preferences:v1:u1")
    ).toBe(PREFS.riftbound);
    expect(
      sessionStorage.getItem("prizecheck:riftbound:add-queue:a:page")
    ).toBe(rQueue);
    expect(
      sets.mock.calls.filter(([k]) =>
        String(k).startsWith("prizecheck:riftbound:")
      )
    ).toEqual([]);
    expect(side.got).toEqual([]);
    expect(cfg.riftboundRead).not.toHaveBeenCalled();
    expect(cfg.riftboundRefresh).not.toHaveBeenCalled();
    expect(cfg.riftboundCb).not.toHaveBeenCalled();
    expect(cfg.pokemonCb).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(caught?.message).toContain(hook);
    window.removeEventListener(deckListChangedEvent("riftbound"), onRift);
    side.channel.close();
    await view.unmount();
  }
);

test.each(MODES)(
  "R1-1 a game switch never writes one game's preferences under the other's key (%s)",
  async (mode) => {
    quiet();
    localStorage.setItem(
      "prizecheck:workspace:preferences:v1:u1",
      PREFS.pokemon
    );
    localStorage.setItem(
      "prizecheck:riftbound:workspace-preferences:v1:u1",
      PREFS.riftbound
    );
    const view = harness(PrefsOwner, mode, false);
    await view.mount();
    await view.switchTo("riftbound");
    await sleep();
    const pokemon = JSON.parse(
      localStorage.getItem("prizecheck:workspace:preferences:v1:u1")!
    );
    const riftbound = localStorage.getItem(
      "prizecheck:riftbound:workspace-preferences:v1:u1"
    )!;
    if (mode === "keyed") {
      const rift = committed.filter((c) => c.game === "riftbound");
      expect(rift.length).toBeGreaterThan(0);
      expect(rift.every((c) => c.sort === "quantity-desc" && c.prices)).toBe(
        true
      );
      expect(JSON.parse(riftbound).sort).toBe("quantity-desc");
      expect(JSON.parse(riftbound).display.prices).toBe(true);
      expect(JSON.parse(riftbound).display.names).toBe(false);
      expect(pokemon.sort).toBe("set-desc");
      expect(pokemon.display.names).toBe(true);
    } else {
      expect(riftbound).toBe(PREFS.riftbound);
      expect(caught?.message).toContain("useGalleryPrefs");
    }
    await view.unmount();
  }
);

test.each(MODES)(
  "R1-2 the revision sender, its counter and its probe belong to the instance's game (%s)",
  async (mode) => {
    quiet();
    const pokemonSide = listen(ownerRevisionChannelName("u1", "pokemon"));
    const riftboundSide = listen(ownerRevisionChannelName("u1", "riftbound"));
    const view = harness(StaleOwner, mode, false);
    await view.mount();
    await sleep();
    expect(pokemonSide.got).toEqual([{ revision: 5 }]);
    await view.switchTo("riftbound");
    await sleep();
    cfg.pokemonRead.mockClear();
    cfg.riftboundRead.mockClear();
    window.dispatchEvent(new Event("focus"));
    await sleep();
    if (mode === "keyed") {
      expect(riftboundSide.got).toEqual([{ revision: 3, game: "riftbound" }]);
      expect(cfg.riftboundRead).toHaveBeenCalled();
      expect(cfg.pokemonRead).not.toHaveBeenCalled();
    } else {
      expect(riftboundSide.got).toEqual([]);
      expect(cfg.riftboundRead).not.toHaveBeenCalled();
      expect(caught?.message).toContain("useStaleCollection");
    }
    expect(pokemonSide.got).toEqual([{ revision: 5 }]);
    pokemonSide.channel.close();
    riftboundSide.channel.close();
    await view.unmount();
  }
);

test.each(MODES)(
  "R2-2 a focus probe during a suspended switch reads and sends only the visible game's revision (%s)",
  async (mode) => {
    quiet();
    cfg.riftboundRead.mockResolvedValue({ owner_revision: 99 });
    const pokemonSide = listen(ownerRevisionChannelName("u1", "pokemon"));
    const riftboundSide = listen(ownerRevisionChannelName("u1", "riftbound"));
    const view = harness(StaleOwner, mode, true);
    await view.mount();
    await sleep();
    hold();
    await view.switchTo("riftbound", true);
    await sleep();
    if (mode === "keyed") expect(suspendedRenders).toBeGreaterThan(0);
    else expect(caught).not.toBeNull();
    window.dispatchEvent(new Event("focus"));
    await sleep();
    expect(cfg.riftboundRead).not.toHaveBeenCalled();
    expect(riftboundSide.got).toEqual([]);
    expect(pokemonSide.got.some((m) => (m as { game?: string }).game)).toBe(
      false
    );
    if (mode === "keyed") {
      expect(cfg.pokemonRead).toHaveBeenCalled();
      expect(pokemonSide.got).toEqual([{ revision: 5 }]);
    } else {
      expect(caught?.message).toContain("useStaleCollection");
    }
    release();
    await sleep();
    pokemonSide.channel.close();
    riftboundSide.channel.close();
    await view.unmount();
    cfg.riftboundRead.mockResolvedValue({ owner_revision: 3 });
  }
);

test("R2-3 after a switch the new game's banner shows a newer revision even with the old game's return probe pending (keyed)", async () => {
  cfg.pokemonRev = 3;
  cfg.riftboundRev = 3;
  cfg.idle = true;
  cfg.pokemonRead.mockImplementation(() => new Promise(() => {}));
  const view = harness(StaleOwner, "keyed", false);
  await view.mount();
  await view.setActive(false);
  await view.setActive(true); // the return probe starts and never answers
  await view.switchTo("riftbound");
  const side = new BroadcastChannel(
    ownerRevisionChannelName("u1", "riftbound")
  );
  await act(async () => {
    side.postMessage({ revision: 10, game: "riftbound" });
    await sleep();
  });
  const last = committed.filter((c) => c.game === "riftbound").at(-1);
  expect(last?.stale).toBe(true);
  side.close();
  await view.unmount();
  cfg.pokemonRead.mockImplementation(async () => ({ owner_revision: 5 }));
});

test.each(MODES)(
  "R3-1 resolving the visible game's return probe during a suspended switch refreshes only the visible game (%s)",
  async (mode) => {
    quiet();
    cfg.pokemonRev = 3;
    cfg.riftboundRev = 3;
    cfg.idle = true;
    let resolve!: (v: { owner_revision: number }) => void;
    cfg.pokemonRead.mockImplementation(() => new Promise((r) => (resolve = r)));
    const view = harness(StaleOwner, mode, true);
    await view.mount();
    await view.setActive(false);
    await view.setActive(true); // the return probe starts and waits
    hold();
    await view.switchTo("riftbound", true);
    await sleep();
    if (mode === "keyed") expect(suspendedRenders).toBeGreaterThan(0);
    else expect(caught).not.toBeNull();
    resolve({ owner_revision: 7 });
    await sleep();
    expect(cfg.riftboundRefresh).not.toHaveBeenCalled();
    if (mode === "keyed") expect(cfg.pokemonRefresh).toHaveBeenCalledTimes(1);
    release();
    await sleep();
    await view.unmount();
    cfg.pokemonRead.mockImplementation(async () => ({ owner_revision: 5 }));
  }
);

test.each(MODES)(
  "R3-2 a visible-game revision that arrives during a suspended switch never makes the next game stale (%s)",
  async (mode) => {
    quiet();
    cfg.pokemonRev = 3;
    cfg.riftboundRev = 3;
    cfg.pokemonRead.mockResolvedValue({ owner_revision: 3 });
    const riftboundSide = listen(ownerRevisionChannelName("u1", "riftbound"));
    const view = harness(StaleOwner, mode, true);
    await view.mount();
    await sleep();
    hold();
    await view.switchTo("riftbound", true);
    await sleep();
    if (mode === "keyed") expect(suspendedRenders).toBeGreaterThan(0);
    else expect(caught).not.toBeNull();
    const poster = new BroadcastChannel(ownerRevisionChannelName("u1"));
    poster.postMessage({ revision: 10 });
    await sleep();
    if (mode === "keyed") {
      expect(
        committed.some((c) => c.game === "pokemon" && c.stale === true)
      ).toBe(true);
    }
    release();
    await sleep();
    const rift = committed.filter((c) => c.game === "riftbound");
    expect(rift.some((c) => c.stale === true)).toBe(false);
    if (mode === "keyed") {
      expect(rift.length).toBeGreaterThan(0);
      expect(rift.at(-1)?.stale).toBe(false);
    } else {
      expect(caught?.message).toContain("useStaleCollection");
    }
    expect(
      riftboundSide.got.some((m) => (m as { revision: number }).revision === 10)
    ).toBe(false);
    poster.close();
    riftboundSide.channel.close();
    await view.unmount();
    cfg.pokemonRead.mockImplementation(async () => ({ owner_revision: 5 }));
  }
);

test.each(MODES)(
  "R3-3 a Deck event during a suspended switch with the same Deck ID reaches only the committed game's callback (%s)",
  async (mode) => {
    quiet();
    const view = harness(DeckOwner, mode, true);
    await view.mount();
    hold();
    await view.switchTo("riftbound", true);
    await sleep();
    if (mode === "keyed") expect(suspendedRenders).toBeGreaterThan(0);
    else expect(caught).not.toBeNull();
    announceDeckListChanged("d1");
    expect(cfg.riftboundCb).not.toHaveBeenCalled();
    if (mode === "keyed") {
      expect(cfg.pokemonCb).toHaveBeenCalledTimes(1);
      release();
      await sleep();
      announceDeckListChanged("d1", "riftbound");
      expect(cfg.riftboundCb).toHaveBeenCalledTimes(1);
      announceDeckListChanged("d1");
      expect(cfg.pokemonCb).toHaveBeenCalledTimes(1);
    } else {
      release();
      await sleep();
      announceDeckListChanged("d1", "riftbound");
      expect(cfg.riftboundCb).not.toHaveBeenCalled();
      expect(caught?.message).toContain("useDeckListChanged");
    }
    await view.unmount();
  }
);

test("B-2 Pokémon posts the legacy revision message and Deck event", async () => {
  const pokemonSide = listen(ownerRevisionChannelName("u1", "pokemon"));
  const view = harness(StaleOwner, "keyed", false);
  await view.mount();
  await until(() => pokemonSide.got.length > 0);
  expect(pokemonSide.got).toHaveLength(1);
  const data = pokemonSide.got[0] as { revision: number };
  expect(Object.keys(data)).toEqual(["revision"]);
  expect(data.revision).toBe(5);
  pokemonSide.channel.close();
  await view.unmount();

  const seen: CustomEvent<unknown>[] = [];
  const spy = (e: Event) => seen.push(e as CustomEvent<unknown>);
  window.addEventListener("prizecheck:deck-list-changed", spy);
  announceDeckListChanged("d1");
  window.removeEventListener("prizecheck:deck-list-changed", spy);
  expect(seen).toHaveLength(1);
  expect(typeof seen[0].detail).toBe("string");
  expect(seen[0].detail).toBe("d1");

  // The browser spec's legacy dispatch still reaches a Pokémon listener.
  const deck = harness(DeckOwner, "keyed", false);
  await deck.mount();
  window.dispatchEvent(
    new CustomEvent("prizecheck:deck-list-changed", { detail: "d1" })
  );
  expect(cfg.pokemonCb).toHaveBeenCalledTimes(1);
  await deck.unmount();
});

test.each(MODES)(
  "R3-2b a revision queued in a transition for the visible game is never replayed onto the next game's instance (%s)",
  async (mode) => {
    quiet();
    const Original = globalThis.BroadcastChannel;
    const made: BroadcastChannel[] = [];
    class Spy extends Original {
      constructor(name: string) {
        super(name);
        made.push(this);
      }
    }
    vi.stubGlobal("BroadcastChannel", Spy);
    cfg.pokemonRev = 3;
    cfg.pokemonRead.mockResolvedValue({ owner_revision: 3 });
    const view = harness(StaleOwner, mode, false);
    await view.mount();
    await sleep();
    const pokemonChannel = made.find(
      (c) => c.name === ownerRevisionChannelName("u1")
    )!;
    // The Pokémon update is queued in a transition, then the Riftbound switch commits synchronously.
    startTransition(() => {
      pokemonChannel.onmessage?.({ data: { revision: 10 } } as MessageEvent);
    });
    view.switchSync("riftbound");
    await act(async () => {
      await sleep();
    });
    expect(
      committed.filter((c) => c.game === "riftbound").some((c) => c.stale)
    ).toBe(false);
    if (mode === "keyed")
      expect(committed.some((c) => c.game === "riftbound")).toBe(true);
    else
      expect((caught as Error | null)?.message).toContain("useStaleCollection");
    await view.unmount();
    vi.unstubAllGlobals();
    cfg.pokemonRead.mockImplementation(async () => ({ owner_revision: 5 }));
  }
);
