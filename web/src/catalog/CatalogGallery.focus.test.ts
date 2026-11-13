// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { CatalogGallery } from "./CatalogGallery";
import { ToastProvider, useToast } from "../ui/Toast";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const json = (value: unknown) => new Response(JSON.stringify(value));

test.each([
  "clear",
  "opener",
  "modal",
  "move",
  "newer",
  "reject",
  "pending",
  "dismiss",
])(
  "real Gallery delayed popup Add respects %s focus during Undo lookup",
  async (scenario) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const dialogMethods = ["showModal", "close"] as const;
    const originals = dialogMethods.map((name) =>
      Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name)
    );
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
    };
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      {},
    ] as unknown as DOMRectList);
    const add = deferred<Response>(),
      lookup = deferred<Response>();
    const row = {
      edition_id: "e",
      printing_id: "p",
      name: "Switch",
      set_id: "set",
      set_name: "Set",
      set_code: "SET",
      collector_number: "1",
      descriptor: { finish: "normal" },
      image_url: null,
      art_url: null,
      card_kind: "trainer",
      trainer_type: "item",
      owned: 0,
      in_deck: 0,
      free: 0,
      standing: Object.fromEntries(
        ["standard", "expanded", "glc"].map((key) => [
          key,
          { status: "legal", reasons: [] },
        ])
      ),
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("holdings/batch")) return add.promise;
      if (url === "/api/moves/undo") return lookup.promise;
      if (url === "/api/moves/undo/B")
        return json({ copy_count: "1", owner_revision: 3 });
      if (url.includes("location-tree"))
        return json({
          locations: [
            {
              id: "box",
              name: "Box",
              kind: "storage_leaf",
              parent_id: null,
              version: 1,
            },
          ],
        });
      if (url.includes("/printings/p"))
        return json({
          printing: {
            id: "p",
            name: "Switch",
            identity_name: "Switch",
            editions: [
              { id: "e", active: true, descriptor: { finish: "normal" } },
            ],
          },
        });
      if (url.includes("/collection/"))
        return json({ holdings: [], owner_revision: 1 });
      if (url.includes("/editions"))
        return json({
          available: true,
          matches: 1,
          search: { mode: "all" },
          editions: [row],
          next_cursor: null,
          catalog_revision: 1,
          owner_revision: 1,
        });
      if (url.includes("/sets")) return json({ available: true, sets: [] });
      if (url.includes("distribution")) return json({ holdings: [] });
      if (url.includes("prices")) return json({ prices: [] });
      return json({
        available: true,
        revision: 1,
        owner_revision: 1,
        holdings: [],
        friends: [],
      });
    });
    vi.stubGlobal("fetch", fetch);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let kit!: ReturnType<typeof useToast>;
    function Owner() {
      kit = useToast();
      return h(CatalogGallery, {
        active: true,
        adding: true,
        fixedTarget: { id: "box", label: "Box" },
        undoToast: true,
        stick: "page",
      });
    }
    const button = (name: string, scope: ParentNode = host) =>
      [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === name || b.getAttribute("aria-label") === name
      )!;
    try {
      await act(async () => root.render(h(ToastProvider, null, h(Owner))));
      const shown = vi.spyOn(kit, "show");
      const opener = host.querySelector<HTMLButtonElement>(
        '[data-edition-id="e"] button'
      )!;
      await act(async () => opener.click());
      await act(async () => button("Add 1").click());
      if (scenario !== "modal")
        await act(async () => button("Close card details").click());
      if (
        ["clear", "move", "newer", "reject", "pending", "dismiss"].includes(
          scenario
        )
      ) {
        await act(async () =>
          host
            .querySelector<HTMLButtonElement>('[aria-label^="One more"]')!
            .click()
        );
        await act(async () => button("Clear queue").click());
      }
      const stale = shown.mock.calls.find(
        ([n]) => n.message === "Queue cleared."
      )?.[0].action?.onAction;
      if (scenario === "modal") button("Add 1").focus();
      if (scenario === "opener") expect(document.activeElement).toBe(opener);
      if (
        ["clear", "move", "newer", "reject", "pending", "dismiss"].includes(
          scenario
        )
      )
        expect(document.activeElement).toBe(
          button("Undo", host.querySelector("#app-toasts")!)
        );
      const before = document.activeElement;
      await act(async () =>
        add.resolve(
          json({
            copy_count: "1",
            edition_count: 1,
            owner_revision: 2,
            undo_id: "B",
          })
        )
      );
      const interim = document.activeElement as HTMLButtonElement;
      expect(interim).not.toBe(document.body);
      expect(interim.isConnected).toBe(true);
      expect(interim.disabled).toBe(false);
      if (scenario === "opener" || scenario === "modal")
        expect(interim).toBe(before);
      if (stale) {
        await act(async () => stale());
        expect(host.querySelector('[aria-label="Cards to add"]')).toBeNull();
      }
      if (stale) {
        const notifications = host.querySelector("#app-toasts")!;
        expect(notifications.querySelector("p")!.textContent).toBe(
          "Queue cleared."
        );
        expect(button("Undo", notifications)).toBeUndefined();
        expect(button("Dismiss", notifications)).toBe(document.activeElement);
      }
      // Intentionally leave the network promise pending: meaningful content and
      // no retired recovery must hold without depending on eventual settlement.
      if (scenario === "pending") return;
      const search = host.querySelector<HTMLInputElement>(
        'input[type="search"]'
      )!;
      if (scenario === "move") search.focus();
      if (scenario === "newer")
        await act(async () => {
          kit.show({ message: "Newer", focus: true });
        });
      if (scenario === "dismiss") {
        await act(async () =>
          button("Dismiss", host.querySelector("#app-toasts")!).click()
        );
        expect(document.activeElement).toBe(search);
        expect(document.activeElement).not.toBe(document.body);
        expect(host.querySelector("#app-toasts")!.textContent).toBe("");
      }
      const kept = document.activeElement;
      if (scenario === "reject")
        await act(async () => lookup.reject(new TypeError("offline")));
      else
        await act(async () =>
          lookup.resolve(json([{ id: "B", action: "add" }]))
        );
      if (scenario === "clear") {
        const notifications = host.querySelector("#app-toasts")!;
        expect(notifications.contains(document.activeElement)).toBe(true);
        await act(async () => button("Undo", notifications).click());
        expect(
          fetch.mock.calls.filter(
            ([url]) => String(url) === "/api/moves/undo/B"
          )
        ).toHaveLength(1);
      } else if (scenario === "reject") {
        const notifications = host.querySelector("#app-toasts")!;
        expect(notifications.contains(document.activeElement)).toBe(true);
        expect(notifications.textContent).toContain("Added 1 card");
        expect(button("Undo", notifications)).toBeUndefined();
      } else expect(document.activeElement).toBe(kept);
      expect(
        shown.mock.calls.filter(([n]) => n.message.startsWith("Added"))
      ).toHaveLength(scenario === "newer" ? 0 : 1);
      if (scenario === "newer") {
        expect(host.querySelector("#app-toasts")!.textContent).toBe("Newer");
        expect(
          button("Undo", host.querySelector("#app-toasts")!)
        ).toBeUndefined();
      }
      if (scenario === "modal") {
        expect(
          host.querySelector("dialog[open]")!.contains(document.activeElement)
        ).toBe(true);
        expect(
          button("Undo", host.querySelector("#app-toasts")!)
        ).toBeUndefined();
        await act(async () => button("Close card details").click());
        expect(
          button("Undo", host.querySelector("#app-toasts")!).disabled
        ).toBe(false);
        expect(document.activeElement).toBe(opener);
      }
    } finally {
      await act(async () => root.unmount());
      host.remove();
      dialogMethods.forEach((name, index) => {
        const original = originals[index];
        if (original)
          Object.defineProperty(HTMLDialogElement.prototype, name, original);
        else Reflect.deleteProperty(HTMLDialogElement.prototype, name);
      });
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      sessionStorage.clear();
    }
  }
);
