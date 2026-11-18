// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckBuilderPage, layoutInAddress } from "./DeckBuilderPage";
import {
  getDeck,
  setTargetFormat,
  DeckError,
  type DeckDetail,
  type DeckListCommandResult,
} from "../decks_generated";
import type { useDeckActions } from "./useDeckActions";
import type { TargetFormat } from "./targetFormat";
import type { useDeckListEdits } from "./useDeckListEdits";
import type { useDeckRename } from "./DeckRename";

const state = vi.hoisted(() => ({
  edits: null as Parameters<typeof useDeckListEdits>[0] | null,
  actions: null as Parameters<typeof useDeckActions>[0] | null,
  target: null as ((format: TargetFormat) => Promise<void>) | null,
  begin: null as (() => () => void) | null,
  coverReread: null as (() => Promise<unknown>) | null,
  rename: null as Parameters<typeof useDeckRename>[0] | null,
  listChanged: null as (() => void) | null,
  costChanged: null as (() => void) | null,
  gatherChanged: null as (() => void) | null,
  busy: false,
  editNotice: null as {
    id: number;
    text: string;
    retry: (() => void) | null;
  } | null,
}));
vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  getDeck: vi.fn(),
  setTargetFormat: vi.fn(),
}));
vi.mock("./useDeckListEdits", () => ({
  useDeckListEdits: (options: Parameters<typeof useDeckListEdits>[0]) => {
    state.edits = options;
    return {
      busy: state.busy,
      notice: state.editNotice,
      busyNow: () => state.busy,
      quantityOf: () => 0n,
      uncertainOf: () => 0n,
    };
  },
}));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "phone",
  useMediaQuery: () => false,
}));
vi.mock("./useDeckCover", () => ({
  useDeckCover: (options: {
    beginCommand: () => () => void;
    reread: () => Promise<unknown>;
  }) => {
    state.begin = options.beginCommand;
    state.coverReread = options.reread;
    return {
      busy: false,
      messageFor: () => "",
      toggle: async () => {},
      reset: () => {},
    };
  },
}));
vi.mock("./DeckRename", () => ({
  useDeckRename: (options: Parameters<typeof useDeckRename>[0]) => {
    state.rename = options;
    return {};
  },
}));
vi.mock("./useDeckActions", () => ({
  useDeckActions: (options: Parameters<typeof useDeckActions>[0]) => {
    state.actions = options;
    return {};
  },
}));
vi.mock("./TargetFormatControl", () => ({
  TargetFormatControl: (options: {
    onChange: (format: TargetFormat) => Promise<void>;
  }) => {
    state.target = options.onChange;
    return null;
  },
}));
vi.mock("./usePutAway", () => ({ usePutAway: () => ({}) }));
vi.mock("./useDeckDrag", () => ({
  useDeckDrag: () => ({}),
  dropLook: () => "",
  DeckDragBadge: () => null,
}));
vi.mock("./useDeckCost", () => ({
  useDeckCost: (
    _id: string,
    _revision: number,
    _owner: number,
    changed: () => void
  ) => {
    state.costChanged = changed;
    return null;
  },
  useCardsRevision: () => null,
}));
vi.mock("./useGatherToast", () => ({
  useGatherToast: (_name: string, changed: () => void) => {
    state.gatherChanged = changed;
    return () => {};
  },
}));
vi.mock("./deckListChanged", () => ({
  useDeckListChanged: (_id: string, changed: () => void) => {
    state.listChanged = changed;
  },
}));
vi.mock("./DeckListViews", () => ({ DeckListBody: () => null }));
vi.mock("./DeckLibrary", () => ({ DeckLibrary: () => null }));
vi.mock("./CopySheet", () => ({ CopySheet: () => null }));
vi.mock("./GatherDialog", () => ({ GatherDialog: () => null }));
vi.mock("./FormatResultsDialog", () => ({ FormatResultsDialog: () => null }));
vi.mock("./DeckWantListPanel", () => ({ DeckWantListPanel: () => null }));
vi.mock("./Surplus", () => ({
  CompetitionNotice: () => null,
  SurplusGroup: () => null,
}));

