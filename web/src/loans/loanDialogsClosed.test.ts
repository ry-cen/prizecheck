// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LentOutDialog } from "./LentOutDialog";
import { BorrowedDialog } from "./BorrowedDialog";
import { LoanRecoveryProvider } from "./LoanRecovery";
import { fixture, deferred } from "./testing/loanFakes";
import { indexLocations } from "../workspace/locationTree";
vi.mock("../social_generated", async (original) => ({
  ...(await original<typeof import("../social_generated")>()),
  getLentOut: () => deferred().promise,
  getBorrowed: () => deferred().promise,
}));
it.each(["lent", "borrowed"])(
  "silences closed %s live regions and keeps open loading status",
  async (kind) => {
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
    const render = (open: boolean) =>
      h(LoanRecoveryProvider, {
        accountId: "A",
        accountName: "Ana",
        ports: f.ports,
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
      await act(async () => root.render(render(false)));
      const liveText = () =>
        [...host.querySelectorAll('[role="status"],[role="alert"],[aria-live]')]
          .map((e) => e.textContent?.trim())
          .filter(Boolean);
      expect(liveText()).toEqual([]);
      await act(async () => root.render(render(true)));
      expect(host.querySelector('[role="status"]')?.textContent).toContain(
        kind === "lent" ? "Loading lent cards…" : "Loading borrowed cards…"
      );
      await act(async () => root.render(render(false)));
      expect(liveText()).toEqual([]);
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
