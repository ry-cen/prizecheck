// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  changeDeckList,
  DeckError,
  type DeckList,
  type DeckListCommandResult,
} from "../decks_generated";
import { useDeckListEdits, type DeckListEdit } from "./useDeckListEdits";

vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  changeDeckList: vi.fn(),
}));
const shown = vi.hoisted(() => vi.fn((_input: { announce?: boolean }) => 1));
const updated = vi.hoisted(() =>
  vi.fn(
    (
      _id: number,
      _input: { message: string; action?: { busy?: boolean } }
    ) => {}
  )
);
vi.mock("../ui/Toast", () => ({
  useToast: () => ({
    show: shown,
    update: updated,
    dismiss: () => {},
    focus: () => false,
  }),
}));

let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let edits!: ReturnType<typeof useDeckListEdits>;
beforeEach(() => {
  vi.mocked(changeDeckList).mockReset();
  shown.mockClear();
  updated.mockClear();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  vi.restoreAllMocks();
});

const STALE = new DeckError(409, "STALE_DECK_LIST");
const SHORT =
  "This Deck changed somewhere else, so your last change wasn't saved.";

function list(revision: number, quantity = "1"): DeckList {
  return {
    revision,
    lines: [{ edition_id: "energy", quantity }],
  } as unknown as DeckList;
}
const add: DeckListEdit = {
  deltas: new Map([["energy", 1n]]),
  names: new Map([["energy", "Energy"]]),
  message: "Added 1 Energy.",
};

async function mount(reread: () => Promise<DeckList | null>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const onSettled = vi.fn();
  function Harness() {
    edits = useDeckListEdits({
      deckId: "deck",
      deckList: list(1),
      onResult: () => {},
      onSettled,
      reread,
      onMissing: () => {},
    });
    return null;
  }
  await act(async () => root!.render(createElement(Harness)));
  return onSettled;
}

test("a refusal after the one rebuild says the change wasn't saved, without claiming the Deck is up to date", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(STALE);
  const reread = vi.fn().mockResolvedValue(list(2));
  await mount(reread);
  await act(async () => edits.edit(add));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(changeDeckList).toHaveBeenCalledTimes(2);
  expect(edits.notice?.text).toBe(SHORT);
  expect(edits.notice?.retry).toBeNull();
});

test("a refusal after a rebuild whose re-read failed says the same short text", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(STALE);
  const reread = vi.fn().mockResolvedValue(null);
  await mount(reread);
  await act(async () => edits.edit(add));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(edits.notice?.text).toBe(SHORT);
});

test("the first refusal rebuilds on the fresh Deck List and shows no notice", async () => {
  vi.mocked(changeDeckList)
    .mockRejectedValueOnce(STALE)
    .mockResolvedValueOnce({
      deck_list: list(3, "3"),
      target_format: "standard",
    } as unknown as DeckListCommandResult);
  const reread = vi.fn().mockResolvedValue(list(2, "2"));
  const settled = await mount(reread);
  await act(async () => edits.edit(add));
  expect(reread).toHaveBeenCalledTimes(1);
  expect(vi.mocked(changeDeckList).mock.calls[1][1]).toMatchObject({
    revision: 2,
    changes: [{ edition_id: "energy", quantity: "3" }],
  });
  expect(edits.notice).toBeNull();
  expect(settled).toHaveBeenCalledTimes(1);
});

const SAVED = {
  deck_list: list(2, "2"),
  target_format: "standard",
} as unknown as DeckListCommandResult;