function detail(quantity: string, toGet = quantity): DeckDetail {
  return {
    deck: { id: "deck", name: "Weekend" },
    deck_list: {
      revision: Number(quantity),
      lines: [
        {
          edition_id: "energy",
          name: "Energy",
          quantity,
          in_deck: "0",
          descriptor: {},
          set_name: "Set",
          collector_number: "1",
        },
      ],
    },
    ownership: [],
    loans: [],
    competition: [],
    surplus: [],
    target_format: "standard",
    to_get: toGet,
  } as unknown as DeckDetail;
}
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

for (const outcome of ["delayed", "failed", "reconnect"] as const) {
  test(`does not explain a stale acquisition count during a ${outcome} follow-up read`, async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const initial = detail("2");
    let resolve!: (value: DeckDetail) => void;
    let reject!: (reason: Error) => void;
    const followup = new Promise<DeckDetail>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    vi.mocked(getDeck)
      .mockReset()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(followup);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root!.render(
        createElement(DeckBuilderPage, {
          deckId: "deck",
          address: "/decks/deck",
          onNavigate: () => {},
          onCloseCard: () => {},
          onAllDecks: () => {},
          onReplaceList: () => {},
          onWantList: () => {},
        })
      )
    );
    expect(host.textContent).toContain("Not owned2");
    const edited = detail("1");
    edited.deck_list.revision = 3;
    await act(async () => {
      state.edits!.onResult({
        deck_list: edited.deck_list,
        target_format: "standard",
      } as DeckListCommandResult);
      state.edits!.onSettled();
    });
    expect(host.textContent).toContain("Not owned1");
    expect(host.textContent).not.toContain("more copy:");
    if (outcome !== "delayed") {
      await act(async () => reject(new Error("offline")));
      expect(host.textContent).toContain("This Deck couldn't be loaded");
      expect(host.textContent).not.toContain("more copy:");
      const fresh = detail("1", "2");
      fresh.deck_list.revision = 3;
      vi.mocked(getDeck).mockResolvedValueOnce(fresh);
      if (outcome === "failed") {
        const retry = Array.from(host.querySelectorAll("button")).find(
          (button) => button.textContent === "Retry"
        );
        expect(retry).toBeDefined();
        await act(async () => retry!.click());
      } else {
        await act(async () => window.dispatchEvent(new Event("online")));
      }
      expect(host.textContent).not.toContain("This Deck couldn't be loaded");
      expect(host.textContent).toContain("counts 1 more copy:");
    } else {
      // Only a full read can restore the note, even when its legitimate difference is the same number.
      const fresh = detail("1", "2");
      fresh.deck_list.revision = 3;
      await act(async () => resolve(fresh));
      expect(host.textContent).toContain("counts 1 more copy:");
    }
    ready("2");
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fresh(revision: number, toGet = "1", quantity = "1") {
  const value = detail(quantity, toGet);
  value.deck_list.revision = revision;
  return value;
}
function command(revision = 3): DeckListCommandResult {
  return {
    deck_list: fresh(revision).deck_list,
    target_format: "expanded",
  } as DeckListCommandResult;
}
async function mount(initial = fresh(1, "2", "2")) {
  state.busy = false;
  state.editNotice = null;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.mocked(getDeck).mockReset().mockResolvedValueOnce(initial);
  vi.mocked(setTargetFormat).mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await renderPage();
  expect(state.actions!.countReady).toBe(true);
}
async function renderPage(
  address = "/decks/deck",
  onNavigate: (to: string, options?: object) => void = () => {}
) {
  await act(async () =>
    root!.render(
      createElement(DeckBuilderPage, {
        deckId: "deck",
        address,
        onNavigate,
        onCloseCard() {},
        onAllDecks() {},
        onReplaceList() {},
        onWantList() {},
      })
    )
  );
}
async function edit(revision = 2, quantity = "1") {
  await act(async () =>
    state.edits!.onResult({
      deck_list: fresh(revision, quantity, quantity).deck_list,
      target_format: "standard",
    } as DeckListCommandResult)
  );
}
async function heldEdit() {
  await mount();
  const held = deferred<DeckDetail>();
  vi.mocked(getDeck).mockReturnValueOnce(held.promise);
  await edit();
  await act(async () => state.edits!.onSettled());
  expect(state.actions!.countReady).toBe(false);
  return held;
}
function ready(toGet = "1") {
  expect(state.actions!.countReady).toBe(true);
  expect(state.actions!.detail!.to_get).toBe(toGet);
  expect(host.textContent).not.toContain("This Deck couldn't be loaded");
}
function retry() {
  const button = Array.from(host.querySelectorAll("button")).find(
    (item) => item.textContent === "Retry"
  );
  expect(button).toBeDefined();
  return button!;
}

for (const outcome of [
  "success",
  "late rejection",
  "network",
  "409",
  "404",
] as const) {
  const number = {
    success: "T1",
    "late rejection": "T2",
    network: "T3",
    "409": "T4",
    "404": "T5",
  }[outcome];
  test(`${number}: target ${outcome} settles a superseded edit read`, async () => {
    const held = await heldEdit();
    const target = deferred<DeckListCommandResult>();
    vi.mocked(setTargetFormat).mockReturnValueOnce(target.promise);
    vi.mocked(getDeck).mockResolvedValueOnce(fresh(3));
    let change!: Promise<void>;
    await act(async () => {
      change = state.target!("expanded");
    });
    await act(async () => {
      if (outcome === "network") target.reject(new Error("offline"));
      else if (outcome === "409" || outcome === "404")
        target.reject(new DeckError(Number(outcome), "refused"));
      else target.resolve(command());
      await change;
    });
    expect(getDeck).toHaveBeenCalledTimes(outcome === "404" ? 2 : 3);
    if (outcome === "404") expect(host.textContent).toContain("Deck not found");
    else ready();
    if (outcome === "network")
      expect(host.textContent).toContain(
        "The Target Format couldn't be changed"
      );
    await act(async () => {
      if (outcome === "late rejection") held.reject(new Error("late"));
      else held.resolve(fresh(2, "99"));
    });
    if (outcome !== "404") ready();
    expect(host.textContent).not.toContain("This Deck couldn't be loaded");
    // T10: a superseded rejection must not install online recovery.
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(getDeck).toHaveBeenCalledTimes(outcome === "404" ? 2 : 3);
  });
}

test("T6: target success recovers a failed read without hiding Retry in flight", async () => {
  const held = await heldEdit();
  await act(async () => held.reject(new Error("offline")));
  retry();
  const target = deferred<DeckListCommandResult>();
  vi.mocked(setTargetFormat).mockReturnValueOnce(target.promise);
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3));
  let change!: Promise<void>;
  await act(async () => {
    change = state.target!("expanded");
  });
  retry();
  expect(host.textContent).toContain("This Deck couldn't be loaded");
  await act(async () => {
    target.resolve(command());
    await change;
  });
  ready();
  expect(getDeck).toHaveBeenCalledTimes(3);
});

