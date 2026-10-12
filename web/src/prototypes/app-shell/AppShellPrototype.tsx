// PROTOTYPE — throwaway. Three app shell variants for "Prototype the app shell and navigation" (#122).
// Three variants of the persistent app shell, switchable via ?variant=A|B|C on /collection?prototype=shell.
// Sample data only; nothing talks to the API. Dev builds only (see main.tsx).
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DECKS,
  LOCATIONS,
  OWNER_PAGE,
  OWNER_ROWS,
  PAGES,
  REPORTS,
  TILES,
  locName,
  type Loc,
  type PageId,
} from "./sample";
import "./AppShellPrototype.css";
// PROTOTYPE (#125): Deck experience variants, ?deck=A|B|C.
import {
  CollectionDeck,
  CollectionDeckActions,
  DECK_VARIANTS,
  DeckVariantPicker,
  DecksActions,
  DecksPage,
  setDeckVariant,
  useDeck,
} from "../deck-experience/DeckExperience";
const DECK_LOCS = new Set(["d-zard", "d-gard"]);

const VARIANTS = [
  { key: "A", name: "Top tabs + bottom bar" },
  { key: "B", name: "Icon rail + context panel" },
  { key: "C", name: "One sidebar tree" },
] as const;
type VariantKey = (typeof VARIANTS)[number]["key"];

function param(name: string, fallback: string) {
  return new URLSearchParams(location.search).get(name) ?? fallback;
}
function setParam(name: string, value: string) {
  const url = new URL(location.href);
  url.searchParams.set(name, value);
  history.replaceState(null, "", url);
}

// ---------- shared shell state ----------

export type Shell = ReturnType<typeof useShell>;
function useShell() {
  const [variant, setVariantState] = useState<VariantKey>(
    (["A", "B", "C"].includes(param("variant", "A"))
      ? param("variant", "A")
      : "A") as VariantKey
  );
  const [keep, setKeepState] = useState(param("keep", "1") === "1");
  const [signedIn, setSignedInState] = useState(param("signedin", "1") === "1");
  const [owner, setOwnerState] = useState(param("owner", "1") === "1");
  const [page, setPage] = useState<PageId>("collection");
  const [loc, setLoc] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deck, setDeck] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState<
    null | "context" | "filters" | "more" | "account"
  >(null);
  const [toast, setToast] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const scrolls = useRef<Record<string, number>>({});
  const mainRef = useRef<HTMLElement | null>(null);
  const [scrollY, setScrollY] = useState(0);

  function setVariant(v: VariantKey) {
    setVariantState(v);
    setParam("variant", v);
    setDrawer(null);
  }
  function go(next: PageId) {
    setDrawer(null);
    if (next === page) return;
    scrolls.current[page] = mainRef.current?.scrollTop ?? 0;
    if (!keep) {
      // "Remount on return": everything the page held is gone, and it shows placeholders again.
      scrolls.current = {};
      setLoc("all");
      setSelected(new Set());
      setDeck(null);
      setSelectMode(false);
      setLoading(true);
      window.setTimeout(() => setLoading(false), 450);
    }
    setPage(next);
  }
  function chooseLoc(id: string) {
    setLoc(id);
    setSelected(new Set());
    setDrawer(null);
  }
  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function move() {
    setToast(
      `Moved ${selected.size} ${selected.size === 1 ? "copy" : "copies"} to Trade box`
    );
    setSelected(new Set());
    setSelectMode(false);
    window.setTimeout(() => setToast(null), 4000);
  }
  // Restore the page's scroll position when it is shown again (kept-mounted mode only).
  useLayoutEffect(() => {
    if (mainRef.current)
      mainRef.current.scrollTop = keep ? (scrolls.current[page] ?? 0) : 0;
    setScrollY(mainRef.current?.scrollTop ?? 0);
  }, [page, variant]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    variant,
    setVariant,
    keep,
    setKeep: (v: boolean) => {
      setKeepState(v);
      setParam("keep", v ? "1" : "0");
    },
    signedIn,
    setSignedIn: (v: boolean) => {
      setSignedInState(v);
      setParam("signedin", v ? "1" : "0");
      setDrawer(null);
    },
    owner,
    setOwner: (v: boolean) => {
      setOwnerState(v);
      setParam("owner", v ? "1" : "0");
      if (!v && page === "owner") go("collection");
    },
    page,
    go,
    loc,
    chooseLoc,
    selected,
    toggle,
    clear: () => setSelected(new Set()),
    deck,
    setDeck,
    loading,
    drawer,
    setDrawer,
    toast,
    setToast,
    move,
    selectMode,
    setSelectMode,
    mainRef,
    scrollY,
    onScroll: () => setScrollY(mainRef.current?.scrollTop ?? 0),
    pages: owner ? [...PAGES, OWNER_PAGE] : PAGES,
  };
}

