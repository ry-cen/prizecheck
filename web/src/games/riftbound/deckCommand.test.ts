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
      // A browser drops focus from a field that becomes disabled.
      (document.activeElement as HTMLElement | null)?.blur();
      await act(async () => render(2));
      expect(input.value).toBe("My draft");
      expect(input.disabled).toBe(false);
      expect(document.body.textContent).toContain(
        "This Deck was renamed elsewhere."
      );
      expect(document.activeElement).toBe(input);
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
type Location = { id: string; name: string; version: number };
async function harness(
  send: (
    name: string,
    options: { signal: AbortSignal; idempotencyKey: string }
  ) => Promise<{ ownerRevision: number; location?: Location }>,
  reload?: () => Promise<void>
) {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.getElementById("root")!);
  const done = vi.fn();
  const render = (version: number) =>
    root.render(
      createElement(DeckCommand, {
        title: "Rename Deck",
        initialName: "Draft",
        version,
        send: send as never,
        reload,
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
  return {
    done,
    render,
    submit,
    input: () => document.querySelector("input")!,
    finish: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      vi.unstubAllGlobals();
    },
  };
}
const location = (version: number): Location => ({
  id: "deck-1",
  name: "Draft",
  version,
});
it("treats a version delivered while the collector's own rename is in flight as that rename", async () => {
  let resolve!: (r: { ownerRevision: number; location: Location }) => void;
  const h = await harness(
    () =>
      new Promise((r) => {
        resolve = r;
      })
  );
  try {
    await act(async () => h.render(1));
    await act(async () => h.submit());
    await act(async () => h.render(2));
    expect(h.input().disabled).toBe(true);
    expect(document.body.textContent).not.toContain("renamed elsewhere");
    await act(async () => resolve({ ownerRevision: 2, location: location(2) }));
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("renamed elsewhere");
  } finally {
    await h.finish();
  }
});
it("reports a rename elsewhere, with a fresh key and restored focus, when the result cannot be attributed to the collector's request", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce({ ownerRevision: 2, location: location(2) })
    .mockResolvedValue({ ownerRevision: 3, location: location(3) });
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const h = await harness(async (...args) => {
    await gate;
    return send(...args);
  });
  try {
    await act(async () => h.render(1));
    await act(async () => h.submit());
    await act(async () => h.render(3));
    await act(async () => release());
    expect(h.done).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "This Deck was renamed elsewhere."
    );
    expect(h.input().disabled).toBe(false);
    expect(document.activeElement).toBe(h.input());
    await act(async () => h.submit());
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1][1].idempotencyKey).not.toBe(
      send.mock.calls[0][1].idempotencyKey
    );
  } finally {
    await h.finish();
  }
});
it("restores focus when an in-flight request fails after the version changed", async () => {
  let fail!: (e: Error) => void;
  const h = await harness(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      })
  );
  try {
    await act(async () => h.render(1));
    await act(async () => h.submit());
    await act(async () => h.render(2));
    await act(async () => fail(new Error("offline")));
    expect(document.body.textContent).toContain(
      "This Deck was renamed elsewhere."
    );
    expect(h.input().disabled).toBe(false);
    expect(document.activeElement).toBe(h.input());
  } finally {
    await h.finish();
  }
});
it("keeps the draft, reloads and restores focus after a stale Location", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new DeckError("STALE_LOCATION"))
    .mockResolvedValue({ ownerRevision: 3, location: location(3) });
  const reload = vi.fn(async () => {});
  const h = await harness(send, reload);
  try {
    await act(async () => h.render(1));
    await act(async () => h.submit());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(h.input().value).toBe("Draft");
    expect(document.body.textContent).toContain(
      "This Deck was renamed elsewhere."
    );
    expect(document.activeElement).toBe(h.input());
    await act(async () => h.render(3));
    await act(async () => h.submit());
    expect(h.done).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[1][1].idempotencyKey).not.toBe(
      send.mock.calls[0][1].idempotencyKey
    );
  } finally {
    await h.finish();
  }
});
