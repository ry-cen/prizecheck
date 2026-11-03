import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeckSwitchOffer, SwitchedDeck } from "../trades_generated";
import type { ToastInput, useToast } from "../ui/Toast";
import { offerSwitchUndo } from "./deckSwitchUndo";

const { changeDeckList, announceDeckListChanged } = vi.hoisted(() => ({
  changeDeckList: vi.fn(),
  announceDeckListChanged: vi.fn(),
}));
vi.mock("../decks_generated", async (original) => ({
  ...(await original<object>()),
  changeDeckList,
}));
vi.mock("../decks/deckListChanged", () => ({ announceDeckListChanged }));

const card = {
  edition_id: "a",
  name: "Arven",
  set_code: "SVI",
  set_name: "Scarlet & Violet",
  image_url: null,
  collector_number: "166",
  descriptor: { finish: "normal" },
};
const offer: DeckSwitchOffer = {
  deck_id: "d",
  deck_name: "Deck",
  from_edition_id: "a",
  to_edition_id: "b",
  count: "1",
  from_card: card,
  to_card: { ...card, edition_id: "b" },
};
const switched: SwitchedDeck = {
  deck_id: "d",
  revision: 2,
  undo: [{ edition_id: "a", quantity: "1" }],
};

function host() {
  let current: ToastInput | null = null;
  const toast: ReturnType<typeof useToast> = {
    show: vi.fn((input) => {
      current = input;
      return 1;
    }),
    update: vi.fn((_id, input) => {
      current = input;
    }),
    dismiss: vi.fn(),
    isShown: () => current !== null,
    focus: () => true,
    setLift: vi.fn(),
  };
  return { toast, current: () => current! };
}

describe("swap feedback lifetimes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opts plain swap success into its Trade route only", () => {
    const h = host();
    offerSwitchUndo(h.toast, "Swapped", [], [], "/trades/one");
    expect(h.current()).toEqual({ message: "Swapped", route: "/trades/one" });
  });

  it("keeps actionable switch feedback persistent and restores the Deck at the switch revision", async () => {
    const h = host();
    changeDeckList.mockResolvedValue({});
    offerSwitchUndo(h.toast, "Swapped", [offer], [switched], "/trades/one");
    expect(h.current().route).toBeUndefined();
    expect(h.current().action?.label).toBe("Undo switch");
    expect(h.current().action?.keepOpen).toBe(true);
    h.current().action?.onAction();
    await vi.waitFor(() =>
      expect(announceDeckListChanged).toHaveBeenCalledWith("d")
    );
    expect(changeDeckList).toHaveBeenCalledWith("d", {
      revision: 2,
      changes: switched.undo,
      idempotency_key: expect.any(String),
    });
    expect(h.current().message).toBe("Deck uses Arven (SVI 166) again.");
    expect(h.current().route).toBeUndefined();
  });

  it("keeps an unknown Undo retry actionable with the same command key", async () => {
    const h = host();
    changeDeckList
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({});
    offerSwitchUndo(h.toast, "Swapped", [offer], [switched], "/trades/one");
    h.current().action?.onAction();
    await vi.waitFor(() => expect(h.current().message).toContain("Try again"));
    expect(h.current().route).toBeUndefined();
    h.current().action?.onAction();
    await vi.waitFor(() => expect(announceDeckListChanged).toHaveBeenCalled());
    expect(changeDeckList.mock.calls[1]).toEqual(changeDeckList.mock.calls[0]);
  });
});
