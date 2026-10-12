// PROTOTYPE — throwaway. Three answers to "how does Catalog search look and behave in the shell, and how does a found
// card get into a Location?" for "Prototype Catalog search in the shell" (#126), switched with ?cat=A|B|C.
//   A  Edition gallery: tiles like Collection and the deck builder's library; a card popup holds the Printing's
//      Editions, reports, Add to Collection and Add to Deck.
//   B  Printing rows + detail panel: one dense row per Printing with its Editions as chips; filters in the shell's
//      sidebar; picking a row opens a side panel (a sheet on phones).
//   C  Add mode: a sticky "Adding to" Location, a quick + on every Edition, and a tray confirmed in one go.
// Shared: one smart search box ("PAL 185" searches set + number, anything else a name prefix), the catalog status line,
// and every current Catalog feature (Editions with source, evidence and price, unavailable Editions, artwork note,
// Report metadata, Report missing Edition, My reports). Sample data only; every action is a stub with an Undo toast.
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Shell } from "../app-shell/AppShellPrototype";
import { Art } from "../deck-experience/DeckExperience";
import {
  CATALOG,
  DECKS,
  LAST_PULL,
  LEAVES,
  MY_REPORTS,
  legal,
  ownedCount,
  type CatEdition,
  type CatPrinting,
} from "./sample";
import "./CatalogPrototype.css";

export const CAT_VARIANTS = [
  { key: "A", name: "Edition gallery" },
  { key: "B", name: "Printing rows + panel" },
  { key: "C", name: "Add mode" },
  { key: "D", name: "Gallery + add mode" },
] as const;
export type CatVariant = (typeof CAT_VARIANTS)[number]["key"];

// ---------- store ----------
type Format = "any" | "standard" | "expanded" | "glc";
type CatState = {
  variant: CatVariant;
  q: string;
  format: Format;
  type: string;
  set: string;
  owned: boolean;
  open: { printing: string; edition: string } | null;
  toast: string | null;
  target: string;
  tray: Record<string, number>;
  report: null | "printing" | "edition" | "missing";
  /** D: the Catalog page's Browse / Add switch. */
  addMode: boolean;
  /** Collection's Add cards: open over Collection, set to this Location (undefined = closed, null = ask). */
  addTo: string | null | undefined;
};
const initial = new URLSearchParams(location.search).get("cat");
let state: CatState = {
  variant: (["A", "B", "C", "D"].includes(initial ?? "") ? initial : "D") as CatVariant,
  q: "Iono",
  format: "any",
  type: "All",
  set: "",
  owned: false,
  open: null,
  toast: null,
  target: "trade",
  tray: {},
  report: null,
  addMode: false,
  addTo: undefined,
};
const subs = new Set<() => void>();
function set(p: Partial<CatState> | ((s: CatState) => Partial<CatState>)) {
  state = { ...state, ...(typeof p === "function" ? p(state) : p) };
  subs.forEach((f) => f());
}
export function useCat() {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => state
  );
}
export function setCatVariant(v: CatVariant) {
  const url = new URL(location.href);
  url.searchParams.set("cat", v);
  history.replaceState(null, "", url);
  set({ variant: v, open: null, report: null });
}
function toast(text: string) {
  set({ toast: text });
  window.setTimeout(() => set((s) => (s.toast === text ? { toast: null } : {})), 4500);
}

