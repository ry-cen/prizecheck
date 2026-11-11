// @vitest-environment jsdom
import { act, createElement as h, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi, type Mock } from "vitest";
import {
  DEFAULT_SORT,
  NO_FILTERS,
  type GalleryHolding,
  type GalleryQuery,
} from "./galleryModel";
import { EMPTY_SELECTION } from "./selectionModel";
import { useGalleryData } from "./useGalleryData";
import { useStaleCollection } from "./useStaleCollection";

// The quiet return refresh (slice 5, ticket 113) with the real useGalleryData and useStaleCollection, a server
// that answers when a test says so, and a probe component that records every render.

const server = vi.hoisted(() => {
  type Call = {
    resolve: () => void;
    reject: (error: Error) => void;
    revision: number;
  };
  const state = {
    revision: 1,
    /** When true a holdings read waits in `held` until the test settles it. */
    hold: false,
    held: [] as Call[],
    holdingsCalls: 0,
    revisionHeld: [] as ((revision: number) => void)[],
    holdRevision: false,
    snapshot: "",
  };
  return state;
});

vi.mock("../collection_generated", async (original) => ({
  ...(await original<typeof import("../collection_generated")>()),
  getCollectionHoldings: async () => {
    server.holdingsCalls++;
    const revision = server.revision;
    const page = () => ({
      snapshot: `s${revision}`,
      holdings: [
        {
          edition_id: "e",
          quantity: "1",
          version: revision,
          printing_id: "p",
          printing_name: `Card at ${revision}`,
          set_id: "s",
          set_name: "Set",
          set_code: "S",
          collector_number: "1",
          descriptor: {},
          image_url: null,
          location_id: "l",
          location_name: "L",
          location_path: "L",
          category: null,
          elemental_types: [],
          trainer_type: null,
        },
      ],
      owner_revision: revision,
      catalog_revision: 1,
      next_cursor: null,
      totals: { holdings: 1, editions: 1, copies: "1" },
      lent: "0",
    });
    if (!server.hold) {
      server.snapshot = `s${revision}`;
      return page();
    }
    return new Promise((resolve, reject) =>
      server.held.push({
        revision,
        resolve: () => {
          server.snapshot = `s${revision}`;
          resolve(page());
        },
        reject,
      })
    );
  },
  getBorrowedGallery: async () => ({
    copies: [],
    total: "0",
    owner_revision: server.revision,
    catalog_revision: 1,
    snapshot: server.snapshot,
  }),
  getCollectionRevision: () => {
    if (!server.holdRevision)
      return Promise.resolve({ owner_revision: server.revision });
    return new Promise<{ owner_revision: number }>((resolve) =>
      server.revisionHeld.push((revision) =>
        resolve({ owner_revision: revision })
      )
    );
  },
}));

type Frame = {
  stale: boolean;
  refreshing: boolean;
  revision: number | null;
  holdings: GalleryHolding[];
};
type Controls = { idle: boolean; active: boolean };

const QUERY: GalleryQuery = {
  view: "all",
  search: "",
  filters: NO_FILTERS,
  sort: DEFAULT_SORT,
};

let root: Root;
let host: HTMLElement;
let frames: Frame[];
let reload: () => void;
let treeLanded: boolean[];
let pendingTree: (() => void)[];
let clearSelection: Mock<() => void>;
let controls: Controls;

