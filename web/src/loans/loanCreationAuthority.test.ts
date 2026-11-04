// @vitest-environment jsdom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BorrowDraftsProvider, useBorrowDrafts } from "./BorrowDrafts";
import { LendOfferDialog } from "./LendOfferDialog";
import {
  getFriends,
  sendBorrowRequest,
  sendLendOffer,
  SocialError,
} from "../social_generated";
import { getDecks } from "../decks_generated";
import { ToastProvider } from "../ui/Toast";
import { useRoute } from "../shell/useRoute";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getFriends: vi.fn(),
  sendBorrowRequest: vi.fn(),
  sendLendOffer: vi.fn(),
}));
vi.mock("../decks_generated", async (original) => ({
  ...(await original<typeof import("../decks_generated")>()),
  getDecks: vi.fn(),
}));
vi.mock("../workspace/media", () => ({
  MOBILE_QUERY: "(max-width: 760px)",
  useMediaQuery: () => false,
}));
for (const kind of ["borrow", "lend"] as const)
  it(`keeps the complete initial ${kind} command through close, edits and navigation until exact replay settles`, async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    window.history.replaceState(null, "", "/collection");
    window.localStorage.clear();
    const prototype = HTMLDialogElement.prototype;
    const descriptors = ["showModal", "close"].map((name) =>
      Object.getOwnPropertyDescriptor(prototype, name)
    );
    Object.defineProperty(prototype, "showModal", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    });
    Object.defineProperty(prototype, "close", {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    });
    vi.mocked(getFriends).mockResolvedValue({
      received: [],
      sent: [],
      friends: [
        { collector_id: "friend", display_name: "Misty", handle: "misty" },
      ],
    });
    vi.mocked(getDecks).mockResolvedValue({
      decks: [],
      owner_revision: 0,
      next_cursor: null,
    });
    const send =
      kind === "borrow"
        ? vi.mocked(sendBorrowRequest)
        : vi.mocked(sendLendOffer);
    let lose!: (error: Error) => void;
    send
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          lose = reject;
        })
      )
      .mockRejectedValueOnce(new SocialError(409, "NOT_FRIENDS"));
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find(
        (b) => b.textContent === name
      )!;
    function BorrowOpener() {
      const drafts = useBorrowDrafts()!;
      return h(
        "button",
        {
          onClick: () => {
            drafts.set(
              {
                collector_id: "friend",
                display_name: "Misty",
                handle: "misty",
              },
              {
                edition_id: "iono",
                name: "Iono",
                set_code: "PAL",
                collector_number: "185",
                descriptor: { finish: "normal" },
                image_url: null,
              },
              3,
              3,
              "3 available"
            );
            drafts.review("friend");
          },
        },
        "Open Borrow"
      );
    }
    function View() {
      const route = useRoute();
      const [open, setOpen] = useState(true);
      return h(
        ToastProvider,
        null,
        h("button", { onClick: () => route.navigate("/decks") }, "Navigate"),
        kind === "lend"
          ? h(LendOfferDialog, {
              open,
              rows: [
                {
                  key: "line",
                  locationId: "place",
                  editionId: "iono",
                  count: 3,
                  card: "Iono",
                },
              ],
              onClose: () => setOpen(false),
              onSent: vi.fn(),
              onOpenLoan: vi.fn(),
            })
          : h(BorrowDraftsProvider, {
              userId: "authority-test",
              onOpenLoan: vi.fn(),
              children: h(BorrowOpener),
            })
      );
    }
    try {
      await act(async () => root.render(h(View)));
      if (kind === "borrow")
        await act(async () => button("Open Borrow").click());
      else
        await act(async () => {
          const field = host.querySelector("select")!;
          field.value = "friend";
          field.dispatchEvent(new Event("change", { bubbles: true }));
        });
      await act(async () =>
        button(
          kind === "borrow" ? "Send Borrow Request" : "Send offer of 3 cards"
        ).click()
      );
      const original = JSON.stringify(send.mock.calls[0]);
      for (const lost of [false, true]) {
        if (lost) await act(async () => lose(new TypeError("lost response")));
        await act(async () =>
          button(kind === "borrow" ? "Keep draft" : "Cancel").click()
        );
        expect(
          host.querySelector<HTMLDialogElement>("dialog[open]")?.open
        ).toBe(true);
        if (kind === "borrow") {
          expect(
            host
              .querySelector<HTMLButtonElement>(
                'button[aria-label^="Decrease"]'
              )
              ?.matches(":disabled")
          ).toBe(true);
          await act(async () => button("Discard").click());
          expect(
            host.querySelector<HTMLDialogElement>("dialog[open]")?.open
          ).toBe(true);
        } else expect(host.querySelector("select")?.disabled).toBe(true);
        expect(
          host
            .querySelector<HTMLInputElement>('input[type="date"]')
            ?.matches(":disabled")
        ).toBe(true);
        await act(async () => button("Navigate").click());
        expect(window.location.pathname).toBe("/collection");
        expect(
          window.dispatchEvent(new Event("beforeunload", { cancelable: true }))
        ).toBe(false);
        expect(send).toHaveBeenCalledTimes(1);
      }
      await act(async () => button("Retry request").click());
      expect(send).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(send.mock.calls[1])).toBe(original);
      expect(button("Retry request")).toBeUndefined();
      await act(async () =>
        button(kind === "borrow" ? "Keep draft" : "Cancel").click()
      );
      expect(host.querySelector<HTMLDialogElement>("dialog[open]")).toBeNull();
      await act(async () => button("Navigate").click());
      expect(window.location.pathname).toBe("/decks");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      for (const [i, name] of ["showModal", "close"].entries()) {
        const d = descriptors[i];
        if (d) Object.defineProperty(prototype, name, d);
        else Reflect.deleteProperty(prototype, name);
      }
      window.localStorage.clear();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });
