import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Menu as MenuIcon } from "lucide-react";
import { getLocationTree, type TreeNode } from "../location_generated";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { AddCardsDialog } from "./AddCardsDialog";
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
import { MoveDialog, RemovalDialog } from "./InventoryDialogs";
import {
  LocationNav,
  type DropTargets,
  type WorkspaceView,
} from "./LocationNav";
import { ManageLocations, ManageLocationsButton } from "./ManageLocations";
import { indexLocations, isFolder } from "./locationTree";
import { MOBILE_QUERY, useMediaQuery } from "./media";
import { SelectionBar } from "./SelectionBar";
import { selectedGroups, selectionScope } from "./selectionModel";
import { StaleBanner } from "./StaleBanner";
import { DragBadge, useTileDrag } from "./tileDrag";
import { UndoToast } from "./UndoToast";
import { useDebouncedValue } from "./useDebouncedValue";
import { useGalleryData } from "./useGalleryData";
import { useInventoryActions } from "./useInventoryActions";
import { useOwnedSets } from "./useOwnedSets";
import { useSelection } from "./useSelection";
import { useStaleCollection } from "./useStaleCollection";
import { clearLinkedLocation, readLinkedLocation } from "./workspaceLink";
import "./Workspace.css";

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Props = {
  /** The signed-in user; their gallery preferences are stored under it in this browser. */
  userId: string;
  /** False while the app shell shows another page. The workspace stays mounted, hidden, and keeps its
   * state; document-level keys are ignored meanwhile, and showing it again checks for changes made on
   * other pages (#162). */
  active: boolean;
};

/** The collector workspace (Collection, inside the app shell): the phone header, the Location sidebar
 * (desktop) or drawer (phone), and the gallery area. The shell draws the desktop header and the tabs. */