test("quantityOf shows a change on its way, then the confirmed quantity while its outcome is unknown, then the saved one after Try again", async () => {
  let answer!: (reason: unknown) => void;
  vi.mocked(changeDeckList).mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        answer = reject;
      })
  );
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  // On its way: the collector's tap shows at once.
  expect(edits.quantityOf("energy")).toBe(2n);
  await act(async () => answer(new TypeError("Failed to fetch")));
  // No answer: nothing is confirmed, so the count is the confirmed one, and a Try again is waiting for the change.
  expect(edits.notice?.retry).toBeTypeOf("function");
  expect(edits.quantityOf("energy")).toBe(1n);
  expect(edits.uncertainOf("energy")).toBe(1n);
  expect(edits.uncertainOf("other")).toBe(0n);
  vi.mocked(changeDeckList).mockResolvedValueOnce(SAVED);
  await act(async () => edits.notice!.retry!());
  expect(vi.mocked(changeDeckList).mock.calls[1][1]).toEqual(
    vi.mocked(changeDeckList).mock.calls[0][1]
  );
  expect(edits.notice).toBeNull();
  expect(edits.quantityOf("energy")).toBe(2n);
  expect(edits.uncertainOf("energy")).toBe(0n);
});

test("a 5xx answer is just as unconfirmed: the count stays at the confirmed quantity", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(new DeckError(503, "DOWN"));
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  expect(edits.quantityOf("energy")).toBe(1n);
  expect(edits.notice?.retry).toBeTypeOf("function");
});

test("a tap made while a change is unconfirmed shows at once and doesn't hide the unconfirmed change", async () => {
  vi.mocked(changeDeckList).mockRejectedValueOnce(new TypeError("offline"));
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  await act(async () => edits.edit(add));
  // Confirmed 1, the unconfirmed +1 isn't counted, the new tap waits behind it and is.
  expect(edits.quantityOf("energy")).toBe(2n);
  expect(edits.uncertainOf("energy")).toBe(1n);
  expect(edits.notice?.retry).toBeTypeOf("function");
});

test("each new notice has its own id, and a notice keeps its id while it stays", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(new TypeError("offline"));
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  const first = edits.notice!;
  expect(first.id).toBeTypeOf("number");
  await act(async () => edits.edit(add));
  // A tap while the notice stays doesn't make it a new one.
  expect(edits.notice).toBe(first);
  expect(edits.notice!.id).toBe(first.id);
  // Try again that fails again is a new notice to announce.
  await act(async () => edits.notice!.retry!());
  expect(edits.notice).not.toBe(first);
  expect(edits.notice!.id).not.toBe(first.id);
});

test("a refusal's notice has an id too", async () => {
  vi.mocked(changeDeckList).mockRejectedValue(
    new DeckError(422, "EDITION_UNAVAILABLE")
  );
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  expect(edits.notice?.id).toBeTypeOf("number");
});

test("a saved change's toast announces, unless an open dialog's own feedback line already says it", async () => {
  vi.mocked(changeDeckList).mockResolvedValue(SAVED);
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  expect(shown).toHaveBeenCalledTimes(1);
  expect(shown.mock.calls[0][0].announce).toBe(true);

  // The card popup and the copy sheet draw EditFeedbackLine; the toast host is inert behind them.
  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  dialog.innerHTML = '<p role="status" data-edit-feedback></p>';
  document.body.append(dialog);
  try {
    await act(async () => edits.edit(add));
    expect(shown).toHaveBeenCalledTimes(2);
    expect(shown.mock.calls[1][0].announce).toBe(false);
  } finally {
    dialog.remove();
  }

  // A dialog with no such line (Export, say) leaves the toast as the one announcement.
  const other = document.createElement("dialog");
  other.setAttribute("open", "");
  document.body.append(other);
  try {
    await act(async () => edits.edit(add));
    expect(shown.mock.calls[2][0].announce).toBe(true);
  } finally {
    other.remove();
  }
});

// Announcements: one per completed outcome, silent while pending. `edits.feedback.id` names an announcement.
const UNSURE = "Undo may not have finished. Try again to check safely.";
async function savedThenUncertainUndo() {
  vi.mocked(changeDeckList).mockResolvedValueOnce(SAVED);
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  const saved = edits.feedback!;
  vi.mocked(changeDeckList).mockRejectedValueOnce(new TypeError("offline"));
  await act(async () => edits.feedback!.undo!());
  return saved;
}
function held() {
  let answer!: (value: DeckListCommandResult) => void;
  vi.mocked(changeDeckList).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  return (value: DeckListCommandResult) => answer(value);
}

