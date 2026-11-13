// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { DeckBuilderPage } from "./DeckBuilderPage";
import {
  getDeck,
  type DeckDetail,
  type DeckListCommandResult,
} from "../decks_generated";
import type { useDeckListEdits } from "./useDeckListEdits";

const state = vi.hoisted(() => ({
  edits: null as Parameters<typeof useDeckListEdits>[0] | null,
}));
vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  getDeck: vi.fn(),
}));
vi.mock("./useDeckListEdits", () => ({
  useDeckListEdits: (options: Parameters<typeof useDeckListEdits>[0]) => {
    state.edits = options;
    return { busy: false, busyNow: () => false, quantityOf: () => 0n };
  },
}));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "phone",
  useMediaQuery: () => false,
}));
vi.mock("./useDeckCover", () => ({ useDeckCover: () => ({}) }));
vi.mock("./DeckRename", () => ({ useDeckRename: () => ({}) }));
vi.mock("./useDeckActions", () => ({ useDeckActions: () => ({}) }));
vi.mock("./usePutAway", () => ({ usePutAway: () => ({}) }));
vi.mock("./useDeckDrag", () => ({
  useDeckDrag: () => ({}),
  dropLook: () => "",
  DeckDragBadge: () => null,
}));
vi.mock("./useDeckCost", () => ({
  useDeckCost: () => null,
  useCardsRevision: () => null,
}));
vi.mock("./useGatherToast", () => ({ useGatherToast: () => ({}) }));
vi.mock("./deckListChanged", () => ({ useDeckListChanged: () => {} }));
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

for (const outcome of ["delayed", "failed"] as const) {
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
    if (outcome === "failed") {
      await act(async () => reject(new Error("offline")));
      expect(host.textContent).toContain("This Deck couldn't be loaded");
      expect(host.textContent).not.toContain("more copy:");
    } else {
      // Only a full read can restore the note, even when its legitimate difference is the same number.
      const fresh = detail("1", "2");
      fresh.deck_list.revision = 3;
      await act(async () => resolve(fresh));
      expect(host.textContent).toContain("counts 1 more copy:");
    }
  });
}