// ---------- search ----------
const SET_NUMBER = /^([a-z0-9.]+)\s*#?\s*([a-z0-9]+)$/i;
function parse(q: string): { mode: "name"; name: string } | { mode: "set"; set: string; number: string } {
  const m = SET_NUMBER.exec(q.trim());
  if (m && CATALOG.some((p) => p.set.toLowerCase() === m[1].toLowerCase())) return { mode: "set", set: m[1], number: m[2] };
  return { mode: "name", name: q.trim() };
}
function results(s: CatState): CatPrinting[] {
  const parsed = parse(s.q);
  return CATALOG.filter((p) =>
    parsed.mode === "set"
      ? p.set.toLowerCase() === parsed.set.toLowerCase() && p.number.toLowerCase() === parsed.number.toLowerCase()
      : p.name.toLowerCase().startsWith(parsed.name.toLowerCase())
  )
    .filter((p) => s.format === "any" || legal(p, s.format) !== false)
    .filter((p) => s.type === "All" || p.kind === s.type || p.sub === s.type)
    .filter((p) => !s.set || p.set === s.set)
    .filter((p) => !s.owned || p.editions.some((e) => ownedCount(e) > 0));
}
const money = (n: number | null) => (n === null ? "no price" : `$${n.toFixed(2)}`);
const TYPES = ["All", "Pokémon", "Supporter", "Item", "Tool", "Stadium", "Energy"];
const FORMATS: { id: Format; label: string }[] = [
  { id: "any", label: "Any format" },
  { id: "standard", label: "Standard" },
  { id: "expanded", label: "Expanded" },
  { id: "glc", label: "GLC" },
];

// ---------- shared pieces ----------
function CardImage({ p, large }: { p: CatPrinting; large?: boolean }) {
  return p.art ? (
    <Art name={p.name} hue={p.hue} />
  ) : (
    <span className={`dx-art dx-art-ghost cx-noart${large ? " cx-noart-lg" : ""}`} role="img" aria-label={`Artwork unavailable for ${p.name}`}>
      <span>Artwork unavailable</span>
    </span>
  );
}

function SearchBox() {
  const c = useCat();
  const parsed = parse(c.q);
  return (
    <div className="cx-searchwrap">
      <input
        className="dx-search cx-search"
        type="search"
        value={c.q}
        onChange={(e) => set({ q: e.target.value })}
        placeholder="Card name, or set and number (PAL 185)"
        aria-label="Search the English catalog"
        aria-describedby="cx-mode"
      />
      <span id="cx-mode" className="cx-mode">
        {parsed.mode === "set" ? `Set ${parsed.set.toUpperCase()} · number ${parsed.number}` : c.q.trim() ? "Name starts with" : ""}
      </span>
    </div>
  );
}

function Chips({ vertical }: { vertical?: boolean }) {
  const c = useCat();
  const sets = [...new Set(CATALOG.map((p) => p.set))];
  const formatChips = FORMATS.map((f) => (
    <button key={f.id} type="button" role="radio" className="dx-fchip" aria-checked={c.format === f.id} onClick={() => set({ format: f.id })}>
      {f.label}
    </button>
  ));
  const typeChips = TYPES.map((t) => (
    <button key={t} type="button" role="radio" className="dx-fchip" aria-checked={c.type === t} onClick={() => set({ type: t })}>
      {t === "All" ? "All types" : t}
    </button>
  ));
  const setPicker = (
    <select className="cx-select cx-setpick" aria-label="Set" value={c.set} onChange={(e) => set({ set: e.target.value })}>
      <option value="">Any set</option>
      {sets.map((x) => (
        <option key={x} value={x}>
          {x} · {CATALOG.find((p) => p.set === x)!.setName}
        </option>
      ))}
    </select>
  );
  const ownedChip = (
    <button type="button" className="dx-fchip cx-ownedchip" aria-pressed={c.owned} onClick={() => set({ owned: !c.owned })}>
      {c.owned ? "✓ " : ""}Owned only
    </button>
  );
  if (vertical)
    return (
      <div className="cx-filters-v">
        <div className="dx-chips" role="radiogroup" aria-label="Format">
          {formatChips}
        </div>
        <div className="dx-chips" role="radiogroup" aria-label="Card type">
          {typeChips}
        </div>
        {setPicker}
        {ownedChip}
      </div>
    );
  return (
    <div className="cx-filterbar">
      <div className="dx-chips cx-chiprow">
        <span role="radiogroup" aria-label="Format" className="cx-chipgroup">
          {formatChips}
        </span>
        <span className="cx-divider" aria-hidden="true" />
        <span role="radiogroup" aria-label="Card type" className="cx-chipgroup">
          {typeChips}
        </span>
      </div>
      {setPicker}
      {ownedChip}
    </div>
  );
}