function Probe({ active, idle }: Controls) {
  const gallery = useGalleryData(QUERY, null);
  // The Location tree, as a revision and a ready flag, like the workspace's: a refresh of it holds the flag down
  // until the read lands.
  const [treeRevision, setTreeRevision] = useState(1);
  const [treeReady, setTreeReady] = useState(true);
  const loadTreeNow = () => {
    pendingTree.length = 0;
    setTreeRevision(server.revision);
    setTreeReady(true);
  };
  reload = () => {
    gallery.reload();
    loadTreeNow();
  };
  const staleness = useStaleCollection({
    userId: "collector",
    galleryRevision: gallery.ownerRevision,
    galleryStatus: gallery.refreshing ? "loading" : gallery.status,
    byKey: gallery.byKey,
    galleryKey: "all",
    reloadGallery: gallery.reload,
    treeRevision,
    treeReady,
    reloadTree: loadTreeNow,
    selected: EMPTY_SELECTION,
    clearSelection,
    busy: false,
    active,
    idle,
    refreshGallery: gallery.refresh,
    refreshTree: (mayLand) => {
      setTreeReady(false);
      pendingTree.push(() => {
        const lands = mayLand();
        treeLanded.push(lands);
        if (lands) setTreeRevision(server.revision);
        setTreeReady(true);
      });
    },
  });
  // One frame per commit: a render React discards (state set while rendering) is never on screen.
  useLayoutEffect(() => {
    frames.push({
      stale: staleness.stale,
      refreshing: gallery.refreshing,
      revision: gallery.ownerRevision,
      holdings: gallery.holdings,
    });
  });
  return null;
}

const show = (next: Partial<Controls>) => {
  controls = { ...controls, ...next };
  return act(async () => root.render(h(Probe, controls)));
};
const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
/** The Location tree read answers. */
const landTree = () =>
  act(async () => pendingTree.splice(0).forEach((answer) => answer()));
const last = () => frames[frames.length - 1];

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  Object.assign(server, {
    revision: 1,
    hold: false,
    held: [],
    holdingsCalls: 0,
    revisionHeld: [],
    holdRevision: false,
    snapshot: "",
  });
  frames = [];
  treeLanded = [];
  pendingTree = [];
  clearSelection = vi.fn();
  controls = { active: true, idle: true };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await show({});
  await flush();
  // Collection is loaded at revision 1 and shows no banner.
  expect(last()).toMatchObject({ revision: 1, stale: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (document as { visibilityState?: string }).visibilityState;
  vi.unstubAllGlobals();
});

/** Collection leaves the screen and the collector's holdings change elsewhere. */
async function leaveAndChange() {
  await show({ active: false });
  server.revision = 2;
}

it("an idle return refreshes once and no frame shows the banner, even when the change was seen while away", async () => {
  await leaveAndChange();
  // The tab regained focus while Collection was hidden: the revision is seen, so the banner is due.
  await act(async () => window.dispatchEvent(new Event("focus")));
  await flush();
  expect(last().stale).toBe(true);
  const before = frames.length;
  const calls = server.holdingsCalls;

  await show({ active: true });
  await flush();
  await landTree();

  expect(frames.slice(before).map((f) => f.stale)).not.toContain(true);
  expect(last()).toMatchObject({
    revision: 2,
    stale: false,
    refreshing: false,
  });
  expect(last().holdings[0].holding.printing_name).toBe("Card at 2");
  expect(server.holdingsCalls).toBe(calls + 1);
  expect(treeLanded).toEqual([true]);
});

it("the tiles stay on screen while the refresh reads, and are not stale or loading meanwhile", async () => {
  await leaveAndChange();
  const shown = last().holdings;
  server.hold = true;
  await show({ active: true });
  await flush();
  expect(server.held).toHaveLength(1);
  expect(last()).toMatchObject({ refreshing: true, stale: false, revision: 1 });
  expect(last().holdings).toBe(shown);
  await act(async () => server.held[0].resolve());
  await flush();
  await landTree();
  expect(last()).toMatchObject({
    refreshing: false,
    stale: false,
    revision: 2,
  });
});

it("a busy Collection does not refresh on return and shows the banner", async () => {
  await leaveAndChange();
  const calls = server.holdingsCalls;
  await show({ active: true, idle: false });
  await flush();
  expect(server.holdingsCalls).toBe(calls);
  expect(last()).toMatchObject({ revision: 1, stale: true, refreshing: false });
  expect(treeLanded).toEqual([]);
});