test("T7: cover settle replays a held edit read", async () => {
  const held = await heldEdit();
  const settle = state.begin!();
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(2));
  await act(async () => settle());
  ready();
  await act(async () => held.resolve(fresh(2, "99")));
  ready();
  expect(getDeck).toHaveBeenCalledTimes(3);
});

test("T8: a rapid newer edit waits for the queue's settled read", async () => {
  const held = await heldEdit();
  state.busy = true;
  await edit(3, "3");
  await act(async () => held.resolve(fresh(2, "99")));
  expect(state.actions!.countReady).toBe(false);
  expect(host.textContent).not.toContain("This Deck couldn't be loaded");
  state.busy = false;
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3, "3", "3"));
  await act(async () => state.edits!.onSettled());
  ready("3");
  expect(getDeck).toHaveBeenCalledTimes(3);
});

for (const source of [
  "listChanged",
  "costChanged",
  "gatherChanged",
  "actions",
] as const) {
  for (const fails of [false, true]) {
    test(`T9: ${source} invalidates the count and ${fails ? "recovers with Retry" : "settles"}`, async () => {
      await mount();
      const held = deferred<DeckDetail>();
      vi.mocked(getDeck).mockReturnValueOnce(held.promise);
      await act(async () =>
        source === "actions" ? state.actions!.read() : state[source]!()
      );
      expect(state.actions!.countReady).toBe(false);
      if (fails) {
        await act(async () => held.reject(new Error("offline")));
        expect(host.textContent).toContain("This Deck couldn't be loaded");
        vi.mocked(getDeck).mockResolvedValueOnce(fresh(2));
        await act(async () => retry().click());
      } else await act(async () => held.resolve(fresh(2)));
      ready();
      expect(getDeck).toHaveBeenCalledTimes(fails ? 3 : 2);
    });
  }
}

