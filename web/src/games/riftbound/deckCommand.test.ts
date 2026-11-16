import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { DeckCommand } from "./DecksView";
import { DeckError } from "./decks";
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
}));
for (const deletion of [false, true])
  it(`preserves ${deletion ? "Delete confirmation" : "Rename draft and focus"} across repeated version updates`, async () => {
    const dom = new JSDOM('<div id="root"></div>');
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.getElementById("root")!);
    const done = vi.fn();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("uncertain"))
      .mockResolvedValue({ ownerRevision: 4 });
    const render = (version: number) =>
      root.render(
        createElement(DeckCommand, {
          title: deletion ? "Delete Deck" : "Rename Deck",
          initialName: "My draft",
          confirmName: deletion
            ? version === 1
              ? "My draft"
              : "New name"
            : undefined,
          version,
          send,
          done,
          close: vi.fn(),
        })
      );
    try {
      await act(async () => render(1));
      const input = document.querySelector("input")!;
      input.focus();
      const submit = () =>
        document
          .querySelector("form")!
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true })
          );
      await act(async () => submit());
      expect(input.disabled).toBe(true);
      await act(async () => render(2));
      expect(input.value).toBe("My draft");
      expect(input.disabled).toBe(false);
      expect(document.body.textContent).toContain(
        "This Deck was renamed elsewhere."
      );
      input.focus();
      await act(async () => render(3));
      expect(document.activeElement).toBe(input);
      if (deletion)
        expect(
          document
            .querySelector('button[type="submit"]')
            ?.hasAttribute("disabled")
        ).toBe(true);
      else {
        await act(async () => submit());
        expect(done).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[1][1].idempotencyKey).not.toBe(
          send.mock.calls[0][1].idempotencyKey
        );
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    }
  });
it("ignores an interrupted old command completing during a newer attempt", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const done = vi.fn();
  const resolves: ((r: { ownerRevision: number }) => void)[] = [];
  const send = vi.fn(
    () =>
      new Promise<{ ownerRevision: number }>((resolve) =>
        resolves.push(resolve)
      )
  );
  const render = (version: number) =>
    root.render(
      createElement(DeckCommand, {
        title: "Rename Deck",
        initialName: "Draft",
        version,
        send,
        done,
        close: vi.fn(),
      })
    );
  const submit = () =>
    document
      .querySelector("form")!
      .dispatchEvent(
        new dom.window.Event("submit", { bubbles: true, cancelable: true })
      );
  try {
    await act(async () => render(1));
    await act(async () => submit());
    await act(async () => render(2));
    await act(async () => submit());
    await act(async () => resolves[0]({ ownerRevision: 2 }));
    expect(done).not.toHaveBeenCalled();
    expect(document.querySelector("input")!.disabled).toBe(true);
    await act(async () => resolves[1]({ ownerRevision: 3 }));
    expect(done).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    vi.unstubAllGlobals();
  }
});