export function Workspace({ userId, active }: Props) {
  const [nodes, setNodes] = useState<TreeNode[]>([]);
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
  const filtersOpener = useRef<HTMLButtonElement>(null);
  const closeFiltersDrawer = useCallback(() => setFiltersDrawerOpen(false), []);
  const [manageOpen, setManageOpen] = useState(false);
  const [addFor, setAddFor] = useState<string | null>(null);
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
    setAddFor(null);
  }, [active, closeDetails]);
  // Ticket 107: Move, Inventory Removal and Undo, and the desktop tile drag.
  const actions = useInventoryActions({
    selection,
    holdings: gallery.holdings,
    byKey: gallery.byKey,
    status: gallery.status,
    index,
    reloadGallery: gallery.reload,
    reloadTree: loadTree,
  });
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
  // Add cards belongs to the open Storage Leaf or Deck. When that Location is gone, became a folder or is no longer
  // open, forget it, so the dialog never reopens by itself if the Location becomes a leaf again.
  useEffect(() => {
    if (addFor !== null && current?.id !== addFor) setAddFor(null);
  }, [addFor, current]);
  const locationPath = useCallback(
    (id: string) => (index.byId.has(id) ? index.path(id) : undefined),
    [index]
  );
  const locationName = useCallback(
    (id: string) => index.byId.get(id)?.name,
    [index]
  );
  // A new view, search, filter or sort starts at the top of its gallery.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [galleryKey]);

  // A link from the Decks page (/workspace?location=<id>) opens that Storage Leaf or Deck once the tree
  // has loaded, with its folders expanded. The address is cleaned at once, so a reload opens All owned.
  // A missing id or a folder id leaves the workspace at All owned.
  const [initialLink] = useState(readLinkedLocation);
  const linked = useRef<string | null>(initialLink);
  useEffect(() => {
    clearLinkedLocation();
  }, []);
  useEffect(() => {
    const id = linked.current;
    if (!id || treeState !== "ready") return;
    linked.current = null;
    const node = index.byId.get(id);
    if (!node || node.kind === "organization") return;
    setExpanded((previous) => new Set([...previous, ...index.ancestors(id)]));
    setView(id);
  }, [index, treeState]);

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
      if (!media.matches) setDrawerOpen(false);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [drawerOpen]);

  const search = (className: string) => (
    <input
      type="search"
      className={`ws-search ${className}`}
      aria-label="Search cards"
      placeholder="Search your cards…"
      autoComplete="off"
      maxLength={120}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );

  const tree = (idPrefix: string, drop?: DropTargets | null) =>
    treeState === "error" ? (
      <div className="ws-tree-status" role="alert">
        <p>Locations are temporarily unavailable.</p>
        <button type="button" onClick={() => void loadTree()}>
          Retry
        </button>
      </div>
    ) : treeState === "loading" && ownerRevision === null ? (
      <p className="ws-tree-status" role="status">
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
        drop={drop}
      />
    );

  // The skip link past the cards: focus the dock's first visible control (the toast's Undo, or the
  // selection bar). #107 sends focus to the heading after a Move, which is otherwise a Tab through every tile away.
  function focusDock() {
    const target = Array.from(
      dockRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
    ).find((element) => element.getClientRects().length > 0);
    target?.focus();
  }
  const dockHasControls =
    actions.toast !== null || selection.summary.copies > 0;

  return (
    <div className="ws-root">
      <div className="ws-surface" inert={filtersDrawerOpen}>
        {/* The phone header (the shell draws the desktop one, and the skip link): ☰ for the Location
            drawer, the page title, then Search and Filters & display. */}
        <header className="ws-header ws-phone-header">
          <button
            type="button"
            ref={drawerOpener}
            className="ws-header-icon"
            aria-label="Open locations"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Icon icon={MenuIcon} size={20} />
          </button>
          <span className="ws-phone-title">Collection</span>
          {search("ws-mobile-only ws-header-search")}
          <FiltersDrawerButton
            ref={filtersOpener}
            filters={prefs.filters}
            open={filtersDrawerOpen}
            onOpen={() => setFiltersDrawerOpen(true)}
          />
        </header>
        <div className="ws-layout">
          <aside className="ws-sidebar ws-desktop-only" aria-label="Sidebar">
            <div className="ws-location-heading">
              <h2>Locations</h2>
              <span className="ws-location-tools">
                <button
                  type="button"
                  aria-label="Add location"
                  title="Add top-level location"
                  onClick={() => openCreate(null)}
                >
                  <span aria-hidden="true">+</span>
                </button>
                <ManageLocationsButton onClick={openManage} />
              </span>
            </div>
            {tree("ws-sidebar", drag.drop)}
          </aside>
          <main className="ws-main" aria-labelledby="ws-heading">
            <div className="ws-heading">
              <h1 id="ws-heading">{heading}</h1>
              {gallery.totals && (
                <p className="ws-heading-counts">
                  {plural(gallery.totals.copies, "copy", "copies")} ·{" "}
                  {plural(gallery.totals.editions, "edition", "editions")}
                </p>
              )}
              {current && (
                <button
                  type="button"
                  className="ws-add-cards-button"
                  onClick={() => current && setAddFor(current.id)}
                >
                  Add cards
                </button>
              )}
              <button
                type="button"
                className="ws-select-toggle ws-mobile-only"
                aria-pressed={selection.selectMode}
                onClick={() => selection.setSelectMode(!selection.selectMode)}
              >
                Select
              </button>
            </div>
            {current?.kind === "deck" && (
              <DeckHeading
                key={current.id}
                deckId={current.id}
                deckName={current.name}
                inventoryRevision={gallery.ownerRevision}
              />
            )}
            <div className="ws-toolbar ws-desktop-only">
              {search("ws-toolbar-search")}
              <FiltersToggle
                filters={prefs.filters}
                open={filtersOpen}
                onToggle={() => setFiltersOpen((open) => !open)}
              />
              <div className="ws-display-controls">
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
                className="ws-filter-panel ws-desktop-only"
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
              <a
                className="ws-skip-link"
                href="#ws-dock"
                onClick={(event) => {
                  event.preventDefault();
                  focusDock();
                }}
              >
                Skip to selection actions and Undo
              </a>
            )}
            <div className="ws-gallery-layout">
              <Gallery
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
                onRetry={gallery.reload}
                selected={selection.selected}
                selectMode={selection.selectMode}
                onTile={selection.activate}
                onHover={selection.hover}
                onMarquee={selection.marquee}
                onTilePointerDown={drag.start}
              />
              <Inspector
                card={selection.inspected}
                locationPath={locationPath}
                ownerRevision={gallery.ownerRevision}
                ownedTotals={ownedTotals}
              />
            </div>
          </main>
        </div>
        {/* The bottom dock: the success and Undo toast sits above the selection bar. */}
        <div className="ws-dock" id="ws-dock" ref={dockRef}>
          <UndoToast
            toast={actions.toast}
            busy={actions.busy}
            onUndo={actions.undo}
            onDismiss={actions.dismiss}
            onClose={actions.closeToast}
            toastRef={actions.toastRef}
          />
          {selection.summary.copies > 0 && (
            <SelectionBar
              summary={selection.summary}
              onClear={actions.clearSelection}
              onDetails={selection.openDetails}
              onMove={actions.openMove}
              onRemove={actions.openRemoval}
              busy={actions.busy}
              status={actions.dialog ? "" : actions.progress}
              error={actions.barError}
              actionsRef={actions.actionsButton}
            />
          )}
        </div>
      </div>
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
        <div className="ws-location-drawer">
          <div className="ws-location-tools ws-drawer-tools">
            <button
              type="button"
              aria-label="Add location"
              title="Add top-level location"
              onClick={() => openCreate(null)}
            >
              <span aria-hidden="true">+</span>
            </button>
            <ManageLocationsButton onClick={openManage} />
          </div>
          {tree("ws-drawer")}
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
      {createFor !== undefined && (
        <CreateLocationDialog
          index={index}
          initialParentId={createFor}
          onCreated={created}
          onCancel={() => setCreateFor(undefined)}
          onTreeChanged={loadTree}
        />
      )}
      {current && addFor === current.id && (
        <AddCardsDialog
          key={current.id}
          locationId={current.id}
          locationName={current.name}
          path={index.path(current.id)}
          onAdded={async () => {
            gallery.reload();
            await loadTree();
          }}
          onClose={() => setAddFor(null)}
        />
      )}
      {manageOpen && (
        <ManageLocations
          onClose={() => setManageOpen(false)}
          onChanged={() => {
            void loadTree();
            gallery.reload();
          }}
        />
      )}
      {selection.details && (
        <DetailsSheet
          card={selection.details}
          locationPath={locationPath}
          ownerRevision={gallery.ownerRevision}
          ownedTotals={ownedTotals}
          onClose={selection.closeDetails}
        />
      )}
      {actions.dialog === "move" && (
        <MoveDialog
          index={index}
          initialExpanded={expanded}
          groups={selectedGroups(selection.selected)}
          copies={selection.summary.copies}
          busy={actions.busy}
          progress={actions.progress}
          error={actions.dialogError}
          onConfirm={actions.confirmMove}
          onCancel={actions.closeDialog}
        />
      )}
      {actions.dialog === "remove" && (
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
