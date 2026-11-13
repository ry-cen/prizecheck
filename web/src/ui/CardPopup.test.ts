// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, test, expect, vi } from "vitest";
import { CardArt } from "./CardPopup";
import { useLargeArt } from "./largeArt";
vi.mock("./ScrollArea", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) =>
    h("div", null, children),
}));
vi.mock("./largeArt", () => ({ useLargeArt: vi.fn() }));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 112, height: 156 },
  ] as unknown as DOMRectList);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.mocked(useLargeArt).mockReturnValue({
    src: "/card.webp",
    waiting: false,
    onError: vi.fn(),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
for (const close of ["button", "Escape", "cancel"]) {
  test(`phone art opens a larger view and ${close} returns focus to the thumbnail`, async () => {
    await act(async () =>
      root.render(h(CardArt, { name: "Bulbasaur", url: "/card.webp" }))
    );
    const button = host.querySelector(
      'button[aria-label="View larger image of Bulbasaur"]'
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(true);
    const image = button.querySelector("img")!;
    Object.defineProperty(image, "naturalWidth", { value: 245 });
    await act(async () => image.dispatchEvent(new Event("load")));
    expect(button.disabled).toBe(false);
    button.focus();
    await act(async () => button.click());
    const dialog = host.querySelector("dialog[open]")!;
    expect(dialog).not.toBeNull();
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/card.webp");
    await act(async () => {
      if (close === "button")
        (
          dialog.querySelector('[aria-label="Close"]') as HTMLButtonElement
        ).click();
      else if (close === "cancel")
        dialog.dispatchEvent(
          new Event("cancel", { bubbles: true, cancelable: true })
        );
      else
        dialog.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
        );
    });
    expect(host.querySelector("dialog[open]")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
}
test("desktop artwork remains a plain image", async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  await act(async () =>
    root.render(h(CardArt, { name: "Bulbasaur", url: "/card.webp" }))
  );
  expect(host.querySelector("img")).not.toBeNull();
  expect(host.querySelector("button")).toBeNull();
});
test("missing artwork has the existing unavailable text and no enlarge button", async () => {
  vi.mocked(useLargeArt).mockReturnValue({
    src: null,
    waiting: false,
    onError: vi.fn(),
  });
  await act(async () =>
    root.render(h(CardArt, { name: "Bulbasaur", url: null }))
  );
  expect(host.textContent).toBe("Artwork unavailable");
  expect(host.querySelector("button")).toBeNull();
});
test("a breakpoint flip while the image is enlarged clears it for good", async () => {
  let matches = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) =>
      listeners.delete(listener),
  }));
  await act(async () =>
    root.render(h(CardArt, { name: "Bulbasaur", url: "/card.webp" }))
  );
  const button = host.querySelector(
    'button[aria-label="View larger image of Bulbasaur"]'
  ) as HTMLButtonElement;
  const image = button.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 245 });
  await act(async () => image.dispatchEvent(new Event("load")));
  await act(async () => button.click());
  expect(host.querySelector("dialog[open]")).not.toBeNull();
  const flip = async (phone: boolean) => {
    matches = phone;
    await act(async () => listeners.forEach((listener) => listener()));
  };
  await flip(false);
  expect(host.querySelector("dialog[open]")).toBeNull();
  await flip(true);
  expect(host.querySelector("dialog[open]")).toBeNull();
});