test("T11: recovery removes the online listener", async () => {
  const held = await heldEdit();
  await act(async () => held.reject(new Error("offline")));
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(2));
  await act(async () => window.dispatchEvent(new Event("online")));
  ready();
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(getDeck).toHaveBeenCalledTimes(3);
});

test("T12: overlapping commands settle in reverse order without blocking the newest read", async () => {
  const held = await heldEdit();
  const coverSettled = state.begin!();
  const target = deferred<DeckListCommandResult>();
  vi.mocked(setTargetFormat).mockReturnValueOnce(target.promise);
  const replacement = deferred<DeckDetail>();
  vi.mocked(getDeck).mockReturnValueOnce(replacement.promise);
  let change!: Promise<void>;
  await act(async () => {
    change = state.target!("expanded");
  });
  await act(async () => {
    target.resolve(command());
    await change;
  });
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3));
  await act(async () => coverSettled());
  ready();
  await act(async () => {
    replacement.resolve(fresh(3, "99"));
    held.resolve(fresh(2, "99"));
  });
  ready();
  expect(getDeck).toHaveBeenCalledTimes(4);
});

for (const fails of [false, true]) {
  test(`T13a: dropped GET waits for a busy edit${fails ? " including its network failure" : ""}`, async () => {
    const held = await heldEdit();
    const target = deferred<DeckListCommandResult>();
    vi.mocked(setTargetFormat).mockReturnValueOnce(target.promise);
    let change!: Promise<void>;
    await act(async () => {
      change = state.target!("expanded");
    });
    state.busy = true;
    if (fails)
      state.editNotice = {
        id: 1,
        text: "Your last Deck List change may not have been saved.",
        retry: () => {
          state.busy = false;
          state.editNotice = null;
          state.edits!.onSettled();
        },
      };
    await edit(3);
    await act(async () => {
      target.resolve(command());
      await change;
      held.resolve(fresh(2, "99"));
    });
    expect(getDeck).toHaveBeenCalledTimes(2);
    expect(state.actions!.countReady).toBe(false);
    expect(host.textContent).not.toContain("This Deck couldn't be loaded");
    if (fails) {
      // A failed send remains busy in the hook until its own Try again succeeds.
      await act(async () => window.dispatchEvent(new Event("online")));
      expect(getDeck).toHaveBeenCalledTimes(2);
      expect(state.actions!.countReady).toBe(false);
    }
    vi.mocked(getDeck).mockResolvedValueOnce(fresh(3));
    if (fails) {
      const again = Array.from(host.querySelectorAll("button")).find(
        (button) => button.textContent === "Try again"
      );
      expect(again).toBeDefined();
      await act(async () => again!.click());
    } else {
      state.busy = false;
      await act(async () => state.edits!.onSettled());
    }
    ready();
    expect(getDeck).toHaveBeenCalledTimes(3);
  });
}