function pageLabel(id: PageId) {
  return [...PAGES, OWNER_PAGE].find((p) => p.id === id)!.label;
}

// ---------- page pieces (identical in every variant; only the shell around them changes) ----------

function LocationTree({ s }: { s: Shell }) {
  const row = (l: Loc, depth: number): ReactNode => (
    <li key={l.id}>
      <button
        type="button"
        className="ps-tree-row"
        aria-current={s.loc === l.id ? "true" : undefined}
        style={{ paddingInlineStart: 8 + depth * 14 }}
        onClick={() => s.chooseLoc(l.id)}
      >
        <span aria-hidden="true" className="ps-tree-glyph">
          {l.children ? "▾" : l.deck ? "❒" : "▪"}
        </span>
        {l.name}
      </button>
      {l.children && <ul>{l.children.map((c) => row(c, depth + 1))}</ul>}
    </li>
  );
  return (
    <div className="ps-context">
      <div className="ps-context-head">
        <h2>Locations</h2>
        <button type="button" aria-label="Add location" className="ps-icon-btn">
          +
        </button>
      </div>
      <ul className="ps-tree">
        <li>
          <button
            type="button"
            className="ps-tree-row"
            aria-current={s.loc === "all" ? "true" : undefined}
            onClick={() => s.chooseLoc("all")}
          >
            <span aria-hidden="true" className="ps-tree-glyph">
              ◇
            </span>
            All owned
          </button>
        </li>
        {LOCATIONS.map((l) => row(l, 0))}
      </ul>
    </div>
  );
}

