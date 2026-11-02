import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { MoveLocks } from "./moveRecovery";
import { indexLocations } from "./locationTree";

// Small hook host: effects and state transitions run without a browser or a new test dependency.
const host = vi.hoisted(() => {
  const slots: unknown[] = [];
  const effects: (() => void)[] = [];
  let cursor = 0;
  type Memo = {
    value: unknown;
    deps?: readonly unknown[];
    cleanup?: () => void;
  };
  const same = (a?: readonly unknown[], b?: readonly unknown[]) =>
    !!a &&
    !!b &&
    a.length === b.length &&
    a.every((v, i) => Object.is(v, b[i]));
  return {
    begin() {
      cursor = 0;
    },
    flush() {
      for (const effect of effects.splice(0)) effect();
    },
    reset() {
      slots.length = 0;
      effects.length = 0;
      cursor = 0;
    },
    unmount() {
      for (const slot of slots)
        if (
          slot &&
          typeof slot === "object" &&
          "cleanup" in slot &&
          typeof slot.cleanup === "function"
        )
          slot.cleanup();
    },
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in slots))
        slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (v: unknown) => {
          slots[i] = typeof v === "function" ? v(slots[i]) : v;
        },
      ];
    },
    useRef(initial: unknown) {
      const i = cursor++;
      return (slots[i] ??= { current: initial });
    },
    useMemo(fn: () => unknown, deps?: readonly unknown[]) {
      const i = cursor++,
        prior = slots[i] as Memo | undefined;
      if (prior && same(prior.deps, deps)) return prior.value;
      const value = fn();
      slots[i] = { value, deps };
      return value;
    },
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) {
      const i = cursor++,
        prior = slots[i] as Memo | undefined;
      if (prior && same(prior.deps, deps)) return;
      const next: Memo = { value: null, deps };
      slots[i] = next;
      effects.push(() => {
        prior?.cleanup?.();
        const cleanup = fn();
        if (cleanup) next.cleanup = cleanup;
      });
    },
  };
});
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: host.useState,
  useRef: host.useRef,
  useMemo: host.useMemo,
  useEffect: host.useEffect,
  useCallback: (fn: unknown, deps: unknown[]) => host.useMemo(() => fn, deps),
}));
vi.mock("./SelectionBar", () => ({ focusWorkspaceHeading: vi.fn() }));
vi.mock("../inventoryUndo", () => ({
  listUndo: vi.fn(),
  applyUndo: vi.fn(),
  dismissUndo: vi.fn(),
  removeInventory: vi.fn(),
}));
vi.mock("../moves_generated", async (original) => ({
  ...(await original<typeof import("../moves_generated")>()),
  startMove: vi.fn(),
  stageMove: vi.fn(),
  commitMove: vi.fn(),
  commitMoveWithoutUndo: vi.fn(),
}));
vi.mock("../collection_generated", async (original) => ({
  ...(await original<typeof import("../collection_generated")>()),
  moveBorrowedCopies: vi.fn(),
}));
import { useInventoryActions } from "./useInventoryActions";
import { listUndo } from "../inventoryUndo";
import {
  commitMoveWithoutUndo,
  startMove,
  stageMove,
} from "../moves_generated";
import { moveBorrowedCopies } from "../collection_generated";
import { pendingMoves } from "./pendingMove";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
const owned = [
  {
    source_id: "source",
    edition_id: "edition",
    quantity: "2",
    expected_version: 1,
  },
];
const borrowed = [
  {
    loan_id: "loan",
    edition_id: "edition",
    from_location_id: "source",
    quantity: "1",
  },
];
const older = {
  id: "older",
  action: "add" as const,
  source_id: null,
  destination_id: "source",
  source_count: 0,
  expires_at: "later",
};
let serverNow: number;
function testLocks(): MoveLocks {
  const held = new Set<string>();
  return {
    async request(
      name: string,
      _options: LockOptions,
      work: (lock: Lock | null) => Promise<unknown>
    ) {
      if (held.has(name)) return work(null);
      held.add(name);
      try {
        return await work({ name, mode: "exclusive" });
      } finally {
        held.delete(name);
      }
    },
    async query() {
      return {
        held: [...held].map((name) => ({ name, mode: "exclusive" as const })),
        pending: [],
      };
    },
  } as unknown as MoveLocks;
}
function sessionResponse(userId = "A") {
  return Response.json(
    { signedIn: true, userId },
    { headers: { date: new Date(serverNow).toUTCString() } }
  );
}
let disk: Storage, witness: Storage;
function options(userId = "A"): Parameters<typeof useInventoryActions>[0] {
  return {
    userId,
    selection: {
      selected: new Map([
        [
          "source:edition",
          {
            key: "source:edition",
            loanId: null,
            locationId: "source",
            editionId: "edition",
            version: 1,
            runs: [[0, 2]],
            count: 2,
          },
        ],
      ]),
      summary: { copies: 3, editions: 1, locations: 1, borrowed: 1 },
      inspected: null,
      details: null,
      selectMode: false,
      setSelectMode: vi.fn(),
      activate: vi.fn(),
      marquee: vi.fn(),
      openDetails: vi.fn(),
      closeDetails: vi.fn(),
      dropBorrowed: vi.fn(),
      clear: vi.fn(),
    },
    holdings: [],
    byKey: new Map(),
    status: "ready",
    index: indexLocations([]),
    reloadGallery: vi.fn(),
    reloadTree: vi.fn(),
  };
}
function render(opts: ReturnType<typeof options>) {
  host.begin();
  const value = useInventoryActions(opts);
  host.flush();
  return value;
}
beforeEach(() => {
  host.reset();
  vi.clearAllMocks();
  serverNow = Date.parse("2026-10-31T20:00:00Z");
  vi.stubGlobal("navigator", { locks: testLocks() });
  disk = storage();
  witness = storage();
  vi.stubGlobal("localStorage", disk);
  vi.stubGlobal("sessionStorage", witness);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  });
  vi.stubGlobal("document", { activeElement: null, body: {} });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sessionResponse())
  );
  vi.mocked(listUndo).mockResolvedValue([older]);
  vi.mocked(moveBorrowedCopies).mockResolvedValue({
    copy_count: "1",
    owner_revision: 2,
  });
  vi.mocked(startMove).mockResolvedValue({
    id: "manifest",
    source_id: null,
    item_count: 0,
    expires_at: "later",
  });
  vi.mocked(stageMove).mockResolvedValue({
    id: "manifest",
    source_id: null,
    item_count: 1,
    expires_at: "later",
  });
  vi.mocked(commitMoveWithoutUndo).mockRejectedValue(
    new TypeError("lost response")
  );
});
afterEach(() => {
  host.unmount();
  vi.unstubAllGlobals();
});