test("T13c: busy with no dropped read and a known count needs no replay", async () => {
  await mount();
  const target = deferred<DeckListCommandResult>();
  vi.mocked(setTargetFormat).mockReturnValueOnce(target.promise);
  let change!: Promise<void>;
  await act(async () => {
    change = state.target!("expanded");
  });
  state.busy = true;
  await act(async () => {
    target.resolve({ ...command(), deck_list: fresh(3, "2", "2").deck_list });
    await change;
  });
  expect(getDeck).toHaveBeenCalledTimes(1);
  expect(state.actions!.countReady).toBe(false);
  state.busy = false;
  await renderPage();
  // A no-op transition redraws the hook but emits no dirty onSettled callback.
  ready("2");
  expect(getDeck).toHaveBeenCalledTimes(1);
});

test("T14: an idle lagging refresh shows Retry without automatically looping", async () => {
  await mount();
  await edit(3);
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3));
  await act(async () => state.edits!.onSettled());
  ready();
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(2, "99"));
  await act(async () => state.actions!.read());
  expect(state.actions!.countReady).toBe(false);
  expect(host.textContent).toContain("This Deck couldn't be loaded");
  retry();
  expect(getDeck).toHaveBeenCalledTimes(3);
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3));
  await act(async () => retry().click());
  ready();
  expect(getDeck).toHaveBeenCalledTimes(4);
});

test("T15: refused Undo refreshes an external change from 3 copies to 4", async () => {
  await mount(fresh(1, "3", "3"));
  const held = deferred<DeckDetail>();
  vi.mocked(getDeck).mockReturnValueOnce(held.promise);
  // A refused Undo produces no onResult, but the hook reports dirty server state.
  await act(async () => state.edits!.onSettled());
  expect(state.actions!.countReady).toBe(false);
  expect(host.textContent).toContain("Not owned3");
  expect(getDeck).toHaveBeenCalledTimes(2);
  await act(async () => held.resolve(fresh(2, "4", "4")));
  ready("4");
  expect(host.textContent).toContain("Not owned4");
  expect(getDeck).toHaveBeenCalledTimes(2);
});

// A re-read some command asked for because the server may have moved never keeps the old count (I4), and a notice
// says "up to date" only if the read really applied a Deck (I6). Every case starts from a known count.
async function known() {
  await mount();
  ready("2");
}
const SHORT_409 =
  "This Deck changed somewhere else, so its Target Format wasn't changed.";
const UP_TO_DATE =
  "This Deck changed somewhere else, so its Target Format wasn't changed. It's up to date now: try again.";
function statuses() {
  return Array.from(host.querySelectorAll('[role="status"]')).map(
    (item) => item.textContent
  );
}
function refuse409() {
  vi.mocked(setTargetFormat).mockRejectedValueOnce(
    new DeckError(409, "STALE_DECK_LIST")
  );
}
/** Starts a Target Format change that the server refuses; the next read is held, and the change is left pending. */
async function conflict() {
  await known();
  refuse409();
  const read = deferred<DeckDetail>();
  vi.mocked(getDeck).mockReturnValueOnce(read.promise);
  let change!: Promise<void>;
  await act(async () => {
    change = state.target!("expanded");
  });
  return { read, change: () => change };
}

test("T16: a 409 from a known count waits for its re-read, then says it is up to date", async () => {
  const { read, change } = await conflict();
  expect(state.actions!.countReady).toBe(false);
  expect(statuses().join("|")).not.toContain("up to date");
  await act(async () => {
    read.resolve(fresh(2, "3"));
    await change();
  });
  ready("3");
  expect(statuses()).toContain(UP_TO_DATE);
  expect(getDeck).toHaveBeenCalledTimes(2);
});

