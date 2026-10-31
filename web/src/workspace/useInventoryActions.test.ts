import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
    vi.fn(async () => Response.json({ signedIn: true, userId: "A" }))
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
    vi.fn(async () => Response.json({ signedIn: true, userId: "B" }))
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
  actions.dismissPending(false);
  actions = render(opts);
  expect(actions.pending).not.toBeNull();
  actions.dismissPending(true);
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
  const held = createOperation("dest", owned, borrowed);
  held.state.borrowed = "done";
  held.state.borrowedResult = { copy_count: "1", owner_revision: 2 };
  held.state.manifestId = "original";
  held.state.staged = true;
  held.state.ownedAttempted = true;
  held.state.owned = "unknown";
  pendingMoves("A").save(held);
  const clock = vi
    .spyOn(Date, "now")
    .mockReturnValue(held.op.createdAt + PENDING_MOVE_MAX_AGE_MS);
  try {
    const opts = options();
    let actions = render(opts);
    expect(actions.pending?.blocked).toBe(true);
    expect(actions.pending?.text).toContain("Moved 1 borrowed copy");
    await actions.checkPending();
    expect(commitMoveWithoutUndo).not.toHaveBeenCalled();
    expect(pendingMoves("A").load()?.op.ownedKey).toBe(held.op.ownedKey);
    actions.dismissPending(false);
    expect(render(opts).pending).not.toBeNull();
    actions.dismissPending(true);
    actions = render(opts);
    expect(actions.pending).toBeNull();
    expect(startMove).not.toHaveBeenCalled();
    expect(moveBorrowedCopies).not.toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