test("an older Undo cannot leak into a mixed failure after an empty refresh, and Check Move works without selection", async () => {
  let opts = options(),
    actions = render(opts);
  await actions.added({
    locationId: "source",
    path: "Box",
    copies: 1,
    items: [],
    ownerRevision: 1,
    undoId: "older",
    from: "bar",
  });
  actions = render(opts);
  expect(actions.toast?.entry?.id).toBe("older");
  await actions.dropMove("dest", { groups: owned, borrowed });
  opts = {
    ...opts,
    holdings: [],
    byKey: new Map(),
    selection: {
      ...opts.selection,
      summary: { ...opts.selection.summary, copies: 0 },
    },
  };
  render(opts);
  actions = render(opts);
  expect(actions.toast?.message).toContain(
    "Moving your own copies may not have finished"
  );
  expect(actions.toast?.entry).toBeNull();
  expect(actions.toast?.unavailable).toBe(false);
  expect(actions.pending?.text).toContain("Moved 1 borrowed copy");
  vi.mocked(commitMoveWithoutUndo).mockResolvedValue({
    copy_count: "2",
    edition_count: 1,
    source_count: 1,
    already_at_destination_count: "0",
    owner_revision: 3,
    undo_id: null,
  });
  await actions.checkPending();
  expect(vi.mocked(commitMoveWithoutUndo).mock.calls[0]).toEqual(
    vi.mocked(commitMoveWithoutUndo).mock.calls[1]
  );
  expect(startMove).toHaveBeenCalledTimes(1);
  expect(moveBorrowedCopies).toHaveBeenCalledTimes(1);
  actions = render(opts);
  expect(actions.pending).toBeNull();
  expect(actions.toast?.entry).toBeNull();
});