test("T17: a 409 whose re-read fails keeps the count unknown, offers Retry and never says up to date", async () => {
  const { read, change } = await conflict();
  expect(state.actions!.countReady).toBe(false);
  await act(async () => {
    read.reject(new Error("offline"));
    await change();
  });
  expect(state.actions!.countReady).toBe(false);
  expect(host.textContent).toContain("This Deck couldn't be loaded");
  expect(statuses()).toContain(SHORT_409);
  expect(host.textContent).not.toContain("up to date");
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(2, "3"));
  await act(async () => retry().click());
  ready("3");
  expect(getDeck).toHaveBeenCalledTimes(3);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(getDeck).toHaveBeenCalledTimes(3);
});

test("T18: a 409 whose re-read lags behind shows Retry, without looping", async () => {
  await known();
  await edit(3);
  state.busy = false;
  refuse409();
  const read = deferred<DeckDetail>();
  vi.mocked(getDeck).mockReturnValueOnce(read.promise);
  let change!: Promise<void>;
  await act(async () => {
    change = state.target!("expanded");
  });
  expect(state.actions!.countReady).toBe(false);
  await act(async () => {
    read.resolve(fresh(2, "99"));
    await change;
  });
  expect(state.actions!.countReady).toBe(false);
  expect(host.textContent).toContain("This Deck couldn't be loaded");
  expect(statuses()).toContain(SHORT_409);
  expect(host.textContent).not.toContain("up to date");
  expect(getDeck).toHaveBeenCalledTimes(2);
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3, "4"));
  await act(async () => retry().click());
  ready("4");
  expect(getDeck).toHaveBeenCalledTimes(3);
});

test("T19: a 409 re-read that a later command supersedes leaves the newest read to restore the count", async () => {
  const { read, change } = await conflict();
  const settle = state.begin!();
  vi.mocked(getDeck).mockResolvedValueOnce(fresh(3, "5"));
  await act(async () => settle());
  ready("5");
  expect(getDeck).toHaveBeenCalledTimes(3);
  await act(async () => {
    read.resolve(fresh(2, "99"));
    await change();
  });
  ready("5");
  expect(statuses()).toContain(SHORT_409);
  expect(host.textContent).not.toContain("up to date");
  expect(getDeck).toHaveBeenCalledTimes(3);
});

const rereads = {
  cover: () => state.coverReread!(),
  rename: () => state.rename!.reread(),
};
for (const source of ["cover", "rename"] as const) {
  const number = source === "cover" ? "T20" : "T21";
  for (const fails of [false, true]) {
    test(`${number}: the ${source} hook's re-read marks the count unknown and ${fails ? "shows Retry when it fails" : "restores it"}`, async () => {
      await known();
      const held = deferred<DeckDetail>();
      vi.mocked(getDeck).mockReturnValueOnce(held.promise);
      await act(async () => {
        void rereads[source]();
      });
      expect(state.actions!.countReady).toBe(false);
      if (fails) {
        await act(async () => held.reject(new Error("offline")));
        expect(state.actions!.countReady).toBe(false);
        expect(host.textContent).toContain("This Deck couldn't be loaded");
        vi.mocked(getDeck).mockResolvedValueOnce(fresh(2, "3"));
        await act(async () => retry().click());
      } else await act(async () => held.resolve(fresh(2, "3")));
      ready("3");
      expect(getDeck).toHaveBeenCalledTimes(fails ? 3 : 2);
    });
  }
}

test("T22: the edit queue's rebuild re-read marks the count unknown", async () => {
  await known();
  state.busy = false;
  vi.mocked(getDeck).mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await state.edits!.reread();
  });
  expect(state.actions!.countReady).toBe(false);
  retry();
  expect(getDeck).toHaveBeenCalledTimes(2);
});

// A new notice is announced through exactly one surface: the copy sheet's own line when the sheet was open as it
// arrived, else the page's banner. Whether the sheet is open later doesn't change that.
const SHEET = "/decks/deck?edition=energy";
const banner = () => host.querySelector("[data-edit-banner]");