test("retrying an uncertain Undo keeps the uncertain words while it is pending, then says its one outcome", async () => {
  const saved = await savedThenUncertainUndo();
  const uncertain = edits.feedback!;
  expect(uncertain.message).toBe(UNSURE);
  expect(uncertain.id).not.toBe(saved.id);
  const showsBefore = shown.mock.calls.length;
  const answer = held();
  await act(async () => edits.feedback!.undo!());
  // Pending: the same announcement, the same words, only busy; the toast changes in place, not by new words.
  expect(edits.feedback).toMatchObject({
    id: uncertain.id,
    message: UNSURE,
    busy: true,
    undo: null,
  });
  expect(shown).toHaveBeenCalledTimes(showsBefore);
  expect(updated.mock.lastCall![1]).toMatchObject({
    message: UNSURE,
    action: { busy: true },
  });
  await act(async () => answer(SAVED));
  expect(edits.feedback).toMatchObject({
    message: "Undone: Added 1 Energy.",
    busy: false,
  });
  expect(edits.feedback!.id).toBeGreaterThan(uncertain.id);
  expect(shown).toHaveBeenCalledTimes(showsBefore + 1);
  // The same key on every try, so the server applies the Undo once.
  const keys = vi
    .mocked(changeDeckList)
    .mock.calls.slice(1)
    .map((call) => call[1].idempotency_key);
  expect(keys).toHaveLength(2);
  expect(keys[1]).toBe(keys[0]);
});

test("two uncertain Undos in a row are two announcements with the same words", async () => {
  const saved = await savedThenUncertainUndo();
  const first = edits.feedback!;
  vi.mocked(changeDeckList).mockRejectedValueOnce(new TypeError("offline"));
  await act(async () => edits.feedback!.undo!());
  const second = edits.feedback!;
  expect(second.message).toBe(first.message);
  expect(new Set([saved.id, first.id, second.id]).size).toBe(3);
  expect(shown).toHaveBeenCalledTimes(3);
});

test("pressing Undo keeps the saved message and its announcement, and only marks the button busy", async () => {
  vi.mocked(changeDeckList).mockResolvedValueOnce(SAVED);
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  const saved = edits.feedback!;
  const answer = held();
  await act(async () => saved.undo!());
  expect(edits.feedback).toMatchObject({
    id: saved.id,
    message: saved.message,
    busy: true,
  });
  expect(shown).toHaveBeenCalledTimes(1);
  expect(updated.mock.lastCall![1]).toMatchObject({
    message: saved.message,
    action: { busy: true },
  });
  await act(async () => answer(SAVED));
  expect(edits.feedback!.message).toBe("Undone: Added 1 Energy.");
});

test("a retried Undo that is refused with no newer batch says so", async () => {
  await savedThenUncertainUndo();
  vi.mocked(changeDeckList).mockRejectedValueOnce(
    new DeckError(409, "STALE_DECK_LIST")
  );
  await act(async () => edits.feedback!.undo!());
  expect(edits.feedback!.message).toBe("Can't undo: this deck changed.");
  expect(edits.feedback!.busy).toBe(false);
});

test("an Undo refused after a newer batch was saved leaves the newer batch's feedback alone", async () => {
  vi.mocked(changeDeckList).mockResolvedValue(SAVED);
  await mount(vi.fn());
  await act(async () => edits.edit(add));
  const older = edits.feedback!;
  await act(async () => edits.edit(add));
  const newer = edits.feedback!;
  expect(newer.id).not.toBe(older.id);
  vi.mocked(changeDeckList).mockRejectedValueOnce(
    new DeckError(409, "STALE_DECK_LIST")
  );
  const showsBefore = shown.mock.calls.length;
  await act(async () => older.undo!());
  expect(edits.feedback).toMatchObject({
    id: newer.id,
    message: newer.message,
    busy: false,
  });
  expect(shown).toHaveBeenCalledTimes(showsBefore);
});
