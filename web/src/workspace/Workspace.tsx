import { useFirstReadSettled } from "../shell/keptRead";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Camera as CameraIcon, Menu as MenuIcon, Plus } from "lucide-react";
import type { AddedCards } from "../catalog/useAddToast";
import {
  getLocationTree,
  type TreeLocation,
  type TreeNode,
} from "../location_generated";
import { BorrowedDialog } from "../loans/BorrowedDialog";
import { LendOfferDialog } from "../loans/LendOfferDialog";
import { LentOutDialog } from "../loans/LentOutDialog";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { SearchField } from "../ui/SearchField";
import { PhoneHeaderActions } from "../shell/HeaderActions";
import { openScanner } from "../shell/openScanner";
import { AddCardsGallery } from "./AddCardsGallery";
import { CorrectionsNotice } from "./CorrectionsNotice";
import { CreateLocationDialog } from "./CreateLocationDialog";
import { DeckHeading } from "./DeckHeading";
import { Gallery } from "./Gallery";
import {
  DisplayControls,
  FilterControls,
  FiltersDrawer,
  FiltersDrawerButton,
  FiltersToggle,
  SortControl,
} from "./GalleryControls";
import {
  activeFilterCount,
  plural,
  queryToParams,
  type DisplayPrefs,
  type GalleryFilters,
  type GalleryQuery,
} from "./galleryModel";
import { useGalleryPrefs } from "./galleryPrefs";
import { DetailsSheet, Inspector } from "./Inspector";
import type { LendRow } from "./inventoryActionsModel";
import { MoveDialog, RemovalDialog } from "./InventoryDialogs";
import {
  LocationNav,
  type DropTargets,
  type WorkspaceView,
} from "./LocationNav";
import { LocationSettings } from "./LocationSettings";
import { ManageLocations, ManageLocationsButton } from "./ManageLocations";
import { indexLocations, isFolder } from "./locationTree";
import { MOBILE_QUERY, useMediaQuery } from "./media";
import { focusWorkspaceHeading, SelectionBar } from "./SelectionBar";
import {
  selectedBorrowed,
  selectedGroups,
  selectionScope,
} from "./selectionModel";
import { StaleBanner } from "./StaleBanner";
import { DragBadge, useTileDrag } from "./tileDrag";
import { useUndoToast } from "./UndoToast";
import { useDebouncedValue } from "./useDebouncedValue";
import { useGalleryData } from "./useGalleryData";
import { PendingMoveNotice } from "./PendingMoveNotice";
import { useInventoryActions } from "./useInventoryActions";
import { useOwnedSets } from "./useOwnedSets";
import { useSelection } from "./useSelection";
import { useStaleCollection } from "./useStaleCollection";
import { clearLinkedLocation, readLinkedLocation } from "./workspaceLink";

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Props = {
  /** The signed-in user; their gallery preferences are stored under it in this browser. */
  userId: string;
  /** False while the app shell shows another page. The workspace stays mounted, hidden, and keeps its
   * state; document-level keys are ignored meanwhile, and showing it again checks for changes made on
   * other pages (#162). */
  active: boolean;
  /** Opens a Deck in the deck builder on Decks, from the open Deck's banner (#181). */
  onOpenDeck: (deckId: string) => void;
  /** Opens Collection Import (#226): Import… in the header, and Import from another tracker on an empty Collection. */
  onImport: () => void;
  /** Opens a Loan on the Loans tab (/loans/<id>), from the Lent out list (social network #253). */
  onOpenLoan: (loanId: string) => void;
};

/** The collector workspace (Collection, inside the app shell): the phone header, the Location sidebar
 * (desktop) or drawer (phone), and the gallery area. The shell draws the desktop header and the tabs. */