test("a notice that arrives with the sheet closed is announced by the banner, and stays so while the sheet is open and after", async () => {
  await mount();
  state.editNotice = { id: 1, text: "Not saved.", retry: () => {} };
  await renderPage();
  expect(banner()?.getAttribute("role")).toBe("alert");
  await renderPage(SHEET);
  expect(banner()?.getAttribute("role")).toBe("alert");
  await renderPage();
  expect(banner()?.getAttribute("role")).toBe("alert");
});

test("a notice that arrives while the sheet is open is left to the sheet, and closing or reopening it never makes the banner announce", async () => {
  await mount();
  await renderPage(SHEET);
  state.editNotice = { id: 1, text: "Not saved.", retry: () => {} };
  await renderPage(SHEET);
  expect(banner()).not.toBeNull();
  expect(banner()!.hasAttribute("role")).toBe(false);
  await renderPage();
  expect(banner()!.hasAttribute("role")).toBe(false);
  await renderPage(SHEET);
  await renderPage();
  expect(banner()!.hasAttribute("role")).toBe(false);
});

test("the next notice is announced afresh: by the banner when the sheet is closed as it arrives", async () => {
  await mount();
  await renderPage(SHEET);
  state.editNotice = { id: 1, text: "Not saved.", retry: () => {} };
  await renderPage(SHEET);
  await renderPage();
  state.editNotice = null;
  await renderPage();
  expect(banner()).toBeNull();
  state.editNotice = { id: 2, text: "Not saved again.", retry: () => {} };
  await renderPage();
  expect(banner()!.getAttribute("role")).toBe("alert");
});

test("layoutInAddress reads only the three layouts", () => {
  expect(layoutInAddress("")).toBeNull();
  expect(layoutInAddress("?layout=list")).toBe("list");
  expect(layoutInAddress("?edition=e&layout=stacked")).toBe("stacked");
  expect(layoutInAddress("?layout=spread")).toBe("spread");
  expect(layoutInAddress("?layout=")).toBeNull();
  expect(layoutInAddress("?layout=LIST")).toBeNull();
  expect(layoutInAddress("?layout=grid")).toBeNull();
});

const checkedLayout = () =>
  host.querySelector('[role="radiogroup"] [role="radio"][aria-checked="true"]')
    ?.textContent;

test("the Deck List layout comes from the address, and a bad one reads as the default", async () => {
  await mount();
  await renderPage("/decks/deck?layout=list");
  expect(checkedLayout()).toBe("List");
  await renderPage("/decks/deck?layout=stacked");
  expect(checkedLayout()).toBe("Stacked");
  await renderPage("/decks/deck?layout=nonsense");
  expect(checkedLayout()).toBe("Spread");
  await renderPage("/decks/deck");
  expect(checkedLayout()).toBe("Spread");
});

test("picking a layout replaces the address, keeping the rest of it, and adds no history entry", async () => {
  await mount();
  const navigate = vi.fn();
  await renderPage("/decks/deck", navigate);
  const choose = (name: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(
      (radio) => radio.textContent === name
    )!;
  await act(async () => choose("List").click());
  expect(navigate).toHaveBeenLastCalledWith("/decks/deck?layout=list", {
    replace: true,
    preserveScroll: true,
  });
  await renderPage("/decks/deck?layout=list&edition=e&copy=2", navigate);
  await act(async () => choose("Stacked").click());
  expect(navigate).toHaveBeenLastCalledWith(
    "/decks/deck?layout=stacked&edition=e&copy=2",
    { replace: true, preserveScroll: true }
  );
  // The layout already shown is not written again.
  navigate.mockClear();
  await renderPage("/decks/deck?layout=list", navigate);
  await act(async () => choose("List").click());
  expect(navigate).not.toHaveBeenCalled();
});
