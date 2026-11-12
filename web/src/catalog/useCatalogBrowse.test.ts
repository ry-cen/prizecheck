// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  browseEditions,
  CatalogBrowseError,
  type BrowsePage,
} from "../catalog_browse_generated";
import { getCollectionRevision } from "../collection_generated";
import { useCatalogBrowse, type CatalogBrowse } from "./useCatalogBrowse";
import { COLLECTION_REFRESHED } from "./catalogText";
vi.mock("../catalog_browse_generated", async (original) => ({
  ...(await original<typeof import("../catalog_browse_generated")>()),
  browseEditions: vi.fn(),
}));
vi.mock("../collection_generated", async (original) => ({
  ...(await original<typeof import("../collection_generated")>()),
  getCollectionRevision: vi.fn(),
}));
const first: BrowsePage = {
  available: true,
  catalog_revision: 1,
  owner_revision: 1,
  last_success: null,
  search: {
    mode: "all",
    text: "",
    set_id: null,
    set_name: null,
    set_code: null,
    number: null,
  },
  editions: [
    {
      edition_id: "iono",
      printing_id: "printing",
      name: "Iono",
      set_id: "set",
      set_name: "Paldea Evolved",
      set_code: "PAL",
      collector_number: "185",
      descriptor: { finish: "normal" },
      image_url: null,
      art_url: null,
      card_kind: "trainer",
      trainer_type: "supporter",
      evolves_from: null,
      regulation_mark: null,
      standing: {
        standard: { status: "legal", reasons: [] },
        expanded: { status: "legal", reasons: [] },
        glc: { status: "legal", reasons: [] },
      },
      owned: 0,
      in_deck: 0,
      free: 0,
    },
  ],
  next_cursor: "obsolete-cursor",
  printings: 70,
  matches: 70,
};
it.each([false, true])(
  "does not reuse an old observer cursor while the Add/Undo replacement walk is loading (external=%s)",
  async (external) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let release!: (page: BrowsePage) => void;
    const replacement = new Promise<BrowsePage>((resolve) => {
      release = resolve;
    });
    let rejectObsolete: ((cause: Error) => void) | undefined;
    let firstPages = 0,
      obsoleteReads = 0;
    const current = {
      ...first,
      owner_revision: external ? 4 : 3,
      next_cursor: "current-cursor",
    };
    vi.mocked(getCollectionRevision).mockResolvedValue({
      owner_revision: current.owner_revision,
    });
    vi.mocked(browseEditions).mockImplementation(async (_, cursor) => {
      if (!cursor) {
        firstPages++;
        if (firstPages === 1) return first;
        if (firstPages === 2) return replacement;
        return current;
      }
      if (cursor === "obsolete-cursor") {
        obsoleteReads++;
        if (obsoleteReads === 1)
          throw new CatalogBrowseError(409, "INVENTORY_CHANGED");
        return new Promise<BrowsePage>((_, reject) => {
          rejectObsolete = reject;
        });
      }
      throw new Error("Unexpected cursor " + cursor);
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    let view!: CatalogBrowse;
    function View() {
      view = useCatalogBrowse({}, true);
      return h("p", null, view.notice);
    }
    try {
      await act(async () => root.render(h(View)));
      const oldObserver = view.loadMore;
      await act(async () => {
        view.noteAdded([{ editionId: "iono", added: 1 }], 2);
        view.noteAdded([{ editionId: "iono", added: -1 }], 3);
      });
      expect(view.editions[0].owned).toBe(0);
      await act(async () => oldObserver());
      expect(firstPages).toBe(2);
      expect(view.loading).toBe(true);
      // A queued sentinel/focus callback still closes over the retired cursor.
      await act(async () => oldObserver());
      await act(async () => release(current));
      // On the old source this is the second obsolete response, delivered only after
      // page one reset the own-change counter: it caused the hosted noisy refresh.
      if (rejectObsolete)
        await act(async () =>
          rejectObsolete!(new CatalogBrowseError(409, "INVENTORY_CHANGED"))
        );
      expect(obsoleteReads).toBe(1);
      expect(firstPages).toBe(2);
      expect(view.notice).toBe(external ? COLLECTION_REFRESHED : "");
      expect(view.nextCursor).toBe("current-cursor");
      expect(view.editions[0].owned).toBe(0);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  }
);

it("does not issue browse requests until the set has been resolved", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(browseEditions).mockClear();
  vi.mocked(browseEditions).mockResolvedValue({ ...first, next_cursor: null });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ enabled }: { enabled: boolean }) {
    useCatalogBrowse(
      { set_id: enabled ? null : "unknown" },
      true,
      undefined,
      enabled
    );
    return null;
  }
  try {
    await act(async () => root.render(h(Probe, { enabled: false })));
    expect(browseEditions).not.toHaveBeenCalled();
    await act(async () => root.render(h(Probe, { enabled: true })));
    expect(browseEditions).toHaveBeenCalledExactlyOnceWith({ set_id: null });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