export function Workspace({
  userId,
  active,
  onOpenDeck,
  onImport,
  onOpenLoan,
}: Props) {
  const [nodes, setNodes] = useState<TreeLocation[]>([]);
  // Copies lent to Friends (#253): the tree's Lent out entry. A mocked tree may leave it out.
  const [lentCopies, setLentCopies] = useState("0");
  const [lentOpen, setLentOpen] = useState(false);
  // Friends' copies in the collector's Locations (#254): the tree's Borrowed entry.
  const [borrowedCopies, setBorrowedCopies] = useState("0");
  const [borrowedOpen, setBorrowedOpen] = useState(false);
  // Lend to a Friend… (#258): the selected copies being offered, or null while the dialog is closed.
  const [lending, setLending] = useState<LendRow[] | null>(null);
  const [ownerRevision, setOwnerRevision] = useState<number | null>(null);
  const [treeState, setTreeState] = useState<"loading" | "ready" | "error">(
    "loading"
  );
  const [view, setView] = useState<WorkspaceView>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState("");
  // The create form's preselected parent: undefined while closed, null for Top level.
  const [createFor, setCreateFor] = useState<string | null | undefined>(
    undefined
  );
  // Sort, filter values and display choices, remembered per user in this browser. Search text isn't.
  const [prefs, setPrefs] = useGalleryPrefs(userId);
  const display = prefs.display;
  const setDisplay = (next: DisplayPrefs) =>
    setPrefs((previous) => ({ ...previous, display: next }));
  const setFilters = (next: GalleryFilters) =>
    setPrefs((previous) => ({ ...previous, filters: next }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const marqueeArea = useRef<HTMLElement>(null);
  const filtersOpener = useRef<HTMLButtonElement>(null);
  const closeFiltersDrawer = useCallback(() => setFiltersDrawerOpen(false), []);
  const [manageOpen, setManageOpen] = useState(false);
  // A Location's settings (#292), opened from its gear in the sidebar or the drawer. On a phone it stacks over the
  // open drawer, so closing it can give focus back to the gear inside the drawer.
  const [settingsFor, setSettingsFor] = useState<{
    id: string;
    idPrefix: string;
    path: string;
    parentId: string | null;
  } | null>(null);
  const settingsOpener = useRef<HTMLElement | null>(null);
  // Where focus goes once the settings close or the Location is deleted, and where Collection goes after a delete.
  const [afterDelete, setAfterDelete] = useState<{
    id: string;
    parentId: string | null;
    idPrefix: string;
  } | null>(null);
  const [focusAfter, setFocusAfter] = useState<{
    id: string;
    parentId: string | null;
    idPrefix: string;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // The same line inside the phone drawer: the page behind a modal drawer is inert, so a delete made there is read here.
  const [drawerAnnouncement, setDrawerAnnouncement] = useState("");
  // Add cards (#175): open, and the Location it adds to (null: its picker chooses).
  const [adding, setAdding] = useState<{ fixed: string | null } | null>(null);
  const addOpener = useRef<HTMLButtonElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const drawerOpener = useRef<HTMLButtonElement>(null);
  // Each Edition's Storage Leaves as the inspector read them, per owner revision (#164).
  const ownedTotals: Parameters<typeof Inspector>[0]["ownedTotals"] = useRef(
    new Map()
  ).current;

  // Reloads can overlap (Reload, an action, Manage locations); only the newest one's answer lands,
  // so an older tree never replaces a newer one.
  const treeGeneration = useRef(0);
  const loadTree = useCallback(async () => {
    const generation = ++treeGeneration.current;
    setTreeState("loading");
    try {
      const result = await getLocationTree();
      if (generation !== treeGeneration.current) return;
      setNodes(result.locations);
      setLentCopies(result.lent_copies ?? "0");
      setBorrowedCopies(result.borrowed_copies ?? "0");
      setOwnerRevision(result.owner_revision);
      setTreeState("ready");
    } catch {
      if (generation !== treeGeneration.current) return;
      setTreeState("error");
    }
  }, []);
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const index = useMemo(() => indexLocations(nodes), [nodes]);
  const chosen = view === "all" ? undefined : index.byId.get(view);
  // Only a Storage Leaf or Deck opens. A Location that disappeared from the tree, or became a folder (Add child,
  // a nesting move, another tab), falls back to All owned; the gallery can't list a folder.
  const current = chosen && !isFolder(chosen) ? chosen : undefined;
  const heading = current?.name ?? "All owned";
  const galleryView: WorkspaceView = current ? view : "all";
  // A chosen Location that became a folder is left for good: if it later becomes a leaf again (its last child
  // moved out), the workspace must not jump back to it on its own. created() still ends on the new child.
  useEffect(() => {
    if (chosen && isFolder(chosen)) setView("all");
  }, [chosen]);
  // Typing settles for 250 ms before the gallery reloads. The selection scope ignores `sort`, so
  // sorting keeps the selection and search or filter changes clear it.
  const searchText = useDebouncedValue(query, 250);
  const galleryQuery: GalleryQuery = {
    view: galleryView,
    search: searchText,
    filters: prefs.filters,
    sort: prefs.sort,
  };
  const gallery = useGalleryData(galleryQuery, ownerRevision);
  useFirstReadSettled(
    treeState === "error" ||
      (treeState === "ready" && gallery.status !== "loading")
  );
  const galleryKey = JSON.stringify(queryToParams(galleryQuery));
  const sets = useOwnedSets(galleryView, gallery.ownerRevision);
  const narrowed =
    searchText.trim() !== "" || activeFilterCount(prefs.filters) > 0;
  const mobile = useMediaQuery(MOBILE_QUERY);
  const selection = useSelection({
    holdings: gallery.holdings,
    byKey: gallery.byKey,
    status: gallery.status,
    scope: selectionScope({ ...galleryQuery, search: searchText.trim() }),
    mobile,
    active,
  });
  // Browser Back or Forward can hide Collection while an overlay is open (it stays mounted, hidden), which
  // would leave a modal or a scroll lock over the page now shown. Leaving closes them all.
  const { closeDetails } = selection;
  useEffect(() => {
    if (active) return;
    setDrawerOpen(false);
    setFiltersDrawerOpen(false);
    closeDetails();
    setCreateFor(undefined);
    setManageOpen(false);
    setSettingsFor(null);
    setAdding(null);
    setLentOpen(false);
    setBorrowedOpen(false);
    setLending(null);
  }, [active, closeDetails]);
  // Ticket 107: Move, Inventory Removal and Undo, and the desktop tile drag.
  const actions = useInventoryActions({
    userId,
    selection,
    holdings: gallery.holdings,
    byKey: gallery.byKey,
    status: gallery.status,
    index,
    reloadGallery: gallery.reload,
    reloadTree: loadTree,
  });
  // Lend to a Friend… (#258) closing: its Dialog gives focus back to Actions, but an offer that went out cleared the
  // selection, and Actions with it, so the workspace heading takes focus then rather than the page.
  const lendingOpen = active && lending !== null;
  const wasLending = useRef(lendingOpen);
  useLayoutEffect(() => {
    if (
      wasLending.current &&
      !lendingOpen &&
      active &&
      !actions.actionsButton.current?.isConnected
    )
      focusWorkspaceHeading();
    wasLending.current = lendingOpen;
  }, [lendingOpen, active, actions.actionsButton]);
  const drag = useTileDrag({
    enabled: !mobile && !actions.busy,
    index,
    selection,
    onDrop: actions.dropMove,
  });
  // Ticket 113: the stale-collection banner. Changes made elsewhere show a banner with Reload;
  // nothing refreshes by itself.
  const staleness = useStaleCollection({
    userId,
    galleryRevision: gallery.ownerRevision,
    galleryStatus: gallery.status,
    byKey: gallery.byKey,
    galleryKey,
    reloadGallery: gallery.reload,
    treeRevision: ownerRevision,
    treeReady: treeState === "ready",
    reloadTree: loadTree,
    selected: selection.selected,
    clearSelection: actions.clearSelection,
    busy: actions.busy,
    active,
  });
  // Inspector totals are cached per owner revision ("<revision>:<edition>"). Older revisions' entries can't be
  // asked for again, so drop them whenever the gallery reads a new revision.
  useEffect(() => {
    const revision = gallery.ownerRevision;
    if (revision === null) return;
    const prefix = `${revision}:`;
    for (const key of ownedTotals.keys())
      if (!key.startsWith(prefix)) ownedTotals.delete(key);
  }, [gallery.ownerRevision, ownedTotals]);
  // Add cards opened from a Storage Leaf or Deck adds to it. When that Location is gone or became a folder (another
  // tab), Add cards stays open with its queue and asks for another Location, and never goes back to the old one by
  // itself if it becomes a leaf again.
  useEffect(() => {
    if (adding?.fixed && current?.id !== adding.fixed)
      setAdding({ fixed: null });
  }, [adding, current]);
  const locationPath = useCallback(
    (id: string) => (index.byId.has(id) ? index.path(id) : undefined),
    [index]
  );
  const locationName = useCallback(
    (id: string) => index.byId.get(id)?.name,
    [index]
  );
  // Add N cards closes Add cards and leaves the collector in the Location the cards went to, with its folders open,
  // and Collection's toast offers Undo. The popup's Add N inside it leaves it open.
  const addedCards = (added: AddedCards) => {
    if (added.from === "bar") {
      setAdding(null);
      setExpanded(
        (previous) =>
          new Set([...previous, ...index.ancestors(added.locationId)])
      );
      setView(added.locationId);
    }
    void actions.added(added);
  };
  // A new view, search, filter or sort starts at the top of its gallery.
  useEffect(() => {
    if (active) window.scrollTo(0, 0);
  }, [galleryKey]);

  // A link from the Decks page (/workspace?location=<id>) opens that Storage Leaf or Deck once the tree
  // has loaded, with its folders expanded. The address is cleaned at once, so a reload opens All owned.
  // A missing id or a folder id leaves the workspace at All owned.
  const linked = useRef<string | null>(null);
  const linkReloaded = useRef<string | null>(null);
  useEffect(() => {
    if (!active) return;
    const id = readLinkedLocation();
    if (id) linked.current = id;
    clearLinkedLocation();
  }, [active]);
  useEffect(() => {
    const id = linked.current;
    if (!active || !id || treeState !== "ready") return;
    const node = index.byId.get(id);
    if (!node && linkReloaded.current !== id) {
      linkReloaded.current = id;
      void loadTree();
      return;
    }
    linked.current = null;
    if (!node || node.kind === "organization") return;
    setExpanded((previous) => new Set([...previous, ...index.ancestors(id)]));
    setView(id);
  }, [active, index, treeState, loadTree]);

  function toggleFolder(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function choose(next: WorkspaceView) {
    setView(next);
    setDrawerOpen(false);
  }
  function openCreate(parentId: string | null) {
    setDrawerOpen(false);
    setCreateFor(parentId);
  }
  function openManage() {
    setDrawerOpen(false);
    setManageOpen(true);
  }
  // Select the new Location with its ancestor path expanded. The parent was a leaf or a folder
  // before, so its own ancestors are already in the index; the reload adds the new node.
  async function created(location: TreeNode) {
    const parentId = location.parent_id;
    if (parentId)
      setExpanded(
        (previous) =>
          new Set([...previous, parentId, ...index.ancestors(parentId)])
      );
    await loadTree();
    setView(location.id);
    setCreateFor(undefined);
  }

  // The drawer only exists on mobile; widening the window closes it.
  useEffect(() => {
    if (!drawerOpen) return;
    const media = window.matchMedia(MOBILE_QUERY);
    const onChange = () => {
      if (!media.matches) {
        setDrawerOpen(false);
        // Settings opened over the drawer close in the same commit, so the scroll lock is restored in order.
        setSettingsFor((open) => (open?.idPrefix === "drawer" ? null : open));
      }
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [drawerOpen]);

  // A Location's settings (#292). The drawer stays open behind them on a phone.
  function openSettings(id: string, opener: HTMLElement, idPrefix: string) {
    settingsOpener.current = opener;
    setAnnouncement("");
    setDrawerAnnouncement("");
    setSettingsFor({
      id,
      idPrefix,
      path: index.path(id),
      parentId: index.byId.get(id)?.parent_id ?? null,
    });
  }
  function closeSettings() {
    if (settingsFor)
      setFocusAfter({
        id: settingsFor.id,
        parentId: settingsFor.parentId,
        idPrefix: settingsFor.idPrefix,
      });
    setSettingsFor(null);
  }
  function settingsDeleted(deleted: {
    id: string;
    parentId: string | null;
    path: string;
  }) {
    const idPrefix = settingsFor?.idPrefix ?? "sidebar";
    const text = `Deleted ${deleted.path}.`;
    setAnnouncement(idPrefix === "drawer" ? "" : text);
    setDrawerAnnouncement(idPrefix === "drawer" ? text : "");
    setAfterDelete({
      id: deleted.id,
      parentId: deleted.parentId,
      idPrefix,
    });
    setSettingsFor(null);
  }
  // While the settings are open, the Location's row stays revealed, even after a Move into a collapsed folder.
  useEffect(() => {
    if (!settingsFor || !index.byId.has(settingsFor.id)) return;
    const ancestors = index.ancestors(settingsFor.id);
    setExpanded((previous) =>
      ancestors.every((id) => previous.has(id))
        ? previous
        : new Set([...previous, ...ancestors])
    );
  }, [settingsFor, index]);
  // After a delete (the tree is already read again): the open Location's parent opens, unless it is a folder,
  // and then Collection shows All owned. The parent's ancestors stay expanded so its row shows.
  useEffect(() => {
    if (!afterDelete) return;
    const { id, parentId, idPrefix } = afterDelete;
    setAfterDelete(null);
    const parent = parentId ? index.byId.get(parentId) : undefined;
    if (view === id) setView(parent && !isFolder(parent) ? parent.id : "all");
    if (parent) {
      const ancestors = index.ancestors(parent.id);
      setExpanded((previous) => new Set([...previous, ...ancestors]));
    }
    setFocusAfter({ id, parentId, idPrefix });
  }, [afterDelete, index, view]);
  // Focus after the settings close: the Location's gear, or when it is gone the nearest shown ancestor row, or
  // else the tree's All owned row. Lookups are by the tree they were opened from; the other tree is hidden.
  useEffect(() => {
    if (!focusAfter) return;
    const { id, idPrefix } = focusAfter;
    setFocusAfter(null);
    const shown = (elementId: string) => {
      const element = document.getElementById(elementId);
      return element && element.getClientRects().length > 0 ? element : null;
    };
    const parentId = index.byId.get(id)?.parent_id ?? focusAfter.parentId;
    const rows =
      parentId && index.byId.has(parentId)
        ? [parentId, ...index.ancestors(parentId)]
        : [];
    (
      shown(`${idPrefix}-settings-${id}`) ??
      rows.map((row) => shown(`${idPrefix}-row-${row}`)).find(Boolean) ??
      shown(`${idPrefix}-all`) ??
      shown(`${idPrefix === "drawer" ? "sidebar" : "drawer"}-all`)
    )?.focus();
  }, [focusAfter, index]);

  const search = (
    <SearchField
      label="Search cards"
      placeholder="Search your cards…"
      autoComplete="off"
      maxLength={120}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );
  // The + beside the Locations heading (sidebar) or atop the drawer, then the Manage locations gear.
  const locationTools = (
    <>
      <Button
        variant="quiet"
        icon={Plus}
        label="Add location"
        title="Add top-level location"
        onClick={() => openCreate(null)}
      />
      <ManageLocationsButton onClick={openManage} />
    </>
  );

  const tree = (idPrefix: string, drop?: DropTargets | null) =>
    treeState === "error" ? (
      <div
        className="mx-3 flex flex-col items-start gap-2 text-meta text-text-muted"
        role="alert"
      >
        <p className="m-0">Locations are temporarily unavailable.</p>
        <Button onClick={() => void loadTree()}>Retry</Button>
      </div>
    ) : treeState === "loading" && ownerRevision === null ? (
      <p className="mx-3 my-0 text-meta text-text-muted" role="status">
        Loading locations…
      </p>
    ) : (
      <LocationNav
        index={index}
        view={galleryView}
        expanded={expanded}
        onToggle={toggleFolder}
        onChoose={choose}
        idPrefix={idPrefix}
        onAddChild={openCreate}
        onOpenSettings={(id, opener) => openSettings(id, opener, idPrefix)}
        drop={drop}
        touch={idPrefix === "drawer"}
        lent={{
          copies: lentCopies,
          onOpen: () => {
            setDrawerOpen(false);
            setLentOpen(true);
          },
        }}
        borrowed={{
          copies: borrowedCopies,
          onOpen: () => {
            setDrawerOpen(false);
            setBorrowedOpen(true);
          },
        }}
      />
    );

  // Ticket 107's toast on the kit's toast host (#165). It shows only while Collection is the shown page;
  // kit dialogs, the Filters & display drawer among them, make it inert themselves (#166).
  const undoToast = useUndoToast({
    toast: actions.toast,
    busy: actions.busy,
    shown: active,
    onUndo: actions.undo,
    onDismiss: actions.dismiss,
    onClose: actions.closeToast,
  });

  // The skip link past the cards: focus the toast's first usable button (Undo), or else the selection
  // bar's first visible control. #107 sends focus to the heading after a Move, which is otherwise a Tab
  // through every tile away.
  function focusDock() {
    if (undoToast.focus()) return;
    const target = Array.from(
      dockRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
    ).find((element) => element.getClientRects().length > 0);
    target?.focus();
  }
  const dockHasControls =
    actions.toast !== null || selection.summary.copies > 0;

  return (
    // Collection's own root (#166 retired the workspace CSS root and the old .legacy wrapper): the kit's body type
    // (14 px at the tokens' line height) on the theme background, and border-box sizing for everything inside,
    // as the workspace CSS gave it (Preflight does the same since #184).
    <div
      data-collection-page=""
      className="box-border min-h-[calc(100dvh-var(--layout-header-height))] bg-bg font-sans text-body leading-(--line-height) text-text scheme-dark [&_*]:box-border"
    >
      <p className="sr-only" role="status" data-testid="location-announcement">
        {announcement}
      </p>
      {/* The phone header (the shell draws the desktop one, and the skip link): ☰ for the Location
          drawer, the page title (for screen readers only: the tab bar marks the section, and Search needs the room
          once the bell joins the header actions, #259), then Search, Filters & display and the shell's phone header
          actions (#246). */}
      <header className="box-border hidden h-header items-center gap-0 border-b border-border px-0 phone:flex collection-pinned:sticky collection-pinned:top-0 collection-pinned:z-(--layer-sticky) collection-pinned:bg-bg">
        <Button
          ref={drawerOpener}
          variant="quiet"
          icon={MenuIcon}
          label="Open locations"
          className="shrink-0"
          aria-haspopup="dialog"
          aria-expanded={drawerOpen}
          onClick={() => setDrawerOpen(true)}
        />
        <span className="sr-only">Collection</span>
        <div className="mr-1 min-w-0 flex-1">{search}</div>
        <FiltersDrawerButton
          ref={filtersOpener}
          filters={prefs.filters}
          open={filtersDrawerOpen}
          onOpen={() => setFiltersDrawerOpen(true)}
        />
        {/* The camera button sits with the header actions (one gap, 4 px, not two): Search needs 44 px at 375. */}
        <div className="flex shrink-0 items-center gap-0 [&>div]:gap-0">
          <Button
            variant="quiet"
            icon={CameraIcon}
            label="Scan cards"
            onClick={openScanner}
          />
          <PhoneHeaderActions />
        </div>
      </header>
      <div className="grid min-h-[calc(100dvh-var(--layout-header-height))] grid-cols-[var(--layout-sidebar-width)_minmax(0,1fr)] phone:block">
        <aside
          className="box-border min-w-0 border-r border-border px-4 py-7 phone:hidden"
          aria-label="Sidebar"
        >
          <div className="mr-2 mb-4 ml-3 flex items-center justify-between gap-2">
            <h2 className="m-0 text-micro font-semibold tracking-[1.7px] text-text-subtle uppercase">
              Locations
            </h2>
            <span className="flex items-center gap-1">{locationTools}</span>
          </div>
          {tree("sidebar", drag.drop)}
        </aside>
        {/* The gallery area takes the remaining height (ticket 105: empty space below it starts a
            marquee). The bottom padding on a phone keeps the selection strip off the last row. */}
        <main
          ref={marqueeArea}
          className="box-border flex min-w-0 flex-col select-none px-(--layout-gutter) pt-7 pb-12 phone:pt-5 phone:pb-24"
          aria-labelledby="ws-heading"
        >
          <div
            data-no-marquee
            className="mb-5 flex items-baseline gap-4 phone:flex-wrap phone:gap-y-2"
          >
            <h1
              id="ws-heading"
              className="m-0 text-display font-[550] tracking-[-0.5px] wrap-anywhere"
            >
              {heading}
            </h1>
            {gallery.totals && (
              <p className="m-0 text-meta text-text-subtle tabular-nums">
                {plural(gallery.totals.copies, "copy", "copies")} ·{" "}
                {plural(gallery.totals.editions, "edition", "editions")}
                {gallery.totals.lent > 0 &&
                  ` · ${gallery.totals.lent} lent out`}
                {gallery.totals.borrowed > 0 &&
                  ` · ${gallery.totals.borrowed} borrowed`}
              </p>
            )}
            {/* The actions wrap as one group, and on a phone they always take their own row, so the totals
                arriving after each listing loads never move a button under a finger. */}
            <div className="ml-auto flex items-center gap-4 self-center phone:basis-full phone:flex-wrap phone:justify-start phone:gap-2">
              <Button
                ref={addOpener}
                aria-haspopup="dialog"
                onClick={() => setAdding({ fixed: current?.id ?? null })}
              >
                Add cards
              </Button>
              <Button onClick={openScanner}>Scan cards</Button>
              <Button onClick={onImport}>Import…</Button>
              {/* Mobile Select mode's toggle, on a phone only. */}
              <span className="hidden phone:flex">
                <Button
                  aria-pressed={selection.selectMode}
                  onClick={() => selection.setSelectMode(!selection.selectMode)}
                >
                  Select
                </Button>
              </span>
            </div>
          </div>
          {current?.kind === "deck" && (
            <DeckHeading
              key={current.id}
              deckId={current.id}
              inventoryRevision={gallery.ownerRevision}
              onOpenDeck={onOpenDeck}
            />
          )}
          {/* Desktop toolbar: Search and Filters on the left; Sort, Card size, Names and Prices pushed
              right, all at the kit's control height. Narrow desktop widths wrap the right group. */}
          <div
            data-no-marquee
            className="flex flex-wrap items-center gap-2 phone:hidden"
          >
            <div className="max-w-105 min-w-0 flex-[1_1_180px]">{search}</div>
            <FiltersToggle
              filters={prefs.filters}
              open={filtersOpen}
              onToggle={() => setFiltersOpen((open) => !open)}
            />
            <div className="ml-auto flex items-center gap-2">
              <SortControl
                sort={prefs.sort}
                onChange={(sort) =>
                  setPrefs((previous) => ({ ...previous, sort }))
                }
              />
              <DisplayControls display={display} onChange={setDisplay} />
            </div>
          </div>
          {filtersOpen && (
            <section
              id="ws-filter-panel"
              className="mt-3 box-border rounded-panel border border-border bg-surface px-4 py-3 phone:hidden"
              aria-label="Card filters"
            >
              <FilterControls
                filters={prefs.filters}
                sets={sets}
                onChange={setFilters}
              />
            </section>
          )}
          <StaleBanner
            active={active}
            stale={staleness.stale}
            note={staleness.note}
            busy={actions.busy}
            onReload={staleness.reload}
            onDismissNote={staleness.dismissNote}
          />
          <CorrectionsNotice
            holdings={gallery.holdings}
            status={gallery.status}
            galleryKey={galleryKey}
            ownerRevision={gallery.ownerRevision}
            catalogRevision={gallery.catalogRevision}
            onChanged={async () => {
              gallery.reload();
              await loadTree();
            }}
          />
          {dockHasControls && (
            // Ticket 114: hidden above the viewport until focused, like the shell's skip link.
            <a
              className="fixed top-2 left-2 z-(--layer-modal) box-border inline-flex min-h-tap -translate-y-[calc(100%+var(--space-4))] items-center rounded-control border border-control-outline bg-surface-raised px-3 py-2 text-body font-semibold text-text no-underline focus:translate-y-0"
              href="#ws-dock"
              onClick={(event) => {
                event.preventDefault();
                focusDock();
              }}
            >
              Skip to selection actions and Undo
            </a>
          )}
          {/* The gallery and the inspector column, which keeps its width while idle. */}
          <div className="grid flex-[1_0_auto] grid-cols-[minmax(0,1fr)_var(--layout-inspector-width)] gap-7 compact:grid-cols-[minmax(0,1fr)_var(--layout-inspector-width-compact)] compact:gap-5 phone:block">
            <Gallery
              marqueeArea={marqueeArea}
              data={gallery}
              display={display}
              caption={galleryView === "all"}
              locationName={locationName}
              emptyMessage={
                narrowed
                  ? "No cards match your search or filters."
                  : galleryView === "all"
                    ? "Your Collection has no cards yet."
                    : "This Location has no cards."
              }
              emptyAction={
                galleryView === "all" && !narrowed ? (
                  <Button onClick={onImport}>
                    Import from another tracker
                  </Button>
                ) : undefined
              }
              onRetry={gallery.reload}
              selected={selection.selected}
              selectMode={selection.selectMode}
              onTile={selection.activate}
              onMarquee={selection.marquee}
              onTilePointerDown={drag.start}
            />
            <div data-no-marquee>
              <Inspector
                card={selection.inspected}
                locationPath={locationPath}
                ownerRevision={gallery.ownerRevision}
                ownedTotals={ownedTotals}
              />
            </div>
          </div>
        </main>
      </div>
      {active && actions.pending && (
        <PendingMoveNotice
          key={actions.pending.id}
          text={actions.pending.text}
          blocked={actions.pending.blocked}
          otherTab={actions.pending.otherTab}
          onRefresh={() => void actions.refreshPending()}
          busy={actions.busy}
          onCheck={actions.checkPending}
          onDismiss={actions.dismissPending}
        />
      )}
      {/* The selection bar (the Actions strip). It and the dialogs below draw outside the page
          (KitLayer, #165), so they are drawn only while Collection is the shown page; their state
          stays, and they show again when it does. */}
      {active && selection.summary.copies > 0 && (
        <SelectionBar
          summary={selection.summary}
          onClear={actions.clearSelection}
          onDetails={selection.openDetails}
          onMove={actions.openMove}
          onRemove={actions.openRemoval}
          onLend={() => setLending(actions.lendRows())}
          busy={actions.busy}
          status={actions.dialog ? "" : actions.progress}
          error={actions.barError}
          actionsRef={actions.actionsButton}
          barRef={dockRef}
        />
      )}
      {/* A Location's settings, before the drawer so that when both close in one commit this one unmounts first and
          the body's scroll lock is restored in order. It is a sibling of the drawer, never inside it. */}
      {active && settingsFor && (
        <LocationSettings
          key={settingsFor.id}
          nodes={nodes}
          id={settingsFor.id}
          openedPath={settingsFor.path}
          returnFocus={settingsOpener}
          onClose={closeSettings}
          onChanged={async () => {
            gallery.reload();
            await loadTree();
          }}
          onDeleted={settingsDeleted}
          onOpenDeck={(deckId) => {
            setSettingsFor(null);
            setDrawerOpen(false);
            onOpenDeck(deckId);
          }}
        />
      )}
      {/* The phone Location drawer: the kit Dialog along the left edge. Its close button is the first
          focus stop; focus returns to ☰ when it closes. */}
      <Dialog
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        returnFocus={drawerOpener}
        title="Locations"
        closeLabel="Close locations"
        side="left"
      >
        <div className="flex flex-col gap-4">
          <p
            className="sr-only"
            role="status"
            data-testid="drawer-location-announcement"
          >
            {drawerAnnouncement}
          </p>
          <div className="flex items-center justify-end gap-1">
            {locationTools}
          </div>
          {tree("drawer")}
        </div>
      </Dialog>
      {filtersDrawerOpen && (
        <FiltersDrawer
          opener={filtersOpener}
          prefs={prefs}
          sets={sets}
          onChange={setPrefs}
          onClose={closeFiltersDrawer}
        />
      )}
      {active && createFor !== undefined && (
        <CreateLocationDialog
          index={index}
          initialParentId={createFor}
          onCreated={created}
          onCancel={() => setCreateFor(undefined)}
          onTreeChanged={loadTree}
        />
      )}
      <AddCardsGallery
        open={active && adding !== null}
        target={
          adding?.fixed && index.byId.has(adding.fixed)
            ? { id: adding.fixed, label: index.path(adding.fixed) }
            : null
        }
        onClose={() => setAdding(null)}
        onAdded={addedCards}
        onTargetGone={() => void loadTree()}
        returnFocus={addOpener}
      />
      {manageOpen && (
        <ManageLocations
          onClose={() => setManageOpen(false)}
          onChanged={() => {
            void loadTree();
            gallery.reload();
          }}
        />
      )}
      <LentOutDialog
        open={active && lentOpen}
        onClose={() => setLentOpen(false)}
        onOpenLoan={onOpenLoan}
        returnFocus={mobile ? drawerOpener : undefined}
      />
      <LendOfferDialog
        open={lendingOpen}
        rows={lending ?? []}
        onClose={() => setLending(null)}
        onSent={actions.clearSelection}
        onOpenLoan={(id) => {
          setLending(null);
          onOpenLoan(id);
        }}
        returnFocus={actions.actionsButton}
      />
      <BorrowedDialog
        open={active && borrowedOpen}
        onClose={() => setBorrowedOpen(false)}
        index={index}
        onMoved={() => void loadTree()}
        returnFocus={mobile ? drawerOpener : undefined}
      />
      {selection.details && (
        <DetailsSheet
          card={selection.details}
          locationPath={locationPath}
          ownerRevision={gallery.ownerRevision}
          ownedTotals={ownedTotals}
          onClose={selection.closeDetails}
        />
      )}
      {active && actions.dialog === "move" && (
        <MoveDialog
          index={index}
          initialExpanded={expanded}
          groups={selectedGroups(selection.selected)}
          borrowed={selectedBorrowed(selection.selected)}
          copies={selection.summary.copies}
          busy={actions.busy}
          progress={actions.progress}
          error={actions.dialogError}
          onConfirm={actions.confirmMove}
          onCancel={actions.closeDialog}
        />
      )}
      {active && actions.dialog === "remove" && (
        <RemovalDialog
          rows={actions.removalRows}
          copies={selection.summary.copies}
          busy={actions.busy}
          progress={actions.progress}
          error={actions.dialogError}
          onConfirm={actions.confirmRemoval}
          onCancel={actions.closeDialog}
        />
      )}
      <DragBadge badge={drag.badge} />
    </div>
  );
}