test("sign-out invalidates a late borrowed response before owned preparation; B cannot see or resume A", async () => {
  let resolve!: (value: { copy_count: string; owner_revision: number }) => void;
  vi.mocked(moveBorrowedCopies).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  const opts = options(),
    actions = render(opts);
  const running = actions.dropMove("dest", { groups: owned, borrowed });
  // Reach the borrowed request after its durable checkpoint and account preflight.
  for (let i = 0; i < 20 && !resolve; i++) await Promise.resolve();
  expect(moveBorrowedCopies).toHaveBeenCalledTimes(1);
  host.unmount();
  host.reset();
  const b = render(options("B"));
  expect(b.pending).toBeNull();
  resolve({ copy_count: "1", owner_revision: 2 });
  await running;
  expect(startMove).not.toHaveBeenCalled();
  expect(commitMoveWithoutUndo).not.toHaveBeenCalled();
  expect(opts.selection.dropBorrowed).not.toHaveBeenCalled();
  expect(pendingMoves("B").load()).toBeNull();
  expect(pendingMoves("A").load()?.state.borrowed).toBe("unknown");
});

test("reload restores confirmed borrowed progress and reuses the original owned key", async () => {
  const opts = options();
  await render(opts).dropMove("dest", { groups: owned, borrowed });
  const first = vi.mocked(commitMoveWithoutUndo).mock.calls[0];
  host.unmount();
  host.reset();
  let actions = render({
    ...opts,
    selection: {
      ...opts.selection,
      summary: { ...opts.selection.summary, copies: 0 },
    },
  });
  expect(actions.pending?.text).toContain("Moved 1 borrowed copy");
  vi.mocked(commitMoveWithoutUndo).mockResolvedValue({
    copy_count: "2",
    edition_count: 1,
    source_count: 1,
    already_at_destination_count: "0",
    owner_revision: 3,
    undo_id: null,
  });
  await actions.checkPending();
  expect(vi.mocked(commitMoveWithoutUndo).mock.calls[1]).toEqual(first);
  expect(startMove).toHaveBeenCalledTimes(1);
  expect(moveBorrowedCopies).toHaveBeenCalledTimes(1);
});

test("account mismatch at preflight sends no inventory request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => sessionResponse("B"))
  );
  const opts = options();
  await render(opts).dropMove("dest", { groups: owned, borrowed });
  expect(moveBorrowedCopies).not.toHaveBeenCalled();
  expect(startMove).not.toHaveBeenCalled();
  expect(render(opts).pending?.blocked).toBe(true);
});

test("storage unavailable fails closed before any mixed-operation POST", async () => {
  vi.stubGlobal("localStorage", undefined);
  const opts = options(),
    actions = render(opts);
  expect(actions.pending?.blocked).toBe(true);
  await actions.dropMove("dest", { groups: owned, borrowed });
  expect(moveBorrowedCopies).not.toHaveBeenCalled();
  expect(startMove).not.toHaveBeenCalled();
});