it("a selection that starts while the refresh reads keeps the old listing and shows the banner", async () => {
  await leaveAndChange();
  const shown = last().holdings;
  server.hold = true;
  await show({ active: true });
  await flush();
  expect(last().refreshing).toBe(true);

  // The collector selects copies (or opens Move) before the answer lands.
  await show({ idle: false });
  await act(async () => server.held[0].resolve());
  await flush();
  await landTree();

  expect(last().holdings).toBe(shown);
  expect(last()).toMatchObject({ revision: 1, refreshing: false, stale: true });
  expect(clearSelection).not.toHaveBeenCalled();
  expect(treeLanded).toEqual([false]);

  // Their own Reload brings the new listing, as for any banner.
  server.hold = false;
  await act(async () => reload());
  await flush();
  expect(last()).toMatchObject({ revision: 2, stale: false });
});

it("after a kept listing, the next idle return can still refresh quietly", async () => {
  await leaveAndChange();
  server.hold = true;
  await show({ active: true });
  await flush();
  await show({ idle: false });
  await act(async () => server.held[0].resolve());
  await flush();
  await landTree();
  expect(last()).toMatchObject({ revision: 1, stale: true });

  server.hold = false;
  await show({ active: false, idle: true });
  const shown = last().holdings;
  await show({ active: true });
  await flush();
  await landTree();
  expect(last()).toMatchObject({ revision: 2, stale: false });
  expect(last().holdings).not.toBe(shown);
});

it("when the re-read fails, refreshing ends, the old tiles stay and the banner shows", async () => {
  await leaveAndChange();
  const shown = last().holdings;
  server.hold = true;
  await show({ active: true });
  await flush();
  expect(last().refreshing).toBe(true);
  await act(async () => server.held[0].reject(new Error("offline")));
  await flush();
  await landTree();
  expect(last()).toMatchObject({ refreshing: false, stale: true, revision: 1 });
  expect(last().holdings).toBe(shown);
});

it("a Reload before the refresh lands ends refreshing and the late answer changes nothing", async () => {
  await leaveAndChange();
  server.hold = true;
  await show({ active: true });
  await flush();
  expect(last().refreshing).toBe(true);

  await act(async () => reload());
  expect(last().refreshing).toBe(false);
  await flush();
  expect(server.held).toHaveLength(2);
  // The older read answers late: it is dropped. The Reload's own read lands.
  await act(async () => server.held[0].resolve());
  await flush();
  expect(last().refreshing).toBe(false);
  await act(async () => server.held[1].resolve());
  await flush();
  expect(last()).toMatchObject({
    revision: 2,
    refreshing: false,
    stale: false,
  });
});

it("two quick returns refresh once", async () => {
  // First: the second return comes before the first revision read answers.
  await leaveAndChange();
  server.holdRevision = true;
  await show({ active: true });
  await show({ active: false });
  await show({ active: true });
  expect(server.revisionHeld).toHaveLength(2);
  const calls = server.holdingsCalls;
  await act(async () => server.revisionHeld.forEach((answer) => answer(2)));
  await flush();
  expect(server.holdingsCalls).toBe(calls + 1);
  expect(pendingTree).toHaveLength(1);
  await landTree();
  expect(last()).toMatchObject({ revision: 2, stale: false });

  // Second: the return comes while the first refresh is still reading.
  server.holdRevision = false;
  server.hold = true;
  await show({ active: false });
  server.revision = 3;
  await show({ active: true });
  await flush();
  expect(server.held).toHaveLength(1);
  await show({ active: false });
  await show({ active: true });
  await flush();
  expect(server.held).toHaveLength(1);
  expect(pendingTree).toHaveLength(1);
  await act(async () => server.held[0].resolve());
  await flush();
  await landTree();
  expect(last()).toMatchObject({
    revision: 3,
    stale: false,
    refreshing: false,
  });
});
