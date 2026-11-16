import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { DeckCommand } from "./DecksView";
import { DeckError } from "./decks";
import { deckFixture } from "./local/deckFixtures";
import { resetCollectionFixtures } from "./local/collectionFixtures";
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) =>
    createElement("div", null, children),
}));
for (const deletion of [false, true])
  it(`keeps an uncertain ${deletion ? "Delete" : "Rename"} attempt, its key and its version through repeated version updates, then replays it`, async () => {
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
      const submit = () =>
        document
          .querySelector("form")!
          .dispatchEvent(
            new dom.window.Event("submit", { bubbles: true, cancelable: true })
          );
      await act(async () => submit());
      expect(input.disabled).toBe(true);
      expect(document.body.textContent).toContain(
        "Your last change may not have been saved. Try again to check safely."
      );
      await act(async () => render(2));
      await act(async () => render(3));
      expect(input.value).toBe("My draft");
      expect(input.disabled).toBe(true);
      expect(document.body.textContent).not.toContain("renamed elsewhere");
      expect(document.body.textContent).toContain(
        "Your last change may not have been saved."
      );
      expect(
        document
          .querySelector('button[type="submit"]')
          ?.hasAttribute("disabled")
      ).toBe(false);
      await act(async () => submit());
      expect(done).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0]).toBe(send.mock.calls[0][0]);
      expect(send.mock.calls[1][1].idempotencyKey).toBe(
        send.mock.calls[0][1].idempotencyKey
      );
      expect(send.mock.calls[1][1].version).toBe(1);
      expect(document.body.textContent).not.toContain("renamed elsewhere");
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
  reload?: () => Promise<void>,
  props: { title?: string; initialName?: string; confirmName?: string } = {}
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
        ...props,
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
it("restores focus when an in-flight request is definitively refused after the version changed", async () => {
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
    await act(async () => fail(new DeckError("LOCATION_NAME_CONFLICT")));
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

for (const deletion of [false, true])
  it(`confirms a ${deletion ? "Delete" : "Rename"} whose response was lost exactly once after a background read delivers its version`, async () => {
    resetCollectionFixtures();
    const api = deckFixture("a");
    const signal = new AbortController().signal;
    const initial = (await api.deck("deck-1", signal))!.location;
    const state = async () =>
      JSON.stringify((await api.deck("deck-1", signal))?.location ?? null);
    let lost = true;
    let mutations = 0;
    const send = vi.fn(
      async (
        name: string,
        options: {
          signal: AbortSignal;
          idempotencyKey: string;
          version?: number;
        }
      ) => {
        const { version, ...write } = options;
        const before = await state();
        const result = deletion
          ? await api.deleteDeck(
              { id: initial.id, confirmName: name, version: version! },
              write
            )
          : await api.renameDeck(
              { id: initial.id, name, version: version! },
              write
            );
        if (before !== (await state())) mutations++;
        if (lost) {
          lost = false;
          throw new Error("response lost");
        }
        return result;
      }
    );
    const h = await harness(send as never, undefined, {
      title: deletion ? "Delete Deck" : "Rename Deck",
      initialName: deletion ? initial.name : "Sol rename",
      confirmName: deletion ? initial.name : undefined,
    });
    try {
      await act(async () => h.render(initial.version));
      await act(async () => h.submit());
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain("may not have been saved")
      );
      expect(h.input().disabled).toBe(true);
      expect(mutations).toBe(1);
      // A background read observes the version the lost response produced.
      await act(async () => h.render(initial.version + 1));
      expect(document.body.textContent).not.toContain("renamed elsewhere");
      await act(async () => h.submit());
      await vi.waitFor(() => expect(h.done).toHaveBeenCalledTimes(1));
      expect(send.mock.calls[1][1].idempotencyKey).toBe(
        send.mock.calls[0][1].idempotencyKey
      );
      expect(send.mock.calls[1][1].version).toBe(initial.version);
      expect(mutations).toBe(1);
      const after = (await api.deck("deck-1", signal))?.location;
      if (deletion) expect(after).toBeUndefined();
      else
        expect(after).toMatchObject({
          name: "Sol rename",
          version: initial.version + 1,
        });
      expect(document.body.textContent).not.toContain("renamed elsewhere");
    } finally {
      await h.finish();
    }
  });

for (const code of ["UNSORTED_UNAVAILABLE", "QUANTITY_OVERFLOW"] as const)
  it(`treats a Delete refused with ${code} as final: no uncertain note and a new key`, async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new DeckError(code))
      .mockResolvedValue({ ownerRevision: 2 });
    const h = await harness(send as never, undefined, {
      title: "Delete Deck",
      initialName: "Draft",
      confirmName: "Draft",
    });
    try {
      await act(async () => h.render(1));
      await act(async () => h.submit());
      expect(document.body.textContent).not.toContain(
        "may not have been saved"
      );
      expect(document.querySelector("[role=alert]")?.textContent).toContain(
        "can't be deleted"
      );
      expect(h.input().disabled).toBe(false);
      await act(async () => h.submit());
      expect(h.done).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[1][1].idempotencyKey).not.toBe(
        send.mock.calls[0][1].idempotencyKey
      );
    } finally {
      await h.finish();
    }
  });
it("moves focus to Retry after an uncertain failure", async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error("offline"));
  const h = await harness(send as never);
  try {
    await act(async () => h.render(1));
    await act(async () => h.submit());
    expect(document.activeElement).toBe(
      document.querySelector('button[type="submit"]')
    );
    expect(document.activeElement?.textContent).toBe("Retry");
  } finally {
    await h.finish();
  }
});
it("does not carry an earlier attempt's changed-elsewhere note into a new attempt", async () => {
  const send = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockRejectedValueOnce(new DeckError("STALE_LOCATION"))
    .mockRejectedValueOnce(new Error("offline again"));
  const h = await harness(send as never);
  try {
    await act(async () => h.render(1));
    await act(async () => h.submit());
    await act(async () => h.render(2));
    expect(document.body.textContent).toContain("This Deck changed elsewhere.");
    await act(async () => h.submit());
    expect(document.body.textContent).toContain(
      "This Deck was renamed elsewhere."
    );
    expect(h.input().disabled).toBe(false);
    await act(async () => h.submit());
    expect(send).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("may not have been saved");
    expect(document.body.textContent).not.toContain("changed elsewhere");
    expect(document.body.textContent).not.toContain("renamed elsewhere");
  } finally {
    await h.finish();
  }
});