test("erasing a live record blocks retry and allows dismissal only after explicit review", async () => {
  const opts = options();
  await render(opts).dropMove("dest", { groups: owned, borrowed });
  const first = vi.mocked(commitMoveWithoutUndo).mock.calls[0];
  disk.clear();
  await render(opts).checkPending();
  let actions = render(opts);
  expect(actions.pending?.blocked).toBe(true);
  expect(commitMoveWithoutUndo).toHaveBeenCalledTimes(1);
  await actions.dismissPending(false);
  actions = render(opts);
  expect(actions.pending).not.toBeNull();
  await actions.dismissPending(true);
  actions = render(opts);
  expect(actions.pending).toBeNull();
  expect(commitMoveWithoutUndo).toHaveBeenCalledExactlyOnceWith(...first);
});

test("changing accounts in place hides A's recovery before rendering B's actions", async () => {
  const opts = options();
  await render(opts).dropMove("dest", { groups: owned, borrowed });
  expect(render(opts).pending).not.toBeNull();
  expect(render(options("B")).pending).toBeNull();
  const b = render(options("B"));
  await b.checkPending();
  expect(commitMoveWithoutUndo).toHaveBeenCalledTimes(1);
  expect(pendingMoves("A").load()?.state.owned).toBe("unknown");
});

test("restored expired recovery has no retry and can be dismissed only after review", async () => {
  const { createOperation, PENDING_MOVE_MAX_AGE_MS } =
    await import("./moveOperation");
  const held = createOperation("dest", owned, borrowed, serverNow);
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  held.state.manifestId = "original";
  held.state.staged = true;
  held.state.ownedAttempted = true;
  held.state.owned = "unknown";
  pendingMoves("A").save(held);
  serverNow += PENDING_MOVE_MAX_AGE_MS;
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(held.op.createdAt - 24 * 60 * 60 * 1000);
  try {
    const opts = options();
    let actions = render(opts);
    expect(actions.pending?.text).toContain("Moved 1 borrowed copy");
    await actions.checkPending();
    actions = render(opts);
    expect(actions.pending?.blocked).toBe(true);
    expect(commitMoveWithoutUndo).not.toHaveBeenCalled();
    expect(pendingMoves("A").load()?.op.ownedKey).toBe(held.op.ownedKey);
    await actions.dismissPending(false);
    expect(render(opts).pending).not.toBeNull();
    await actions.dismissPending(true);
    actions = render(opts);
    expect(actions.pending).toBeNull();
    expect(startMove).not.toHaveBeenCalled();
    expect(moveBorrowedCopies).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});

test("another tab's writer blocks normal Moves as well as mixed Moves, and adoption re-reads its manifest", async () => {
  const { withMoveWriter } = await import("./moveRecovery");
  const { createOperation } = await import("./moveOperation");
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = createOperation("dest", owned, borrowed, serverNow);
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  held.state.manifestId = "original";
  held.state.staged = true;
  held.state.ownedAttempted = true;
  held.state.owned = "unknown";
  held.state.ownedFirstAttempt = "first";
  held.state.ownedAttempt = "first";
  const owner = withMoveWriter("A", async () => {
    pendingMoves("A").save(held);
    entered();
    await waiting;
  });
  await ready;
  const opts = options();
  let actions = render(opts);
  await actions.dropMove("different-dest", { groups: owned, borrowed: [] });
  actions = render(opts);
  expect(actions.pending?.otherTab).toBe(true);
  expect(actions.pending?.text).toContain("in progress in another tab");
  expect(actions.pending?.text).toContain("Moved 1 borrowed copy");
  expect(startMove).not.toHaveBeenCalled();
  expect(commitMoveWithoutUndo).not.toHaveBeenCalled();
  release();
  await owner;
  await actions.refreshPending();
  actions = render(opts);
  expect(actions.pending?.otherTab).toBe(false);
  vi.mocked(commitMoveWithoutUndo).mockResolvedValue({
    copy_count: "2",
    edition_count: 1,
    source_count: 1,
    already_at_destination_count: "0",
    owner_revision: 3,
    undo_id: null,
  });
  await actions.checkPending();
  expect(commitMoveWithoutUndo).toHaveBeenCalledExactlyOnceWith(
    "original",
    "dest",
    held.op.ownedKey
  );
  expect(startMove).not.toHaveBeenCalled();
});

test("mixed Moves fail closed without Web Locks", async () => {
  vi.stubGlobal("navigator", {});
  const opts = options();
  await render(opts).dropMove("dest", { groups: owned, borrowed });
  expect(render(opts).pending?.blocked).toBe(true);
  expect(moveBorrowedCopies).not.toHaveBeenCalled();
  expect(startMove).not.toHaveBeenCalled();
  expect(pendingMoves("A").load()).toBeNull();
});

test("missing server Date blocks creation before any inventory POST", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ signedIn: true, userId: "A" }))
  );
  const opts = options();
  await render(opts).dropMove("dest", { groups: owned, borrowed });
  expect(render(opts).pending?.blocked).toBe(true);
  expect(moveBorrowedCopies).not.toHaveBeenCalled();
  expect(startMove).not.toHaveBeenCalled();
});

test("a stale unreadable-data review cannot dismiss a different operation published by another writer", async () => {
  const { withMoveWriter } = await import("./moveRecovery");
  const { createOperation } = await import("./moveOperation");
  const { pendingMovePrefix } = await import("./pendingMove");
  disk.setItem(pendingMovePrefix("A") + "broken", "{");
  const opts = options(),
    actions = render(opts);
  expect(actions.pending?.blocked).toBe(true);
  const held = createOperation("dest", owned, borrowed, serverNow);
  await withMoveWriter("A", async () => {
    const store = pendingMoves("A");
    store.dismissUnreadable(serverNow);
    store.save(held);
  });
  await actions.dismissPending(true);
  expect(pendingMoves("A").load()?.op.id).toBe(held.op.id);
  expect(render(opts).pending?.id).toBe(held.op.id);
});

test("another tab's terminal receipt clears the old uncertainty message as well as the witness", async () => {
  const { withMoveWriter } = await import("./moveRecovery");
  let opts = options(),
    actions = render(opts);
  await actions.dropMove("dest", { groups: owned, borrowed });
  opts = {
    ...opts,
    holdings: [],
    byKey: new Map(),
    selection: {
      ...opts.selection,
      summary: { ...opts.selection.summary, copies: 0 },
    },
  };
  render(opts);
  actions = render(opts);
  expect(actions.toast?.message).toContain("may not have finished");
  await withMoveWriter("A", async () => {
    const witness = storage(),
      other = pendingMoves("A", disk, witness),
      latest = other.load()!;
    latest.state.owned = "done";
    latest.state.ownedResult = {
      copy_count: "2",
      edition_count: 1,
      source_count: 1,
      already_at_destination_count: "0",
      owner_revision: 3,
      undo_id: null,
    };
    other.save(latest);
    other.remove(latest, "done", serverNow);
  });
  await actions.refreshPending();
  actions = render(opts);
  expect(actions.pending).toBeNull();
  expect(actions.toast?.message).toBe("Move checking finished in another tab.");
  expect(actions.toast?.entry).toBeNull();
  expect(pendingMoves("A").load()).toBeNull();
});

test("a refused normal drag Move focuses Actions before the refreshed tile unmounts", async () => {
  const { commitMove, MoveError } = await import("../moves_generated");
  vi.mocked(commitMove).mockRejectedValue(new MoveError(409, "STALE_HOLDING"));
  const focus = vi.fn(),
    opts = options();
  vi.stubGlobal("document", {
    activeElement: { closest: () => ({}) },
    body: {},
  });
  const actions = render(opts);
  actions.actionsButton.current = {
    isConnected: true,
    focus,
  } as unknown as HTMLButtonElement;
  await actions.dropMove("dest", { groups: owned, borrowed: [] });
  expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  expect(focus.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(opts.reloadGallery).mock.invocationCallOrder[0]
  );
  expect(render(opts).barError).toContain("Nothing moved.");
});