function Status({ count }: { count: number }) {
  return (
    <p className="cx-status">
      {count} Printing{count === 1 ? "" : "s"} · English catalog from TCGdex, last pulled {LAST_PULL}
    </p>
  );
}

function Legality({ p }: { p: CatPrinting }) {
  return (
    <span className="cx-legal">
      {(["standard", "expanded", "glc"] as const).map((f) => {
        const v = legal(p, f);
        return (
          <span key={f} className={`dx-pill dx-${v === true ? "legal" : v === false ? "not_legal" : "unknown"}`}>
            {v === true ? "✓" : v === false ? "✕" : "?"} {f === "glc" ? "GLC" : f[0].toUpperCase() + f.slice(1)}
          </span>
        );
      })}
    </span>
  );
}

function AddControls({ p, e, compact, defaultLoc }: { p: CatPrinting; e: CatEdition; compact?: boolean; defaultLoc?: string }) {
  const [loc, setLoc] = useState(defaultLoc ?? "trade");
  const [qty, setQty] = useState(1);
  const [deck, setDeck] = useState("d-zard");
  if (!e.active) return <p className="cx-muted">This Edition is unavailable and can't be added.</p>;
  const label = `${p.name} ${p.set} ${p.number} · ${e.variant}`;
  return (
    <div className={compact ? "cx-add cx-add-compact" : "cx-add"}>
      <span className="cx-add-label">Collection</span>
      <select className="cx-select" aria-label="Location" value={loc} onChange={(ev) => setLoc(ev.target.value)}>
        {LEAVES.map((l) => (
          <option key={l.id} value={l.id}>
            {l.path}
          </option>
        ))}
      </select>
      <span className="cx-stepper" role="group" aria-label="Quantity">
        <button type="button" aria-label="One fewer" onClick={() => setQty(Math.max(1, qty - 1))}>
          −
        </button>
        <span className="dx-num">{qty}</span>
        <button type="button" aria-label="One more" onClick={() => setQty(qty + 1)}>
          +
        </button>
      </span>
      <button type="button" className="dx-b dx-b-primary cx-addbtn" onClick={() => toast(`Added ${qty} × ${label} to ${LEAVES.find((l) => l.id === loc)!.path}`)}>
        Add {qty}
      </button>
      <span className="cx-add-label">Deck List</span>
      <select className="cx-select" aria-label="Deck" value={deck} onChange={(ev) => setDeck(ev.target.value)}>
        {DECKS.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <span aria-hidden="true" />
      <button type="button" className="dx-b cx-addbtn" onClick={() => toast(`Planned 1 × ${label} in ${DECKS.find((d) => d.id === deck)!.name}`)}>
        Plan 1
      </button>
    </div>
  );
}

/** The Printing detail every variant shows somewhere: art, facts, legality, Editions, and the report actions. */
function PrintingDetail({ p, editionId, onEdition, defaultLoc }: { p: CatPrinting; editionId: string; onEdition: (id: string) => void; defaultLoc?: string }) {
  const c = useCat();
  const e = p.editions.find((x) => x.id === editionId) ?? p.editions[0];
  return (
    <div className="cx-detail">
      <div className="cx-detail-art">
        <CardImage p={p} large />
        <p className="cx-note">Artwork belongs to the Printing and doesn't prove an Edition's finish.</p>
      </div>
      <div className="cx-detail-body">
        <p className="cx-facts">
          {p.setName} ({p.set}) · #{p.number}
          {p.mark && ` · mark ${p.mark}`}
          <br />
          {p.identity !== p.name && <>Card Identity: {p.identity} · </>}
          {p.source === "tcgdex" ? "TCGdex" : "Owner-reviewed manual record"}
          {p.source === "manual" && (
            <>
              {" · "}
              <a href="#evidence" className="cx-link">
                Reviewed evidence
              </a>
            </>
          )}
        </p>
        <Legality p={p} />
        <h3 className="cx-h">Editions</h3>
        <ul className="cx-editions" role="radiogroup" aria-label="Editions">
          {p.editions.map((x) => (
            <li key={x.id}>
              <button
                type="button"
                role="radio"
                aria-checked={x.id === e.id}
                disabled={!x.active}
                className="cx-edition"
                onClick={() => onEdition(x.id)}
              >
                <span className="cx-edition-name">
                  {x.variant}
                  {x.source === "manual" && <span className="cx-badge">owner reviewed</span>}
                  {!x.active && <span className="cx-badge">unavailable</span>}
                </span>
                <span className="cx-muted">
                  {ownedCount(x) ? `${ownedCount(x)} owned` : "not owned"} · {money(x.price)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {ownedCount(e) > 0 && (
          <p className="cx-where">
            You own {ownedCount(e)}: {e.owned.map((o) => `${o.name} (${o.qty})`).join(", ")}
          </p>
        )}
        <AddControls key={e.id} p={p} e={e} defaultLoc={defaultLoc} />
        <div className="cx-reports">
          <span className="cx-muted">Report:</span>
          <button type="button" className="cx-link" onClick={() => set({ report: "edition" })}>
            this Edition
          </button>
          <button type="button" className="cx-link" onClick={() => set({ report: "printing" })}>
            Printing metadata
          </button>
          <button type="button" className="cx-link" onClick={() => set({ report: "missing" })}>
            a missing Edition
          </button>
        </div>
        {c.report && (
          <div className="cx-reportform" role="group" aria-label="Report">
            <strong>
              {c.report === "missing" ? "Missing Edition of " : c.report === "edition" ? `${e.variant} · ` : ""}
              {p.name} {p.set} {p.number}
            </strong>
            <textarea className="cx-textarea" placeholder={c.report === "missing" ? "Describe the physical variant: finish, stamp, size…" : "What's wrong, and an evidence link"} />
            <div className="cx-row">
              <button type="button" className="dx-b dx-b-primary" onClick={() => (set({ report: null }), toast("Report sent. It appears under My reports."))}>
                Send report
              </button>
              <button type="button" className="dx-b" onClick={() => set({ report: null })}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Modal({ label, onClose, children, side, full, head }: { label: string; onClose: () => void; children: ReactNode; side?: boolean; full?: boolean; head?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="dx-scrim" onClick={onClose} />
      <div className={`dx-modal cx-modal${side ? " cx-side" : ""}${full ? " cx-full" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="dx-modal-head">
          <strong>{label}</strong>
          <span className="dx-spacer" />
          {head}
          <button type="button" className="dx-icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

function Toast() {
  const c = useCat();
  return c.toast ? (
    <div className="dx-toast" role="status">
      {c.toast}
      <button type="button" className="dx-link" onClick={() => set({ toast: null })}>
        Undo
      </button>
    </div>
  ) : null;
}

function MyReports() {
  return (
    <details className="cx-myreports">
      <summary>My reports ({MY_REPORTS.length})</summary>
      <ul>
        {MY_REPORTS.map((r) => (
          <li key={r.card}>
            {r.card} · <span className="cx-muted">{r.status}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const openFirst = (p: CatPrinting, editionId?: string) =>
  set({ open: { printing: p.id, edition: editionId ?? (p.editions.find((e) => e.active) ?? p.editions[0]).id }, report: null });

// ---------- Variant A: Edition gallery ----------
function VariantA() {
  const c = useCat();
  const list = results(c);
  const tiles = list.flatMap((p) => p.editions.map((e) => ({ p, e })));
  const open = c.open && CATALOG.find((p) => p.id === c.open!.printing);
  const idx = open ? tiles.findIndex((t) => t.e.id === c.open!.edition) : -1;
  const step = (n: number) => {
    if (!tiles.length) return;
    const t = tiles[(Math.max(idx, 0) + n + tiles.length) % tiles.length];
    openFirst(t.p, t.e.id);
  };
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  return (
    <div className="cx cx-a">
      <div className="cx-toolbar">
        <SearchBox />
      </div>
      <Chips />
      <Status count={list.length} />
      <div className="cx-grid">
        {tiles.map(({ p, e }) => (
          <button
            key={e.id}
            type="button"
            className={`cx-tile${ownedCount(e) ? "" : " cx-unowned"}${e.active ? "" : " cx-inactive"}`}
            onClick={() => openFirst(p, e.id)}
            aria-label={`${p.name}, ${p.set} ${p.number}, ${e.variant}. ${ownedCount(e) ? `${ownedCount(e)} owned` : "Not owned"}, ${money(e.price)}`}
          >
            <CardImage p={p} />
            {ownedCount(e) > 0 && <span className="dx-inlist dx-num">{ownedCount(e)}</span>}
            <span className="cx-tile-cap">
              <span>
                {p.set} {p.number} · {e.variant}
              </span>
              <span className="cx-muted">{money(e.price)}</span>
            </span>
          </button>
        ))}
        {!tiles.length && <p className="cx-muted">No Printings match. Check the spelling, or search by set and number.</p>}
      </div>
      <MyReports />
      {open && (
        <Modal label={`${open.name} · ${open.set} ${open.number}`} onClose={() => set({ open: null, report: null })}>
          <div className="cx-stepbar">
            <button type="button" className="dx-b" aria-label="Previous card" onClick={() => step(-1)}>
              ‹ Prev
            </button>
            <span className="cx-muted">
              {idx + 1} of {tiles.length}
            </span>
            <button type="button" className="dx-b" aria-label="Next card" onClick={() => step(1)}>
              Next ›
            </button>
          </div>
          <PrintingDetail p={open} editionId={c.open!.edition} onEdition={(id) => set({ open: { printing: open.id, edition: id } })} />
        </Modal>
      )}
    </div>
  );
}

// ---------- Variant B: Printing rows + detail panel ----------
function VariantB() {
  const c = useCat();
  const list = results(c);
  const open = c.open && CATALOG.find((p) => p.id === c.open!.printing);
  return (
    <div className={`cx cx-b${open ? " cx-b-open" : ""}`}>
      <div className="cx-b-list">
        <div className="cx-toolbar">
          <SearchBox />
        </div>
        <Status count={list.length} />
        <ul className="cx-rows">
          {list.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="cx-rowbtn"
                aria-current={open?.id === p.id ? "true" : undefined}
                onClick={() => openFirst(p)}
              >
                <span className="cx-thumb">
                  <CardImage p={p} />
                </span>
                <span className="cx-rowmain">
                  <strong>{p.name}</strong>
                  <span className="cx-muted">
                    {p.setName} · {p.set} {p.number}
                    {p.source === "manual" && " · owner reviewed"}
                  </span>
                  <span className="cx-edchips">
                    {p.editions.map((e) => (
                      <span key={e.id} className={`cx-edchip${ownedCount(e) ? " cx-edchip-owned" : ""}${e.active ? "" : " cx-inactive"}`}>
                        {ownedCount(e) > 0 && <b>{ownedCount(e)}×</b>} {e.variant} <span className="cx-muted">{money(e.price)}</span>
                      </span>
                    ))}
                  </span>
                </span>
                <span className="cx-chev" aria-hidden="true">
                  ›
                </span>
              </button>
            </li>
          ))}
          {!list.length && <li className="cx-muted">No Printings match.</li>}
        </ul>
        <MyReports />
      </div>
      {open && (
        <aside className="cx-panel" aria-label={`${open.name} ${open.set} ${open.number}`}>
          <div className="dx-modal-head">
            <strong>
              {open.name} · {open.set} {open.number}
            </strong>
            <button type="button" className="dx-icon" aria-label="Close detail" onClick={() => set({ open: null, report: null })}>
              ✕
            </button>
          </div>
          <PrintingDetail p={open} editionId={c.open!.edition} onEdition={(id) => set({ open: { printing: open.id, edition: id } })} />
        </aside>
      )}
    </div>
  );
}

export function CatalogSidebar() {
  return (
    <div className="ps-context cx-sidebar">
      <div className="ps-context-head">
        <h2>Filters</h2>
      </div>
      <Chips vertical />
    </div>
  );
}

// ---------- Variant C: Add mode ----------
function VariantC() {
  const c = useCat();
  const list = results(c);
  const trayItems = Object.entries(c.tray).filter(([, n]) => n > 0);
  const trayCopies = trayItems.reduce((n, [, q]) => n + q, 0);
  const bump = (id: string, n: number) => set((s) => ({ tray: { ...s.tray, [id]: Math.max(0, (s.tray[id] ?? 0) + n) } }));
  const target = LEAVES.find((l) => l.id === c.target)!;
  const find = (id: string) => {
    for (const p of CATALOG) for (const e of p.editions) if (e.id === id) return { p, e };
    return null;
  };
  const open = c.open && CATALOG.find((p) => p.id === c.open!.printing);
  return (
    <div className="cx cx-c">
      <div className="cx-target">
        <span className="cx-add-label">Adding to</span>
        <select className="cx-select cx-target-select" aria-label="Location to add to" value={c.target} onChange={(e) => set({ target: e.target.value })}>
          {LEAVES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.path}
            </option>
          ))}
        </select>
        <span className="dx-spacer" />
        <SearchBox />
      </div>
      <Status count={list.length} />
      <ul className="cx-addlist">
        {list.flatMap((p) =>
          p.editions.map((e) => (
            <li key={e.id} className={e.active ? undefined : "cx-inactive"}>
              <span className="cx-thumb">
                <CardImage p={p} />
              </span>
              <span className="cx-rowmain">
                <strong>
                  {p.name} <span className="cx-muted">{p.set} {p.number}</span>
                </strong>
                <span className="cx-muted">
                  {e.variant} · {money(e.price)} · {ownedCount(e) ? `${ownedCount(e)} owned` : "not owned"}
                  {!e.active && " · unavailable"}
                </span>
              </span>
              <button type="button" className="dx-icon cx-info" aria-label={`Details for ${p.name} ${p.set} ${p.number} ${e.variant}`} onClick={() => openFirst(p, e.id)}>
                ⓘ
              </button>
              {e.active && (
                <span className="cx-stepper" role="group" aria-label={`${p.name} ${e.variant} copies to add`}>
                  {(c.tray[e.id] ?? 0) > 0 && (
                    <>
                      <button type="button" aria-label="One fewer" onClick={() => bump(e.id, -1)}>
                        −
                      </button>
                      <span className="dx-num">{c.tray[e.id]}</span>
                    </>
                  )}
                  <button type="button" aria-label="One more" className="cx-plus" onClick={() => bump(e.id, 1)}>
                    +
                  </button>
                </span>
              )}
            </li>
          ))
        )}
        {!list.length && <li className="cx-muted">No Printings match.</li>}
      </ul>
      <MyReports />
      {trayCopies > 0 && (
        <div className="cx-tray" role="region" aria-label="Cards to add">
          <span className="cx-tray-items">
            {trayItems.map(([id, n]) => {
              const hit = find(id)!;
              return (
                <span key={id} className="cx-traychip">
                  {n}× {hit.p.name} {hit.p.set} {hit.p.number} {hit.e.variant !== "Normal" && hit.e.variant}
                </span>
              );
            })}
          </span>
          <span className="dx-spacer" />
          <button type="button" className="dx-b" onClick={() => set({ tray: {} })}>
            Clear
          </button>
          <button
            type="button"
            className="dx-b dx-b-primary"
            onClick={() => (set({ tray: {} }), toast(`Added ${trayCopies} cards (${trayItems.length} Editions) to ${target.path}`))}
          >
            Add {trayCopies} to {target.path.split(" / ").pop()}
          </button>
        </div>
      )}
      {open && (
        <Modal label={`${open.name} · ${open.set} ${open.number}`} onClose={() => set({ open: null, report: null })}>
          <PrintingDetail p={open} editionId={c.open!.edition} onEdition={(id) => set({ open: { printing: open.id, edition: id } })} />
        </Modal>
      )}
    </div>
  );
}

// ---------- Variant D: A's gallery with C's add mode, also opened from Collection ----------

type Embedded = { target: string | null; close: () => void };

/** The Edition gallery. Browse opens a card popup; Add mode puts a + / stepper on every tile and a tray confirmed in
 * one go. On the Catalog page a Browse / Add switch toggles the mode; from Collection it opens in Add mode, set to the
 * open Location. */
function Gallery({ embedded }: { embedded?: Embedded }) {
  const c = useCat();
  const [pickedTarget, setPickedTarget] = useState<string>(embedded?.target ?? c.target);
  const adding = embedded ? true : c.addMode;
  const target = embedded ? (embedded.target ?? pickedTarget) : c.target;
  const setTarget = (id: string) => (embedded ? setPickedTarget(id) : set({ target: id }));
  const targetPath = LEAVES.find((l) => l.id === target)!.path;
  const list = results(c);
  const tiles = list.flatMap((p) => p.editions.map((e) => ({ p, e })));
  const open = c.open && CATALOG.find((p) => p.id === c.open!.printing);
  const idx = open ? tiles.findIndex((t) => t.e.id === c.open!.edition) : -1;
  const step = (n: number) => {
    if (!tiles.length) return;
    const t = tiles[(Math.max(idx, 0) + n + tiles.length) % tiles.length];
    openFirst(t.p, t.e.id);
  };
  const trayItems = Object.entries(c.tray).filter(([, n]) => n > 0);
  const trayCopies = trayItems.reduce((n, [, q]) => n + q, 0);
  const bump = (id: string, n: number) => set((s) => ({ tray: { ...s.tray, [id]: Math.max(0, (s.tray[id] ?? 0) + n) } }));
  const find = (id: string) => tiles.find((t) => t.e.id === id) ?? CATALOG.flatMap((p) => p.editions.map((e) => ({ p, e }))).find((t) => t.e.id === id)!;
  return (
    <div className={`cx cx-d${embedded ? " cx-embedded" : ""}`}>
      {adding && (
        <div className="cx-target">
          <span className="cx-add-label">Adding to</span>
          {embedded?.target ? (
            <strong className="cx-target-fixed">{targetPath}</strong>
          ) : (
            <select className="cx-select cx-target-select" aria-label="Location to add to" value={target} onChange={(e) => setTarget(e.target.value)}>
              {LEAVES.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.path}
                </option>
              ))}
            </select>
          )}
          {trayCopies === 0 ? (
            <span className="cx-muted cx-small">Tap + on cards, then add them together.</span>
          ) : (
            <span className="cx-tray-items" aria-label="Cards to add">
              {trayItems.map(([id, n]) => {
                const hit = find(id);
                return (
                  <span key={id} className="cx-traychip">
                    {n}× {hit.p.name} {hit.p.set} {hit.p.number}
                    {hit.e.variant !== "Normal" && ` ${hit.e.variant}`}
                  </span>
                );
              })}
            </span>
          )}
          <span className="dx-spacer" />
          <button type="button" className="dx-b" disabled={!trayCopies} onClick={() => set({ tray: {} })}>
            Clear
          </button>
          <button
            type="button"
            className="dx-b dx-b-primary cx-addall"
            disabled={!trayCopies}
            onClick={() => {
              set({ tray: {} });
              toast(`Added ${trayCopies} cards (${trayItems.length} Editions) to ${targetPath}`);
              embedded?.close();
            }}
          >
            Add {trayCopies || ""} {trayCopies === 1 ? "card" : "cards"}
          </button>
        </div>
      )}
      <div className="cx-toolbar">
        <SearchBox />
      </div>
      <Chips />
      <Status count={list.length} />
      <div className="cx-grid">
        {tiles.map(({ p, e }) => {
          const queued = c.tray[e.id] ?? 0;
          return (
            <div key={e.id} className={`cx-tilewrap${queued ? " cx-queued" : ""}`}>
              <button
                type="button"
                className={`cx-tile${ownedCount(e) ? "" : " cx-unowned"}${e.active ? "" : " cx-inactive"}`}
                onClick={() => openFirst(p, e.id)}
                aria-label={`${p.name}, ${p.set} ${p.number}, ${e.variant}. ${ownedCount(e) ? `${ownedCount(e)} owned` : "Not owned"}, ${money(e.price)}. Details`}
              >
                <CardImage p={p} />
                {ownedCount(e) > 0 && <span className="dx-inlist dx-num">{ownedCount(e)}</span>}
                <span className="cx-tile-cap">
                  <span>
                    {p.set} {p.number} · {e.variant}
                  </span>
                  <span className="cx-muted">{money(e.price)}</span>
                </span>
              </button>
              {adding && e.active && (
                <span className="cx-quick" role="group" aria-label={`${p.name} ${p.set} ${p.number} ${e.variant}: copies to add`}>
                  {queued > 0 && (
                    <>
                      <button type="button" aria-label="One fewer" onClick={() => bump(e.id, -1)}>
                        −
                      </button>
                      <span className="dx-num">{queued}</span>
                    </>
                  )}
                  <button type="button" aria-label="One more" className="cx-plus" onClick={() => bump(e.id, 1)}>
                    +
                  </button>
                </span>
              )}
            </div>
          );
        })}
        {!tiles.length && <p className="cx-muted">No Printings match. Check the spelling, or search by set and number.</p>}
      </div>
      {!embedded && <MyReports />}
      {open && (
        <Modal
          label={`${open.name} · ${open.set} ${open.number}`}
          onClose={() => set({ open: null, report: null })}
          head={
            <span className="cx-pager">
              <button type="button" className="dx-icon" aria-label="Previous card" onClick={() => step(-1)}>
                ‹
              </button>
              <span className="cx-muted dx-num">
                {idx + 1} / {tiles.length}
              </span>
              <button type="button" className="dx-icon" aria-label="Next card" onClick={() => step(1)}>
                ›
              </button>
            </span>
          }
        >
          <PrintingDetail
            p={open}
            editionId={c.open!.edition}
            onEdition={(id) => set({ open: { printing: open.id, edition: id } })}
            defaultLoc={adding ? target : undefined}
          />
        </Modal>
      )}
    </div>
  );
}

/** D's Browse / Add switch, shown in the Catalog page header (page actions sit on the right, per the shell). */
export function CatalogPageActions() {
  const c = useCat();
  if (c.variant !== "D") return null;
  return (
    <div className="dx-segs cx-modeswitch" role="radiogroup" aria-label="Catalog mode">
      <button type="button" role="radio" aria-checked={!c.addMode} onClick={() => set({ addMode: false })}>
        Browse
      </button>
      <button type="button" role="radio" aria-checked={c.addMode} onClick={() => set({ addMode: true })}>
        Add to a Location
      </button>
    </div>
  );
}

/** The one Undo toast, mounted once at the shell root (CollectionAddOverlay). */
/** Collection's Add cards: opens the gallery in Add mode over Collection, set to the open Location. */
export function openAddCards(locId: string) {
  const leaf = LEAVES.some((l) => l.id === locId) ? locId : null;
  set({ addTo: leaf, tray: {}, open: null, q: "" });
}
export function CollectionAddOverlay() {
  const c = useCat();
  const close = () => set({ addTo: undefined, tray: {}, open: null });
  return (
    <>
      {c.addTo !== undefined && (
        <Modal
          label={c.addTo ? `Add cards to ${LEAVES.find((l) => l.id === c.addTo)!.path.split(" / ").pop()}` : "Add cards"}
          onClose={close}
          full
        >
          <Gallery embedded={{ target: c.addTo, close }} />
        </Modal>
      )}
      <Toast />
    </>
  );
}

export function CatalogPage() {
  const c = useCat();
  return c.variant === "A" ? <VariantA /> : c.variant === "B" ? <VariantB /> : c.variant === "C" ? <VariantC /> : <Gallery />;
}

export function CatalogVariantPicker() {
  const c = useCat();
  return (
    <label>
      catalog{" "}
      <select value={c.variant} onChange={(e) => setCatVariant(e.target.value as CatVariant)}>
        {CAT_VARIANTS.map((v) => (
          <option key={v.key} value={v.key}>
            {v.key} ({v.name})
          </option>
        ))}
      </select>
    </label>
  );
}

/** Read outside React (the shell's contextFor); the shell root subscribes with useCat so it re-renders. */
export const catalogHasSidebar = () => state.variant === "B";
export type { Shell };
