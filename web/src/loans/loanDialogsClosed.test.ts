// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LentOutDialog } from "./LentOutDialog";
import { BorrowedDialog } from "./BorrowedDialog";
import { LoanRecoveryProvider } from "./LoanRecovery";
import { fixture, deferred } from "./testing/loanFakes";
import { createLoanIntentStore, createTabContext } from "./loanIntents";
import { indexLocations } from "../workspace/locationTree";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLentOut: () => deferred().promise,
  getBorrowed: () => deferred().promise,
}));
it.each([
  ["lent", false, false],
  ["borrowed", false, false],
  ["borrowed", true, false],
  ["borrowed", true, true],
] as const)(
  "silences closed %s live regions (pending move=%s, initially open=%s)",
  async (kind, pendingMove, initiallyOpen) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const proto = HTMLDialogElement.prototype;
    const descriptors = ["showModal", "close"].map((name) =>
      Object.getOwnPropertyDescriptor(proto, name)
    );
    Object.defineProperty(proto, "showModal", {
      configurable: true,
      value() {
        this.open = true;
      },
    });
    Object.defineProperty(proto, "close", {
      configurable: true,
      value() {
        this.open = false;
      },
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const f = fixture();
    const tab = createTabContext();
    if (pendingMove) {
      const store = createLoanIntentStore("A", f.ports, tab);
      try {
        f.server.loseNextAnswer = true;
        expect(
          (
            await store.send(store.bind()!, {
              kind: "move_borrowed",
              scope: "move_borrowed",
              path: "/api/loans/borrowed/move",
              fields: {
                loan_id: "loan",
                edition_id: "card",
                from_location_id: "old-box",
                to_location_id: "box",
                quantity: "1",
              },
            })
          ).kind
        ).toBe("pending");
        expect(store.list()).toMatchObject([
          { kind: "move_borrowed", state: "unknown", replayable: true },
        ]);
      } finally {
        store.dispose();
      }
    }
    const savedRecovery = [...f.shared.data.entries()];
    const render = (open: boolean) =>
      h(LoanRecoveryProvider, {
        accountId: "A",
        accountName: "Ana",
        ports: f.ports,
        tab,
        children:
          kind === "lent"
            ? h(LentOutDialog, { open, onClose: vi.fn(), onOpenLoan: vi.fn() })
            : h(BorrowedDialog, {
                open,
                onClose: vi.fn(),
                onMoved: vi.fn(),
                index: indexLocations([]),
              }),
      });
    try {
      await act(async () => root.render(render(initiallyOpen)));
      const liveText = () =>
        [...host.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
          .map((e) => e.textContent?.trim())
          .filter(Boolean);
      if (!initiallyOpen) expect(liveText()).toEqual([]);
      await act(async () => root.render(render(true)));
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        kind === "lent" ? "Loading lent cards…" : "Loading borrowed cards…"
      );
      const recovery = () =>
        [...host.querySelectorAll("button")].filter(
          (button) =>
            button.textContent === "Send it again" ||
            button.textContent === "Don't send it"
        );
      if (pendingMove) {
        expect(liveText().join(" ")).toContain(
          "Your Move of borrowed cards may not have finished."
        );
        expect(recovery()).toHaveLength(2);
      }
      await act(async () => root.render(render(false)));
      expect(liveText()).toEqual([]);
      if (pendingMove) {
        expect(recovery()).toHaveLength(0);
        expect([...f.shared.data.entries()]).toEqual(savedRecovery);
        await act(async () => root.render(render(true)));
        expect(liveText().join(" ")).toContain(
          "Your Move of borrowed cards may not have finished."
        );
        expect(recovery()).toHaveLength(2);
        for (const button of recovery())
          expect(button.getAttribute("aria-disabled")).toBe("false");
        expect([...f.shared.data.entries()]).toEqual(savedRecovery);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      ["showModal", "close"].forEach((name, i) => {
        const descriptor = descriptors[i];
        if (descriptor) Object.defineProperty(proto, name, descriptor);
        else Reflect.deleteProperty(proto, name);
      });
      vi.unstubAllGlobals();
    }
  }
);
