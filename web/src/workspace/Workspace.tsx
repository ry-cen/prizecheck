import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getLocationTree, type TreeNode } from "../location_generated";
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
import { LocationNav, type WorkspaceView } from "./LocationNav";
import { ManageLocations, ManageLocationsButton } from "./ManageLocations";
import { indexLocations } from "./locationTree";
import { MOBILE_QUERY, useMediaQuery } from "./media";
import { SelectionBar } from "./SelectionBar";
import { selectionScope } from "./selectionModel";
import { useDebouncedValue } from "./useDebouncedValue";
import { useGalleryData } from "./useGalleryData";
import { useOwnedSets } from "./useOwnedSets";
import { useSelection } from "./useSelection";
import { clearLinkedLocation, readLinkedLocation } from "./workspaceLink";
import "./Workspace.css";

const FOCUSABLE =
  'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

type Props = {
  /** The signed-in user; their gallery preferences are stored under it in this browser. */
  userId: string;
  /** Opens the existing Locations view. */
  onOpenLocations: () => void;
  onSignOut: () => void;
};

/** The collector workspace: header, Location sidebar (desktop) or drawer (mobile), and the gallery area. */
export function Workspace({ userId, onOpenLocations, onSignOut }: Props) {
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
  const ownedTotals = useRef(new Map<string, number>()).current;
  const drawerOpener = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const loadTree = useCallback(async () => {
    setTreeState("loading");
    try {
      const result = await getLocationTree();
      setNodes(result.locations);
      setOwnerRevision(result.owner_revision);
      setTreeState("ready");
    } catch {
      setTreeState("error");
    }
  }, []);
  useEffect(() => {
    void loadTree();
  }, [loadTree]);

  const index = useMemo(() => indexLocations(nodes), [nodes]);
  const current = view === "all" ? undefined : index.byId.get(view);
  // A Location that disappeared from the tree falls back to All owned.
  const heading = current?.name ?? "All owned";
  const galleryView: WorkspaceView = current ? view : "all";
  // Typing settles for 250 ms before the gallery reloads. The selection scope ignores `sort`, so
  // sorting keeps the selection and search or filter changes clear it.
  const searchText = useDebouncedValue(query, 250);
  const galleryQuery: GalleryQuery = {
    view: galleryView,
    search: searchText,
    filters: prefs.filters,
    sort: prefs.sort,
  };
  const gallery = useGalleryData(galleryQuery);
  const galleryKey = JSON.stringify(queryToParams(galleryQuery));
  const sets = useOwnedSets(galleryView, gallery.ownerRevision);
  const narrowed =
    searchText.trim() !== "" || activeFilterCount(prefs.filters) > 0;
  const mobile = useMediaQuery(MOBILE_QUERY);
  const selection = useSelection({
    holdings: gallery.holdings,
    status: gallery.status,
    scope: selectionScope(galleryQuery),
    mobile,
  });
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

  // Modal drawer: focus moves in, Tab stays inside, Escape closes, focus returns to the opener.
  useEffect(() => {
    if (!drawerOpen) return;
    const opener = drawerOpener.current;
    const focusables = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
      );
    focusables()[0]?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = drawerRef.current?.contains(document.activeElement);
      if (event.shiftKey && (document.activeElement === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !inside)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = overflow;
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    };
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

  const tree = (idPrefix: string) =>
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
        view={current ? view : "all"}
        expanded={expanded}
        onToggle={toggleFolder}
        onChoose={choose}
        idPrefix={idPrefix}
        onAddChild={openCreate}
      />
    );

  return (
    <div className="ws-root">
      <div
        className="ws-surface"
        inert={drawerOpen || filtersDrawerOpen || selection.details !== null}
      >
        <header className="ws-header">
          <button
            ref={drawerOpener}
            type="button"
            className="ws-header-icon ws-mobile-only"
            aria-label="Open locations"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <span className="ws-brand">
            <span className="ws-brand-mark" aria-hidden="true">
              ✦
            </span>
            PrizeCheck
          </span>
          {search("ws-mobile-only ws-header-search")}
          <FiltersDrawerButton
            ref={filtersOpener}
            filters={prefs.filters}
            open={filtersDrawerOpen}
            onOpen={() => setFiltersDrawerOpen(true)}
          />
          <nav aria-label="App" className="ws-app-nav ws-desktop-only">
            <button type="button" onClick={onOpenLocations}>
              Locations view
            </button>
            <button type="button" onClick={onSignOut}>
              Sign out
            </button>
          </nav>
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
            {tree("ws-sidebar")}
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
        {selection.summary.copies > 0 && (
          <SelectionBar
            summary={selection.summary}
            onClear={selection.clear}
            onDetails={selection.openDetails}
          />
        )}
      </div>
      {drawerOpen && (
        <div
          className="ws-drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
        >
          <div
            ref={drawerRef}
            className="ws-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ws-drawer-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ws-drawer-heading">
              <h2 id="ws-drawer-title">Locations</h2>
              <button
                type="button"
                className="ws-header-icon"
                aria-label="Close locations"
                onClick={() => setDrawerOpen(false)}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
            {/* After the heading so Close locations stays the drawer's first focus stop. */}
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
            <nav aria-label="App" className="ws-drawer-app-nav">
              <button type="button" onClick={onOpenLocations}>
                Locations view
              </button>
              <button type="button" onClick={onSignOut}>
                Sign out
              </button>
            </nav>
          </div>
        </div>
      )}
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
    </div>
  );
}