function DeckIndex({ s }: { s: Shell }) {
  return (
    <div className="ps-context">
      <div className="ps-context-head">
        <h2>Decks</h2>
        <button type="button" aria-label="New Deck" className="ps-icon-btn">
          +
        </button>
      </div>
      <ul className="ps-tree">
        {DECKS.map((d) => (
          <li key={d.id}>
            <button
              type="button"
              className="ps-tree-row"
              aria-current={s.deck === d.id ? "true" : undefined}
              onClick={() => {
                s.setDeck(d.id);
                s.setDrawer(null);
              }}
            >
              <span aria-hidden="true" className="ps-tree-glyph">
                ❒
              </span>
              {d.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CatalogFilters() {
  return (
    <div className="ps-context">
      <div className="ps-context-head">
        <h2>Filters</h2>
      </div>
      <label className="ps-field">
        Set
        <select>
          <option>Any set</option>
          <option>Scarlet &amp; Violet</option>
        </select>
      </label>
      <label className="ps-field">
        Category
        <select>
          <option>Any</option>
          <option>Pokémon</option>
          <option>Trainer</option>
        </select>
      </label>
      <label className="ps-field">
        Type
        <select>
          <option>Any</option>
          <option>Fire</option>
        </select>
      </label>
    </div>
  );
}

/** The page's own side content: what sits in a sidebar on desktop and a drawer on mobile. Null when the page has none. */
function contextFor(s: Shell): ReactNode {
  if (!s.signedIn) return null;
  if (s.page === "collection") return <LocationTree s={s} />;
  if (s.page === "decks") return <DeckIndex s={s} />;
  if (s.page === "catalog") return <CatalogFilters />;
  return null;
}

function pageTitle(s: Shell) {
  if (s.page === "collection") return locName(s.loc);
  if (s.page === "decks")
    return s.deck ? (DECKS.find((d) => d.id === s.deck)?.name ?? "Deck") : "Decks";
  return pageLabel(s.page);
}

/** Page-level actions that belong in the page header, not the app shell. */
function PageActions({ s }: { s: Shell }) {
  if (s.page === "decks") return <DecksActions s={s} />;
  if (s.page === "collection" && DECK_LOCS.has(s.loc))
    return <CollectionDeckActions />;
  if (s.page === "collection")
    return (
      <>
        <button type="button" className="ps-btn ps-desktop">
          Add cards
        </button>
        <button
          type="button"
          className={`ps-btn ps-mobile${s.selectMode ? " ps-btn-on" : ""}`}
          aria-pressed={s.selectMode}
          onClick={() => {
            s.setSelectMode(!s.selectMode);
            s.clear();
          }}
        >
          Select
        </button>
      </>
    );
  if (s.page === "reports")
    return (
      <button type="button" className="ps-btn ps-btn-primary">
        Report a missing card
      </button>
    );
  if (s.page === "owner")
    return (
      <button type="button" className="ps-btn ps-btn-primary">
        Start full English pull
      </button>
    );
  return null;
}

function CollectionToolbar() {
  return (
    <div className="ps-toolbar ps-desktop">
      <input
        className="ps-input"
        type="search"
        placeholder="Search cards"
        aria-label="Search cards"
      />
      <button type="button" className="ps-btn">
        Filters
      </button>
      <span className="ps-spacer" />
      <button type="button" className="ps-btn">
        Sort: Name A–Z
      </button>
      <button type="button" className="ps-btn">
        Size: S
      </button>
      <button type="button" className="ps-btn">
        Names
      </button>
      <button type="button" className="ps-btn">
        Prices
      </button>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="ps-grid" aria-busy="true">
      {Array.from({ length: 24 }, (_, i) => (
        <div key={i} className="ps-tile ps-tile-skeleton" />
      ))}
    </div>
  );
}

function CollectionBody({ s }: { s: Shell }) {
  const tiles = s.loc === "all" ? TILES : TILES.filter((t) => t.loc === s.loc);
  return (
    <>
      <CollectionToolbar />
      <p className="ps-counts">
        {tiles.length} copies · {new Set(tiles.map((t) => t.name)).size} Card
        Editions
      </p>
      {s.loading ? (
        <SkeletonGrid />
      ) : (
        <div className="ps-grid">
          {tiles.map((t) => (
            <button
              key={t.id}
              type="button"
              className="ps-tile"
              aria-pressed={s.selected.has(t.id)}
              aria-label={`${t.name}, ${t.set}, ${locName(t.loc)}`}
              title={`${t.name} · ${t.set} · ${locName(t.loc)}`}
              onClick={() => s.toggle(t.id)}
              style={{ ["--hue" as string]: t.hue }}
            >
              <span className="ps-tile-art">
                <span>{t.name}</span>
              </span>
              {s.loc === "all" && (
                <span className="ps-tile-caption">{locName(t.loc)}</span>
              )}
              {s.selected.has(t.id) && (
                <span className="ps-tile-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Chip({ v, label }: { v: string; label: string }) {
  const mark = v === "legal" ? "✓" : v === "not legal" ? "✕" : "?";
  return (
    <span className={`ps-chip ps-chip-${v.replace(" ", "-")}`}>
      <span aria-hidden="true">{mark}</span> {label}: {v}
    </span>
  );
}

function DecksBody({ s }: { s: Shell }) {
  const d = DECKS.find((x) => x.id === s.deck);
  if (!d)
    return (
      <div className="ps-cards">
        {DECKS.map((x) => (
          <button
            key={x.id}
            type="button"
            className="ps-card"
            onClick={() => s.setDeck(x.id)}
          >
            <strong>{x.name}</strong>
            <span>
              {x.owned}/{x.total} cards owned · ${x.cost.toFixed(2)}
            </span>
            <span className="ps-chips">
              <Chip v={x.standard} label="Standard" />
              <Chip v={x.expanded} label="Expanded" />
              <Chip v={x.glc} label="GLC" />
            </span>
          </button>
        ))}
      </div>
    );
  return (
    <div className="ps-stack">
      <button type="button" className="ps-link" onClick={() => s.setDeck(null)}>
        ← All Decks
      </button>
      <p className="ps-chips">
        <Chip v={d.standard} label="Standard" />
        <Chip v={d.expanded} label="Expanded" />
        <Chip v={d.glc} label="GLC" />
      </p>
      <p>
        Estimated Deck Cost ${d.cost.toFixed(2)} · ${d.toComplete.toFixed(2)} to
        complete · {d.owned}/{d.total} owned
      </p>
      <p className="ps-muted">
        Deck List, ownership states and the Pick List are designed in "Prototype
        the Deck experience"; this body is a placeholder for the shell.
      </p>
      <ul className="ps-list">
        {TILES.slice(0, 14).map((t) => (
          <li key={t.id}>
            <span>{t.name}</span>
            <span className="ps-muted">{t.set}</span>
            <span>
              {t.id.length % 2 ? "in this Deck" : "elsewhere: Trade box"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CatalogBody() {
  return (
    <>
      <div className="ps-toolbar">
        <input
          className="ps-input ps-grow"
          type="search"
          placeholder="Search the English catalog"
          aria-label="Search the catalog"
        />
      </div>
      <div className="ps-grid">
        {TILES.slice(0, 18).map((t) => (
          <div
            key={t.id}
            className="ps-tile"
            style={{ ["--hue" as string]: t.hue }}
          >
            <span className="ps-tile-art">
              <span>{t.name}</span>
            </span>
            <span className="ps-tile-caption">
              {t.set} · ${t.price}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function ReportsBody() {
  return (
    <ul className="ps-list">
      {REPORTS.map((r) => (
        <li key={r.card}>
          <span>{r.card}</span>
          <span className="ps-muted">{r.at}</span>
          <span>{r.status}</span>
        </li>
      ))}
    </ul>
  );
}

function OwnerBody() {
  return (
    <div className="ps-stack">
      <section className="ps-panel">
        <h2>English catalog pull</h2>
        <p className="ps-muted">
          Last successful pull: 2026-10-11 03:12 · Run 88 finished
        </p>
      </section>
      <section className="ps-panel">
        <h2>Pending review (8)</h2>
        <div
          className="ps-table-scroll"
          tabIndex={0}
          aria-label="Pending review, scrolls sideways"
        >
          <table className="ps-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Kind</th>
                <th>Source</th>
                <th>Card</th>
                <th>Set</th>
                <th>Detail</th>
                <th>Opened</th>
                <th>Age</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {OWNER_ROWS.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{r.kind}</td>
                  <td>{r.source}</td>
                  <td>{r.card}</td>
                  <td>{r.set}</td>
                  <td>{r.detail}</td>
                  <td>{r.opened}</td>
                  <td>{r.age}</td>
                  <td>
                    <button type="button" className="ps-btn">
                      Review
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function PublishedBody() {
  const d = DECKS[0];
  return (
    <div className="ps-stack">
      <p className="ps-muted">
        Published by ash · Listed · Snapshot 2026-10-10
      </p>
      <p className="ps-chips">
        <Chip v={d.standard} label="Standard" />
        <Chip v={d.expanded} label="Expanded" />
        <Chip v={d.glc} label="GLC" />
      </p>
      <p>Estimated Deck Cost ${d.cost.toFixed(2)}</p>
      <ul className="ps-list">
        {TILES.slice(0, 16).map((t) => (
          <li key={t.id}>
            <span>{t.name}</span>
            <span className="ps-muted">{t.set}</span>
            <span>×{(t.id.length % 3) + 1}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PageBody({ s }: { s: Shell }) {
  if (!s.signedIn) return <PublishedBody />;
  switch (s.page) {
    case "collection":
      return DECK_LOCS.has(s.loc) ? (
        <CollectionDeck s={s} gallery={<CollectionBody s={s} />} />
      ) : (
        <CollectionBody s={s} />
      );
    case "decks":
      return <DecksPage s={s} />;
    case "catalog":
      return <CatalogBody />;
    case "reports":
      return <ReportsBody />;
    case "owner":
      return <OwnerBody />;
  }
}

/** The existing Collection bottom dock: Actions strip when tiles are selected, and the Undo toast. Every variant must fit around it. */
function Dock({ s, offset }: { s: Shell; offset?: boolean }) {
  const strip = s.signedIn && s.page === "collection" && s.selected.size > 0;
  if (!strip && !s.toast) return null;
  return (
    <div className={`ps-dock${offset ? " ps-dock-offset" : ""}`}>
      {s.toast && (
        <div className="ps-toast" role="status">
          {s.toast}
          <button
            type="button"
            className="ps-link"
            onClick={() => s.setToast(null)}
          >
            Undo
          </button>
        </div>
      )}
      {strip && (
        <div className="ps-strip">
          <span>{s.selected.size} selected</span>
          <span className="ps-spacer" />
          <button type="button" className="ps-btn" onClick={s.clear}>
            Clear
          </button>
          <button
            type="button"
            className="ps-btn ps-btn-primary"
            onClick={s.move}
          >
            Move…
          </button>
        </div>
      )}
    </div>
  );
}

function Drawer({
  s,
  side,
  label,
  children,
}: {
  s: Shell;
  side: "left" | "right" | "bottom";
  label: string;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && s.setDrawer(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);
  return (
    <>
      <div className="ps-scrim" onClick={() => s.setDrawer(null)} />
      <div
        className={`ps-drawer ps-drawer-${side}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="ps-drawer-head">
          <strong>{label}</strong>
          <button
            type="button"
            className="ps-icon-btn"
            aria-label="Close"
            onClick={() => s.setDrawer(null)}
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

function FiltersDrawer({ s }: { s: Shell }) {
  return s.drawer === "filters" ? (
    <Drawer s={s} side="right" label="Filters & display">
      <CatalogFilters />
      <label className="ps-field">
        Sort
        <select>
          <option>Name A–Z</option>
        </select>
      </label>
      <label className="ps-check">
        <input type="checkbox" /> Names
      </label>
      <label className="ps-check">
        <input type="checkbox" /> Prices
      </label>
    </Drawer>
  ) : null;
}

function Brand() {
  return (
    <span className="ps-brand">
      <span aria-hidden="true" className="ps-brand-mark">
        ✦
      </span>
      PrizeCheck
    </span>
  );
}

/** Signed-out pages (Published Deck, Discover, sign-in) get one slim header in every variant. */
function PublicShell({ s }: { s: Shell }) {
  return (
    <div className="ps-root">
      <header className="ps-header">
        <Brand />
        <span className="ps-spacer" />
        <a className="ps-link" href="#discover">
          Discover decks
        </a>
        <button
          type="button"
          className="ps-btn ps-btn-primary"
          onClick={() => s.setSignedIn(true)}
        >
          Sign in
        </button>
      </header>
      <main
        className="ps-main ps-main-public"
        ref={s.mainRef}
        onScroll={s.onScroll}
      >
        <h1 className="ps-title">Charizard ex</h1>
        <PublishedBody />
      </main>
    </div>
  );
}

function MobileHeader({
  s,
  left,
  title,
}: {
  s: Shell;
  left: ReactNode;
  title?: ReactNode;
}) {
  const collection = s.page === "collection";
  return (
    <header className="ps-header ps-mobile">
      {left}
      <span className="ps-mobile-title">{title ?? pageTitle(s)}</span>
      {collection && (
        <input
          className="ps-input ps-header-search"
          type="search"
          placeholder="Search"
          aria-label="Search cards"
        />
      )}
      {collection && (
        <button
          type="button"
          className="ps-icon-btn"
          aria-label="Filters & display"
          onClick={() => s.setDrawer("filters")}
        >
          ⚲
        </button>
      )}
    </header>
  );
}

function AccountMenu({ s }: { s: Shell }) {
  return (
    <div className="ps-account">
      <button
        type="button"
        className="ps-avatar"
        aria-haspopup="menu"
        aria-expanded={s.drawer === "account"}
        onClick={() => s.setDrawer(s.drawer === "account" ? null : "account")}
      >
        R
      </button>
      {s.drawer === "account" && (
        <div className="ps-menu" role="menu">
          <span className="ps-muted">rycen618@…</span>
          {s.owner && (
            <button type="button" role="menuitem" onClick={() => s.go("owner")}>
              Owner controls
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => s.setSignedIn(false)}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Variant A: top tabs on desktop, bottom tab bar on mobile ----------

function VariantA({ s }: { s: Shell }) {
  const ctx = contextFor(s);
  const tabs = PAGES;
  return (
    <div className="ps-root ps-a">
      <header className="ps-header ps-desktop">
        <Brand />
        <nav aria-label="Main views" className="ps-tabs">
          {tabs.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-current={s.page === p.id ? "page" : undefined}
              onClick={() => s.go(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <span className="ps-spacer" />
        <AccountMenu s={s} />
      </header>
      <MobileHeader
        s={s}
        left={
          ctx ? (
            <button
              type="button"
              className="ps-icon-btn"
              aria-label={`Open ${s.page === "collection" ? "locations" : "list"}`}
              onClick={() => s.setDrawer("context")}
            >
              ☰
            </button>
          ) : (
            <Brand />
          )
        }
      />
      <div className="ps-body">
        {ctx && <aside className="ps-sidebar ps-desktop">{ctx}</aside>}
        <main className="ps-main" ref={s.mainRef} onScroll={s.onScroll}>
          <div className="ps-page-head ps-desktop-flex">
            <h1 className="ps-title">{pageTitle(s)}</h1>
            <span className="ps-spacer" />
            <PageActions s={s} />
          </div>
          <div className="ps-page-head ps-mobile-flex">
            <span className="ps-spacer" />
            <PageActions s={s} />
          </div>
          <PageBody s={s} />
        </main>
      </div>
      <Dock s={s} offset />
      <nav aria-label="Main views" className="ps-bottom-bar ps-mobile">
        {PAGES.slice(0, 3).map((p) => (
          <button
            key={p.id}
            type="button"
            aria-current={s.page === p.id ? "page" : undefined}
            onClick={() => s.go(p.id)}
          >
            <span aria-hidden="true">{p.icon}</span>
            {p.label}
          </button>
        ))}
        <button
          type="button"
          aria-current={
            ["reports", "owner"].includes(s.page) ? "page" : undefined
          }
          onClick={() => s.setDrawer("more")}
        >
          <span aria-hidden="true">⋯</span>More
        </button>
      </nav>
      {s.drawer === "context" && ctx && (
        <Drawer
          s={s}
          side="left"
          label={s.page === "collection" ? "Locations" : pageLabel(s.page)}
        >
          {ctx}
        </Drawer>
      )}
      {s.drawer === "more" && (
        <Drawer s={s} side="bottom" label="More">
          <div className="ps-sheet-list">
            <button type="button" onClick={() => s.go("reports")}>
              ⚑ Missing cards
            </button>
            {s.owner && (
              <button type="button" onClick={() => s.go("owner")}>
                ⚙ Owner controls
              </button>
            )}
            <button type="button" onClick={() => s.setSignedIn(false)}>
              Sign out
            </button>
          </div>
        </Drawer>
      )}
      <FiltersDrawer s={s} />
    </div>
  );
}

// ---------- Variant B: icon rail + page context panel; one two-level drawer on mobile ----------

function Rail({ s, horizontal }: { s: Shell; horizontal?: boolean }) {
  return (
    <nav
      aria-label="Main views"
      className={horizontal ? "ps-rail ps-rail-h" : "ps-rail"}
    >
      {!horizontal && (
        <span className="ps-brand-mark ps-rail-brand" aria-hidden="true">
          ✦
        </span>
      )}
      {s.pages.map((p) => (
        <button
          key={p.id}
          type="button"
          title={p.label}
          aria-current={s.page === p.id ? "page" : undefined}
          onClick={() => s.go(p.id)}
        >
          <span aria-hidden="true" className="ps-rail-icon">
            {p.icon}
          </span>
          <span className="ps-rail-label">{p.label}</span>
        </button>
      ))}
      <span className="ps-spacer" />
      <button
        type="button"
        title="Sign out"
        onClick={() => s.setSignedIn(false)}
      >
        <span aria-hidden="true" className="ps-rail-icon">
          ⎋
        </span>
        <span className="ps-rail-label">Sign out</span>
      </button>
    </nav>
  );
}

function VariantB({ s }: { s: Shell }) {
  const ctx = contextFor(s);
  return (
    <div className="ps-root ps-b">
      <MobileHeader
        s={s}
        left={
          <button
            type="button"
            className="ps-icon-btn"
            aria-label="Open menu"
            onClick={() => s.setDrawer("context")}
          >
            ☰
          </button>
        }
      />
      <div className="ps-body">
        <div className="ps-desktop">
          <Rail s={s} />
        </div>
        {ctx && <aside className="ps-sidebar ps-desktop">{ctx}</aside>}
        <main className="ps-main" ref={s.mainRef} onScroll={s.onScroll}>
          <div className="ps-page-head ps-desktop-flex">
            <h1 className="ps-title">{pageTitle(s)}</h1>
            <span className="ps-spacer" />
            <PageActions s={s} />
          </div>
          <div className="ps-page-head ps-mobile-flex">
            <span className="ps-spacer" />
            <PageActions s={s} />
          </div>
          <PageBody s={s} />
        </main>
      </div>
      <Dock s={s} />
      {s.drawer === "context" && (
        <Drawer s={s} side="left" label="PrizeCheck">
          <Rail s={s} horizontal />
          {ctx}
        </Drawer>
      )}
      <FiltersDrawer s={s} />
    </div>
  );
}

// ---------- Variant C: one sidebar; pages are sections and the open page expands its own tree ----------

function SidebarTree({ s }: { s: Shell }) {
  return (
    <nav aria-label="Main views" className="ps-unified">
      <div className="ps-unified-brand">
        <Brand />
      </div>
      {s.pages
        .filter((p) => p.id !== "owner")
        .map((p) => (
          <section key={p.id} className="ps-unified-section">
            <button
              type="button"
              className="ps-unified-page"
              aria-current={s.page === p.id ? "page" : undefined}
              onClick={() => s.go(p.id)}
            >
              <span aria-hidden="true">{p.icon}</span>
              {p.label}
            </button>
            {s.page === p.id && contextFor(s) && (
              <div className="ps-unified-children">{contextFor(s)}</div>
            )}
          </section>
        ))}
      <span className="ps-spacer" />
      <div className="ps-unified-foot">
        {s.owner && (
          <button
            type="button"
            className="ps-unified-page"
            aria-current={s.page === "owner" ? "page" : undefined}
            onClick={() => s.go("owner")}
          >
            <span aria-hidden="true">⚙</span>Owner controls
          </button>
        )}
        <button
          type="button"
          className="ps-unified-page"
          onClick={() => s.setSignedIn(false)}
        >
          <span aria-hidden="true">⎋</span>Sign out
        </button>
      </div>
    </nav>
  );
}

function VariantC({ s }: { s: Shell }) {
  const crumb = (
    <span className="ps-crumb">
      <span className="ps-muted">{pageLabel(s.page)}</span>
      {(s.page === "collection" || (s.page === "decks" && s.deck)) && (
        <>
          <span aria-hidden="true"> / </span>
          <span>{pageTitle(s)}</span>
        </>
      )}
    </span>
  );
  return (
    <div className="ps-root ps-c">
      <MobileHeader
        s={s}
        title={crumb}
        left={
          <button
            type="button"
            className="ps-icon-btn"
            aria-label="Open navigation"
            onClick={() => s.setDrawer("context")}
          >
            ☰
          </button>
        }
      />
      <div className="ps-body">
        <aside className="ps-sidebar ps-sidebar-wide ps-desktop">
          <SidebarTree s={s} />
        </aside>
        <main className="ps-main" ref={s.mainRef} onScroll={s.onScroll}>
          <div className="ps-page-head ps-desktop-flex">
            {crumb}
            <span className="ps-spacer" />
            <PageActions s={s} />
          </div>
          <div className="ps-page-head ps-mobile-flex">
            <span className="ps-spacer" />
            <PageActions s={s} />
          </div>
          <PageBody s={s} />
        </main>
      </div>
      <Dock s={s} />
      {s.drawer === "context" && (
        <Drawer s={s} side="left" label="Navigation">
          <SidebarTree s={s} />
        </Drawer>
      )}
      <FiltersDrawer s={s} />
    </div>
  );
}

// ---------- floating prototype switcher (dev only; never part of the design) ----------

function Switcher({ s }: { s: Shell }) {
  const deck = useDeck();
  const i = DECK_VARIANTS.findIndex((v) => v.key === deck.variant);
  const cycle = (d: number) =>
    setDeckVariant(
      DECK_VARIANTS[(i + d + DECK_VARIANTS.length) % DECK_VARIANTS.length].key
    );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") cycle(-1);
      if (e.key === "ArrowRight") cycle(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const [open, setOpen] = useState(
    () => !window.matchMedia("(max-width: 760px)").matches
  );
  return (
    <div
      className="proto-switcher"
      role="region"
      aria-label="Prototype switcher"
    >
      <button
        type="button"
        aria-label="Previous variant"
        onClick={() => cycle(-1)}
      >
        ‹
      </button>
      <strong>
        Deck {deck.variant} ({DECK_VARIANTS[i].name})
      </strong>
      <button type="button" aria-label="Next variant" onClick={() => cycle(1)}>
        ›
      </button>
      {open && (
        <>
          <DeckVariantPicker />
          <label>
            <input
              type="checkbox"
              checked={s.keep}
              onChange={(e) => s.setKeep(e.target.checked)}
            />{" "}
            keep pages mounted
          </label>
          <label>
            <input
              type="checkbox"
              checked={s.signedIn}
              onChange={(e) => s.setSignedIn(e.target.checked)}
            />{" "}
            signed in
          </label>
          <label>
            <input
              type="checkbox"
              checked={s.owner}
              onChange={(e) => s.setOwner(e.target.checked)}
            />{" "}
            owner
          </label>
          <code>
            {s.signedIn ? s.page : "published"} · loc {s.loc} · sel{" "}
            {s.selected.size} · scroll {Math.round(s.scrollY)}
          </code>
        </>
      )}
      <button
        type="button"
        aria-label={open ? "Collapse switcher" : "Expand switcher"}
        onClick={() => setOpen(!open)}
      >
        {open ? "–" : "+"}
      </button>
    </div>
  );
}

export default function AppShellPrototype() {
  const s = useShell();
  const V =
    s.variant === "A" ? VariantA : s.variant === "B" ? VariantB : VariantC;
  return (
    <>
      {s.signedIn ? <V s={s} /> : <PublicShell s={s} />}
      <Switcher s={s} />
    </>
  );
}
