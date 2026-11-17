import type { ReactNode } from "react";
// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CatalogCardPopup } from "./CatalogCardPopup";
import { addToCollection, type AddOutcome } from "./cardActions";
import { ToastProvider } from "../ui/Toast";

vi.mock("../ui/CardPopup", () => ({
  CardPopup: ({ children, open }: { children: ReactNode; open: boolean }) =>
    h("div", { role: "dialog", hidden: !open }, children),
  CardArt: () => null,
}));
vi.mock("./cardActions", () => ({ addToCollection: vi.fn() }));
vi.mock("../inventoryUndo", () => ({ applyUndo: vi.fn(), listUndo: vi.fn() }));
vi.mock("../EditionPrice", () => ({ EditionPrice: () => null }));
vi.mock("./useCardDetails", () => ({
  useCardDetails: () => ({
    reload: vi.fn(),
    details: {
      state: "ready",
      browse: "ok",
      rows: [],
      printing: {
        id: "p",
        name: "Switch",
        identity_name: "Switch",
        source: "tcgdex",
        editions: [],
      },
      editions: [
        { id: "e", active: true, descriptor: { finish: "normal" }, owned: 0 },
      ],
    },
  }),
  useCopiesWhere: () => ({ state: "ready", holdings: [] }),
}));
vi.mock("./usePlaces", () => ({
  usePlaces: () => ({
    state: "ready",
    leaves: [{ id: "u", label: "Unsorted" }],
    reload: vi.fn(),
  }),
}));
vi.mock("../social/FriendsWhoHaveThis", () => ({
  FriendsWhoHaveThis: () => null,
}));
vi.mock("../trades/AskToTrade", () => ({ AskToTrade: () => null }));

// The Add row's failure line: "You're offline" only when the browser says so, and Retry whenever the same add
// can safely be sent again.
const unknown: AddOutcome = {
  ok: false,
  code: "",
  editionId: null,
  retry: true,
};
const refused: AddOutcome = {
  ok: false,
  code: "EDITION_UNAVAILABLE",
  editionId: "e",
  retry: false,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let online: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      h(
        ToastProvider,
        null,
        h(CatalogCardPopup, {
          request: { printingId: "p", editionId: "e", row: null, report: null },
          onClose: vi.fn(),
          position: null,
          canPrevious: false,
          canNext: false,
          onPrevious: vi.fn(),
          onNext: vi.fn(),
          pendingFor: () => ({ current: null }),
          location: null,
          onLocation: vi.fn(),
          alsoOffer: null,
          onAdded: async () => null,
          onReported: vi.fn(),
        })
      )
    )
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  online.mockRestore();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === name);
const alert = () => host.querySelector('[role="alert"]')?.textContent ?? "";

test("an add that fails while the browser is offline says so and offers Retry", async () => {
  online.mockReturnValue(false);
  vi.mocked(addToCollection).mockResolvedValue(unknown);
  await act(async () => button("Add 1")!.click());
  expect(alert()).toBe("You're offline. Add again when you're back online.");
  expect(button("Retry")).toBeDefined();
  expect(addToCollection).toHaveBeenCalledTimes(1);
});

test("Retry sends the add again and takes focus to Add while it runs", async () => {
  online.mockReturnValue(false);
  vi.mocked(addToCollection).mockResolvedValueOnce(unknown);
  await act(async () => button("Add 1")!.click());
  let finish!: (value: AddOutcome) => void;
  vi.mocked(addToCollection).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  await act(async () => button("Retry")!.click());
  expect(addToCollection).toHaveBeenCalledTimes(2);
  expect(button("Retry")).toBeUndefined();
  expect(document.activeElement).toBe(button("Add 1"));
  await act(async () => finish(unknown));
  expect(button("Retry")).toBeDefined();
});

test("while the browser is online, a lost answer keeps the may-have-completed wording and still offers Retry", async () => {
  vi.mocked(addToCollection).mockResolvedValue(unknown);
  await act(async () => button("Add 1")!.click());
  expect(alert()).toBe(
    "Add may have completed. Press Add again to check safely."
  );
  expect(button("Retry")).toBeDefined();
});

test("a refusal that ends the add has no Retry, offline or not", async () => {
  online.mockReturnValue(false);
  vi.mocked(addToCollection).mockResolvedValue(refused);
  await act(async () => button("Add 1")!.click());
  expect(alert()).toBe("This Edition is no longer available to add.");
  expect(button("Retry")).toBeUndefined();
});
