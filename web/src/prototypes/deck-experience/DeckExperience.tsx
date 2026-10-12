// PROTOTYPE — throwaway. Three answers to "where does Deck work live?" for "Prototype the Deck experience" (#125),
// mounted inside the chosen app shell (Variant A of #122) and switched with ?deck=A|B|C.
//   A  Decks page owns it: the whole Deck (list, ownership, Pick List, formats, cost, exports, publishing) on Decks.
//      Collection's Deck heading only links across.
//   B  Inside Collection: opening a Deck in the Location tree shows Cards / Deck List / Gather beside the gallery.
//      The Decks tab shrinks to an index, New Deck and publications.
//   C  Split by job: planning (list, formats, cost, exports, publishing) on Decks; gathering and put-away in
//      Collection, beside the cards.
// Sample data only; every mutation is a stub that updates memory and shows the Undo toast. Nothing ever blocks on a
// format result.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { Shell } from "../app-shell/AppShellPrototype";
import {
  COMPETITION,
  COST,
  DECK_SUMMARIES,
  FORMATS,
  FUTURE_NOTE,
  LINES,
  ORPHANS,
  PUBLICATION,
  SURPLUS,
  elsewhere,
  notOwned,
  type Format,
  type Kind,
  type Line,
  type Status,
} from "./sample";
import { DeckBuilder } from "./DeckBuilder";
import "./DeckExperience.css";

export const DECK_VARIANTS = [
  { key: "A", name: "Decks page owns it" },
  { key: "B", name: "Inside Collection" },
  { key: "C", name: "Split by job" },
  { key: "D", name: "Library builder (TCG Live style)" },
] as const;
export type DeckVariant = (typeof DECK_VARIANTS)[number]["key"];

// ---------- tiny in-memory store shared by every place a variant renders ----------

type State = {
  variant: DeckVariant;
  lines: Line[];
  surplus: typeof SURPLUS;
  future: boolean;
  focus: string[]; // line ids highlighted from a format issue
  dialog: null | "add" | "export" | "publish" | "delete" | "pick" | "formats";
  bView: "cards" | "list" | "gather";
  picked: Record<string, boolean>; // key `${line}:${loc}`
  sourceOverride: Record<string, string>; // line id -> chosen loc
  toast: string | null;
  /** The Deck List before the last edit, restored by the toast's Undo. */
  undo: Line[] | null;
  deleted: boolean;
};
const initialVariant = new URLSearchParams(location.search).get("deck");
let state: State = {
  variant: (["A", "B", "C", "D"].includes(initialVariant ?? "") ? initialVariant : "A") as DeckVariant,
  lines: LINES.map((l) => ({ ...l, sources: l.sources.map((s) => ({ ...s })) })),
  surplus: SURPLUS,
  future: false,
  focus: [],
  dialog: null,
  bView: "list",
  picked: {},
  sourceOverride: {},
  toast: null,
  undo: null,
  deleted: false,
};
const listeners = new Set<() => void>();
export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}
export function useDeck() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state
  );
}
export function setDeckVariant(v: DeckVariant) {
  const url = new URL(location.href);
  url.searchParams.set("deck", v);
  history.replaceState(null, "", url);
  set({ variant: v, dialog: null, focus: [] });
}
export function toast(text: string, undo: Line[] | null = null) {
  set({ toast: text, undo });
  window.setTimeout(() => set((s) => (s.toast === text ? { toast: null } : {})), 4500);
}
function setQty(id: string, qty: number) {
  if (qty <= 0) {
    const line = state.lines.find((l) => l.id === id)!;
    set((s) => ({
      lines: s.lines.filter((l) => l.id !== id),
      surplus: line.inDeck ? [...s.surplus, { id, name: line.name, set: line.set, variant: line.variant, qty: line.inDeck, hue: line.hue }] : s.surplus,
    }));
    return;
  }
  set((s) => ({
    lines: s.lines.map((l) => (l.id === id ? { ...l, qty } : l)),
    // Cutting below the copies held leaves surplus (story 25); this prototype only shows it on remove.
  }));
}
export function pickRows(lines: Line[]) {
  // One row per (line, source) with suggested copies, honouring a chosen override source.
  return lines.flatMap((l) => {
    const need = l.qty - l.inDeck;
    if (need <= 0 || !l.sources.length) return [];
    const chosen = state.sourceOverride[l.id];
    const srcs = chosen ? l.sources.filter((s) => s.loc === chosen) : l.sources.filter((s) => s.suggested > 0);
    let left = need;
    return srcs.flatMap((s) => {
      const take = Math.min(left, chosen ? s.available : s.suggested);
      left -= take;
      return take > 0 ? [{ line: l, src: s, take, key: `${l.id}:${s.loc}` }] : [];
    });
  });
}
type PickRow = ReturnType<typeof pickRows>[number];
function confirm(rows: PickRow[]) {
  if (!rows.length) return;
  const locs = new Set(rows.map((r) => r.src.loc));
  const copies = rows.reduce((n, r) => n + r.take, 0);
  set((s) => ({
    lines: s.lines.map((l) => {
      const mine = rows.filter((r) => r.line.id === l.id);
      if (!mine.length) return l;
      const got = mine.reduce((n, r) => n + r.take, 0);
      return {
        ...l,
        inDeck: l.inDeck + got,
        sources: l.sources
          .map((src) => {
            const r = mine.find((m) => m.src.loc === src.loc);
            return r ? { ...src, available: src.available - r.take, suggested: 0 } : src;
          })
          .filter((src) => src.available > 0),
      };
    }),
    picked: {},
    dialog: s.dialog === "pick" ? null : s.dialog,
  }));
  // Confirmation takes at most five source Locations; more are confirmed as consecutive batches.
  const batches = Math.ceil(locs.size / 5);
  toast(
    `Moved ${copies} ${copies === 1 ? "copy" : "copies"} from ${locs.size} Location${locs.size === 1 ? "" : "s"} into Charizard ex` +
      (batches > 1 ? ` (in ${batches} batches of up to 5 Locations)` : "")
  );
}

// ---------- shared atoms (data display only; each variant owns its layout) ----------

const money = (n: number) => `$${n.toFixed(2)}`;
const STATUS_TEXT: Record<Status, string> = { legal: "Legal", not_legal: "Not legal", unknown: "Unknown" };
const STATUS_MARK: Record<Status, string> = { legal: "✓", not_legal: "✕", unknown: "?" };

export function Art({ name, hue, ghost }: { name: string; hue: number; ghost?: boolean }) {
  return (
    <span className={`dx-art${ghost ? " dx-art-ghost" : ""}`} style={{ ["--hue" as string]: hue }} aria-hidden="true">
      <span>{name}</span>
    </span>
  );
}

export function CardName({ l }: { l: { name: string; set: string; variant: string } }) {
  return (
    <span className="dx-name">
      <strong>{l.name}</strong>
      <span className="dx-muted">
        {l.set} · <span className={l.variant === "Unspecified Variant" ? "dx-unspec" : undefined}>{l.variant}</span>
      </span>
    </span>
  );
}

/** In this Deck / elsewhere / not owned, as a segmented bar plus words (never colour alone). */
export function Ownership({ l, compact }: { l: Line; compact?: boolean }) {
  const e = elsewhere(l);
  const n = notOwned(l);
  return (
    <span className="dx-own">
      <span className="dx-bar" aria-hidden="true">
        {Array.from({ length: l.qty }, (_, i) => (
          <i key={i} className={i < l.inDeck ? "in" : i < l.inDeck + e ? "else" : "none"} />
        ))}
      </span>
      {!compact && (
        <span className="dx-own-text">
          {l.inDeck} in Deck
          {e > 0 && ` · ${e} elsewhere (${l.sources.filter((s) => s.suggested > 0).map((s) => s.name).join(", ")})`}
          {n > 0 && ` · ${n} not owned`}
        </span>
      )}
    </span>
  );
}

export function Stepper({ l }: { l: Line }) {
  return (
    <span className="dx-stepper" role="group" aria-label={`${l.name} quantity`}>
      <button type="button" aria-label={`One fewer ${l.name}`} onClick={() => setQty(l.id, l.qty - 1)}>
        −
      </button>
      <span className="dx-num">{l.qty}</span>
      <button type="button" aria-label={`One more ${l.name}`} onClick={() => setQty(l.id, l.qty + 1)}>
        +
      </button>
    </span>
  );
}

export function FormatChip({ f, onClick }: { f: Format; onClick?: () => void }) {
  const body = (
    <>
      <span aria-hidden="true">{STATUS_MARK[f.status]}</span> {f.id === "glc" ? "GLC" : f.name}: {STATUS_TEXT[f.status]}
    </>
  );
  return onClick ? (
    <button type="button" className={`dx-chip dx-${f.status}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className={`dx-chip dx-${f.status}`}>{body}</span>
  );
}

function AsOf() {
  const d = useDeck();
  return (
    <label className="dx-asof">
      Check as of{" "}
      <select value={d.future ? "future" : "today"} onChange={(e) => set({ future: e.target.value === "future" })}>
        <option value="today">Today</option>
        <option value="future">2027-04-10 (announced rotation)</option>
      </select>
    </label>
  );
}

/** One format's result with deck-level and card-level issues; a card issue focuses its lines. */
function FormatDetail({ f }: { f: Format }) {
  const d = useDeck();
  const names = (ids: string[]) => ids.map((id) => d.lines.find((l) => l.id === id)?.name).filter(Boolean).join(", ");
  const deckIssues = f.issues.filter((i) => i.kind === "deck");
  const cardIssues = f.issues.filter((i) => i.kind === "card");
  return (
    <section className="dx-format" aria-label={`${f.name} result`}>
      <h3>
        <FormatChip f={f} /> <span className="dx-muted dx-small">{f.rules}</span>
      </h3>
      {d.future && <p className="dx-note">{FUTURE_NOTE}</p>}
      {!f.issues.length && <p className="dx-muted">No issues found.</p>}
      {deckIssues.length > 0 && (
        <>
          <h4>Deck</h4>
          <ul>
            {deckIssues.map((i) => (
              <li key={i.code}>
                <span className={`dx-effect dx-${i.effect}`}>{i.effect === "not_legal" ? "✕" : "?"}</span> {i.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      {cardIssues.length > 0 && (
        <>
          <h4>Cards</h4>
          <ul>
            {cardIssues.map((i) => (
              <li key={i.code}>
                <span className={`dx-effect dx-${i.effect}`}>{i.effect === "not_legal" ? "✕" : "?"}</span> {i.reason}:{" "}
                <button type="button" className="dx-link" onClick={() => set({ focus: i.lines })}>
                  {names(i.lines)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

const DISCLAIMER =
  "Advisory format checks: a result is not a guarantee of tournament legality. Missing rules or card data makes a result unknown, never legal.";

export function CostFigures({ inline }: { inline?: boolean }) {
  return (
    <span className={inline ? "dx-cost-inline" : "dx-cost"}>
      <span>
        <span className="dx-muted">Deck List</span> <strong className="dx-num">{money(COST.list.amount)}</strong>{" "}
        <span className="dx-muted dx-small">
          {COST.list.priced}/{COST.list.total} priced
        </span>
      </span>
      <span>
        <span className="dx-muted">To complete</span> <strong className="dx-num">{money(COST.complete.amount)}</strong>{" "}
        <span className="dx-muted dx-small">
          {COST.complete.priced}/{COST.complete.total} priced
        </span>
      </span>
    </span>
  );
}

function Modal({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <>
      <div className="dx-scrim" onClick={() => set({ dialog: null })} />
      <div className={`dx-modal${wide ? " dx-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={label}>
        <div className="dx-modal-head">
          <strong>{label}</strong>
          <button type="button" className="dx-icon" aria-label="Close" onClick={() => set({ dialog: null })}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

function AddCard() {
  const [q, setQ] = useState("Boss");
  return (
    <Modal label="Add a card to the Deck List">
      <input className="dx-input" type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the catalog" />
      <ul className="dx-results">
        {[
          ["Boss's Orders", "PAL 172", "3 Editions"],
          ["Boss's Orders (Ghetsis)", "PAL 265", "1 Edition"],
          ["Boss's Orders", "BRS 132", "2 Editions"],
        ].map(([n, s, e]) => (
          <li key={s}>
            <CardName l={{ name: n, set: s, variant: e }} />
            <button type="button" className="dx-btn" onClick={() => (set({ dialog: null }), toast(`Added ${n} ${s}: Holo, the cheapest priced Edition`))}>
              Add ×1
            </button>
          </li>
        ))}
      </ul>
      <p className="dx-muted dx-small">Adding by card picks the cheapest priced Edition (or the first in catalog order) and says which.</p>
    </Modal>
  );
}

function ExportDialog() {
  const [kind, setKind] = useState<"live" | "mass">("mass");
  const [scope, setScope] = useState<"not_owned" | "deck_list">("not_owned");
  return (
    <Modal label="Export">
      <div className="dx-seg" role="tablist">
        <button type="button" role="tab" aria-selected={kind === "live"} onClick={() => setKind("live")}>
          Pokémon TCG Live
        </button>
        <button type="button" role="tab" aria-selected={kind === "mass"} onClick={() => setKind("mass")}>
          TCGplayer Mass Entry
        </button>
      </div>
      {kind === "live" ? (
        <>
          <p>The whole Deck List, 60 cards.</p>
          <pre className="dx-pre">{"Pokémon: 13\n4 Charmander MEW 4\n2 Charmeleon PAF 8\n3 Charizard ex OBF 125\n…"}</pre>
          <button type="button" className="dx-btn dx-primary">
            Copy for Live
          </button>
        </>
      ) : (
        <>
          <fieldset className="dx-radios">
            <legend>Send to TCGplayer</legend>
            <label>
              <input type="radio" checked={scope === "not_owned"} onChange={() => setScope("not_owned")} /> Cards I don't own (11 copies)
            </label>
            <label>
              <input type="radio" checked={scope === "deck_list"} onChange={() => setScope("deck_list")} /> The whole Deck List (60)
            </label>
          </fieldset>
          <button type="button" className="dx-btn dx-primary">
            Open in TCGplayer
          </button>
        </>
      )}
    </Modal>
  );
}

function PublishDialog() {
  return (
    <Modal label="Publish">
      <p>
        <strong>{PUBLICATION.title}</strong> · {PUBLICATION.visibility} · version {PUBLICATION.version}
      </p>
      <p className="dx-muted">A Published Deck is a snapshot of the Deck List, including cards you don't own. It never shows what you own or where.</p>
      <div className="dx-row dx-wrap">
        <button type="button" className="dx-btn dx-primary" onClick={() => (set({ dialog: null }), toast("Republished as version 4"))}>
          Republish snapshot
        </button>
        <button type="button" className="dx-btn">
          List in Discover
        </button>
        <button type="button" className="dx-btn dx-danger">
          Revoke link
        </button>
      </div>
    </Modal>
  );
}

function DeleteDialog() {
  const [typed, setTyped] = useState("");
  return (
    <Modal label="Delete Deck">
      <p>
        Deleting <strong>Charizard ex</strong> moves its 41 cards to <strong>Unsorted</strong> and discards its Deck List.
        Its Published Deck stays live until you revoke it.
      </p>
      <label className="dx-field">
        Type the Deck name to confirm
        <input className="dx-input" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </label>
      <button
        type="button"
        className="dx-btn dx-danger"
        disabled={typed !== "Charizard ex"}
        onClick={() => (set({ dialog: null, deleted: true }), toast("Deleted Charizard ex · 41 cards moved to Unsorted"))}
      >
        Delete Deck
      </button>
    </Modal>
  );
}

function Toast() {
  const d = useDeck();
  return d.toast ? (
    <div className="dx-toast" role="status">
      {d.toast}
      <button
        type="button"
        className="dx-link"
        onClick={() => set((s) => ({ toast: null, undo: null, lines: s.undo ?? s.lines }))}
      >
        Undo
      </button>
    </div>
  ) : null;
}

export function Dialogs() {
  const d = useDeck();
  return (
    <>
      {d.dialog === "add" && <AddCard />}
      {d.dialog === "export" && <ExportDialog />}
      {d.dialog === "publish" && <PublishDialog />}
      {d.dialog === "delete" && <DeleteDialog />}
      {d.dialog === "pick" && <PickListByCard />}
      {d.dialog === "formats" && (
        <Modal label="Format checks" wide>
          <AsOf />
          {FORMATS.map((f) => (
            <FormatDetail key={f.id} f={f} />
          ))}
          <p className="dx-muted dx-small">{DISCLAIMER}</p>
        </Modal>
      )}
      <Toast />
    </>
  );
}

function Surplus({ cta }: { cta: string }) {
  const d = useDeck();
  if (!d.surplus.length) return null;
  return (
    <section className="dx-surplus" aria-label="Not on the Deck List">
      <h3>In the Deck, not on the list</h3>
      {d.surplus.map((s) => (
        <div key={s.id} className="dx-surplus-row">
          <CardName l={s} />
          <span className="dx-num">×{s.qty}</span>
          <button
            type="button"
            className="dx-btn"
            onClick={() => (set((st) => ({ surplus: st.surplus.filter((x) => x.id !== s.id) })), toast(`Moved ${s.qty} ${s.name} to Trade box`))}
          >
            {cta}
          </button>
        </div>
      ))}
    </section>
  );
}

function Competition() {
  return (
    <>
      {COMPETITION.map((c) => (
        <p key={c.line} className="dx-warn" role="note">
          ⚠ {c.text}
        </p>
      ))}
    </>
  );
}

// ---------- Pick List, by card: each row picks its source (used by A) ----------

function PickListByCard() {
  const d = useDeck();
  const rows = pickRows(d.lines);
  const locs = new Set(rows.map((r) => r.src.loc));
  const chosen = rows.filter((r) => d.picked[r.key]);
  return (
    <Modal label="Gather cards you own" wide>
      <p className="dx-muted">
        {rows.reduce((n, r) => n + r.take, 0)} copies from {locs.size} Locations. Loose storage first, fewest Locations; another Deck only when nothing else has it.
      </p>
      <table className="dx-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="dx-sr">Pick</span>
            </th>
            <th scope="col">Card</th>
            <th scope="col">Take</th>
            <th scope="col">From</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <input
                  type="checkbox"
                  aria-label={`Pick ${r.take} ${r.line.name} from ${r.src.name}`}
                  checked={!!d.picked[r.key]}
                  onChange={(e) => set((s) => ({ picked: { ...s.picked, [r.key]: e.target.checked } }))}
                />
              </td>
              <td>
                <CardName l={r.line} />
              </td>
              <td className="dx-num">×{r.take}</td>
              <td>
                {r.line.sources.length > 1 ? (
                  <select
                    aria-label={`Source for ${r.line.name}`}
                    value={d.sourceOverride[r.line.id] ?? r.src.loc}
                    onChange={(e) => set((s) => ({ sourceOverride: { ...s.sourceOverride, [r.line.id]: e.target.value } }))}
                  >
                    {r.line.sources.map((s) => (
                      <option key={s.loc} value={s.loc}>
                        {s.name} ({s.available})
                      </option>
                    ))}
                  </select>
                ) : (
                  r.src.name
                )}
                {r.src.kind === "deck" && <span className="dx-warn dx-small"> ⚠ leaves Gardevoir ex 1 short</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dx-row dx-sticky">
        <button type="button" className="dx-btn" disabled={!chosen.length} onClick={() => confirm(chosen)}>
          Confirm {chosen.length || ""} picked
        </button>
        <button type="button" className="dx-btn dx-primary" onClick={() => confirm(rows)}>
          Confirm all
        </button>
        {locs.size > 5 && <span className="dx-muted dx-small">{locs.size} Locations: confirmed in two batches of up to 5.</span>}
      </div>
    </Modal>
  );
}

// ---------- Pick List, by Location: a route of stops (used by C, inside Collection) ----------

function PickRoute() {
  const d = useDeck();
  const rows = pickRows(d.lines);
  // Loose storage first; another Deck is the last stop.
  const stops = [...new Set(rows.map((r) => r.src.loc))]
    .map((loc) => ({ loc, rows: rows.filter((r) => r.src.loc === loc) }))
    .sort((a, b) => Number(a.rows[0].src.kind === "deck") - Number(b.rows[0].src.kind === "deck"));
  if (!rows.length) return <p className="dx-muted">Nothing to gather: every card you own is in the Deck.</p>;
  return (
    <ol className="dx-route">
      {stops.map((stop, i) => (
        <li key={stop.loc} className="dx-stop">
          <div className="dx-stop-head">
            <span className="dx-stop-n">{i + 1}</span>
            <strong>{stop.rows[0].src.name}</strong>
            {stop.rows[0].src.kind === "deck" && <span className="dx-warn dx-small">⚠ another Deck: taking these leaves it short</span>}
            <span className="dx-spacer" />
            <button type="button" className="dx-btn" onClick={() => confirm(stop.rows)}>
              Got these
            </button>
          </div>
          <ul>
            {stop.rows.map((r) => (
              <li key={r.key}>
                <Art name={r.line.name} hue={r.line.hue} />
                <CardName l={r.line} />
                <span className="dx-num">×{r.take}</span>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}

// ---------- Deck List, as rows grouped by kind (A and C) ----------

function ListRows({ editable, ownership }: { editable: boolean; ownership: "full" | "compact" }) {
  const d = useDeck();
  const kinds: Kind[] = ["Pokémon", "Trainer", "Energy"];
  return (
    <>
      {kinds.map((k) => {
        const lines = d.lines.filter((l) => l.kind === k);
        return (
          <section key={k} className="dx-group" aria-label={k}>
            <h3>
              {k} <span className="dx-muted dx-num">{lines.reduce((n, l) => n + l.qty, 0)}</span>
            </h3>
            <ul className="dx-lines">
              {lines.map((l) => (
                <li key={l.id} className={d.focus.includes(l.id) ? "dx-focus" : undefined}>
                  <Art name={l.name} hue={l.hue} ghost={l.inDeck === 0 && elsewhere(l) === 0} />
                  <CardName l={l} />
                  <Ownership l={l} compact={ownership === "compact"} />
                  {editable ? <Stepper l={l} /> : <span className="dx-num">×{l.qty}</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function Totals() {
  const d = useDeck();
  const total = d.lines.reduce((n, l) => n + l.qty, 0);
  const inDeck = d.lines.reduce((n, l) => n + l.inDeck, 0);
  const e = d.lines.reduce((n, l) => n + elsewhere(l), 0);
  return (
    <p className="dx-totals">
      <span className="dx-num">{total}</span>/60 cards · <span className="dx-key in" /> {inDeck} in Deck · <span className="dx-key else" /> {e} elsewhere ·{" "}
      <span className="dx-key none" /> {total - inDeck - e} not owned
    </p>
  );
}

// ---------- Variant A: Decks page owns the Deck ----------

function DeckA() {
  const d = useDeck();
  return (
    <div className="dx-a">
      <div className="dx-a-main">
        <div className="dx-row dx-wrap">
          {FORMATS.map((f) => (
            <FormatChip key={f.id} f={f} onClick={() => set({ dialog: "formats" })} />
          ))}
        </div>
        <CostFigures inline />
        <Totals />
        <Competition />
        <div className="dx-row dx-wrap">
          <button type="button" className="dx-btn dx-primary" onClick={() => set({ dialog: "pick" })}>
            Gather {pickRows(d.lines).reduce((n, r) => n + r.take, 0)} cards I own
          </button>
          <button type="button" className="dx-btn" onClick={() => set({ dialog: "add" })}>
            + Add card
          </button>
        </div>
        <ListRows editable ownership="full" />
        <Surplus cta="Put away…" />
      </div>
      <aside className="dx-a-side" aria-label="Format checks">
        <AsOf />
        {FORMATS.map((f) => (
          <FormatDetail key={f.id} f={f} />
        ))}
        <p className="dx-muted dx-small">{DISCLAIMER}</p>
      </aside>
    </div>
  );
}

// ---------- Variant B: the Deck lives in Collection ----------

function TileList({ mode }: { mode: "list" | "gather" }) {
  const d = useDeck();
  const rows = pickRows(d.lines);
  const picked = rows.filter((r) => d.picked[r.key]);
  if (mode === "gather")
    return (
      <>
        <p className="dx-muted">Select the copies you've pulled, then move them into the Deck. Tiles show where each copy is.</p>
        <div className="dx-tiles">
          {rows.map((r) => (
            <button
              key={r.key}
              type="button"
              className="dx-tile"
              aria-pressed={!!d.picked[r.key]}
              onClick={() => set((s) => ({ picked: { ...s.picked, [r.key]: !s.picked[r.key] } }))}
            >
              <Art name={r.line.name} hue={r.line.hue} />
              <span className="dx-tile-cap">
                ×{r.take} · {r.src.name}
                {r.src.kind === "deck" && " ⚠"}
              </span>
            </button>
          ))}
        </div>
        <div className="dx-strip">
          <span>{picked.length ? `${picked.reduce((n, r) => n + r.take, 0)} copies selected` : `${rows.length} to gather`}</span>
          <span className="dx-spacer" />
          <button type="button" className="dx-btn" onClick={() => set({ picked: Object.fromEntries(rows.map((r) => [r.key, true])) })}>
            Select all
          </button>
          <button type="button" className="dx-btn dx-primary" disabled={!picked.length} onClick={() => confirm(picked)}>
            Move into Deck
          </button>
        </div>
      </>
    );
  return (
    <>
      <Totals />
      <Competition />
      <div className="dx-tiles">
        {d.lines.map((l) => {
          const e = elsewhere(l);
          const n = notOwned(l);
          return (
            <div key={l.id} className={`dx-tile dx-tile-line${d.focus.includes(l.id) ? " dx-focus" : ""}`}>
              <Art name={l.name} hue={l.hue} ghost={l.inDeck === 0 && e === 0} />
              <span className="dx-qty dx-num">×{l.qty}</span>
              <span className="dx-tile-cap">
                {l.inDeck}/{l.qty} here{e ? ` · ${e} elsewhere` : ""}
                {n ? ` · ${n} to buy` : ""}
              </span>
              <Stepper l={l} />
            </div>
          );
        })}
        <button type="button" className="dx-tile dx-tile-add" onClick={() => set({ dialog: "add" })}>
          + Add card
        </button>
      </div>
      <Surplus cta="Move…" />
    </>
  );
}

function DeckB() {
  const d = useDeck();
  return (
    <div className="dx-b">
      <div className="dx-b-head">
        <div className="dx-seg" role="tablist" aria-label="Deck view">
          {(
            [
              ["cards", "Cards in Deck"],
              ["list", "Deck List"],
              ["gather", "Gather"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={d.bView === k} onClick={() => set({ bView: k })}>
              {label}
            </button>
          ))}
        </div>
        <span className="dx-spacer" />
        {FORMATS.map((f) => (
          <FormatChip key={f.id} f={f} onClick={() => set({ dialog: "formats" })} />
        ))}
      </div>
      <CostFigures inline />
      {d.bView === "cards" ? (
        <>
          <p className="dx-muted">The Deck's physical cards: today's Collection gallery, with Move, Remove and Undo.</p>
          <div className="dx-tiles">
            {d.lines
              .filter((l) => l.inDeck)
              .map((l) => (
                <div key={l.id} className="dx-tile">
                  <Art name={l.name} hue={l.hue} />
                  <span className="dx-tile-cap">×{l.inDeck}</span>
                </div>
              ))}
          </div>
        </>
      ) : (
        <TileList mode={d.bView} />
      )}
    </div>
  );
}

// ---------- Variant C: plan on Decks, gather in Collection ----------

function DeckC() {
  return (
    <div className="dx-c">
      <section className="dx-board" aria-label="Format checks">
        <div className="dx-row dx-wrap">
          <h2 className="dx-h2">Formats</h2>
          <span className="dx-spacer" />
          <AsOf />
        </div>
        <div className="dx-board-cols">
          {FORMATS.map((f) => (
            <FormatDetail key={f.id} f={f} />
          ))}
        </div>
        <p className="dx-muted dx-small">{DISCLAIMER}</p>
      </section>
      <section aria-label="Deck List">
        <div className="dx-row dx-wrap">
          <h2 className="dx-h2">Deck List</h2>
          <CostFigures inline />
          <span className="dx-spacer" />
          <button type="button" className="dx-btn" onClick={() => set({ dialog: "add" })}>
            + Add card
          </button>
        </div>
        <Totals />
        <p className="dx-muted dx-small">Gathering cards you own elsewhere happens in Collection, where the cards are.</p>
        <ListRows editable ownership="compact" />
      </section>
    </div>
  );
}

function GatherInCollection({ s }: { s: Shell }) {
  const d = useDeck();
  const rows = pickRows(d.lines);
  const [open, setOpen] = useState(true);
  return (
    <section className="dx-gather" aria-label="Gather for this Deck">
      <div className="dx-row dx-wrap">
        <strong>
          {rows.length ? `${rows.reduce((n, r) => n + r.take, 0)} cards to gather from ${new Set(rows.map((r) => r.src.loc)).size} Locations` : "All owned cards are in the Deck"}
        </strong>
        <span className="dx-spacer" />
        <button type="button" className="dx-link" onClick={() => s.go("decks")}>
          Edit Deck List on Decks →
        </button>
        <button type="button" className="dx-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "Hide route" : "Show route"}
        </button>
        {rows.length > 0 && (
          <button type="button" className="dx-btn dx-primary" onClick={() => confirm(rows)}>
            Got them all
          </button>
        )}
      </div>
      {open && <PickRoute />}
      <Surplus cta="Put away…" />
    </section>
  );
}

// ---------- what the shell mounts ----------

/** Decks tab body. */
export function DecksPage({ s }: { s: Shell }) {
  const d = useDeck();
  const open = s.deck && !d.deleted;
  if (d.variant === "B" || !open) return <DeckIndexPage s={s} />;
  return (
    <>
      {d.variant === "A" ? <DeckA /> : d.variant === "D" ? <DeckBuilder /> : <DeckC />}
      <Dialogs />
    </>
  );
}

/** The Decks index: every Deck with its state, plus publications whose Deck is gone. */
function DeckIndexPage({ s }: { s: Shell }) {
  const d = useDeck();
  const openDeck = (id: string) => {
    if (d.variant === "B") {
      s.go("collection");
      s.chooseLoc(id);
    } else s.setDeck(id);
  };
  return (
    <div className="dx-index">
      {d.variant === "B" && <p className="dx-muted">Open a Deck to edit its Deck List and gather cards in Collection.</p>}
      <ul className="dx-index-list">
        {DECK_SUMMARIES.filter((x) => !(d.deleted && x.id === "d-zard")).map((x) => (
          <li key={x.id}>
            <button type="button" className="dx-index-row" onClick={() => openDeck(x.id)}>
              <strong>{x.name}</strong>
              <span className="dx-muted">
                {x.total ? `${x.owned}/${x.total} in Deck` : "Empty: plan a list"}
                {x.toComplete ? ` · ${money(x.toComplete)} to complete` : ""}
              </span>
              <span className="dx-row">
                {FORMATS.map((f, i) => (
                  <span key={f.id} className={`dx-chip dx-${x.status[i]}`}>
                    {STATUS_MARK[x.status[i]]} {f.id === "glc" ? "GLC" : f.name}
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <section aria-label="Published Decks" className="dx-pubs">
        <h2 className="dx-h2">Published Decks</h2>
        <ul>
          <li>
            {PUBLICATION.title} · {PUBLICATION.visibility} · v{PUBLICATION.version} <span className="dx-muted">(Charizard ex)</span>
          </li>
          {ORPHANS.map((o) => (
            <li key={o.token}>
              {o.title} · {o.visibility} · v{o.version}{" "}
              <span className="dx-muted">Deck deleted; still live.</span>{" "}
              <button type="button" className="dx-btn">
                Make Unlisted
              </button>{" "}
              <button type="button" className="dx-btn dx-danger">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>
      <Dialogs />
    </div>
  );
}

/** Decks tab header actions. */
export function DecksActions({ s }: { s: Shell }) {
  const d = useDeck();
  if (d.variant === "B" || !s.deck || d.deleted)
    return (
      <button type="button" className="ps-btn ps-btn-primary">
        New Deck
      </button>
    );
  return <DeckActionButtons />;
}

function DeckActionButtons() {
  return (
    <>
      <button type="button" className="ps-btn" onClick={() => set({ dialog: "export" })}>
        Export
      </button>
      <button type="button" className="ps-btn ps-btn-primary" onClick={() => set({ dialog: "publish" })}>
        Publish
      </button>
      <button type="button" className="ps-btn" aria-label="Delete Deck" onClick={() => set({ dialog: "delete" })}>
        Delete
      </button>
    </>
  );
}

/** When Collection shows a Deck: returns the body to show, or null for the shell's ordinary gallery. */
export function CollectionDeck({ s, gallery }: { s: Shell; gallery: ReactNode }) {
  const d = useDeck();
  if (d.deleted && s.loc === "d-zard") return <>{gallery}</>;
  if (d.variant === "A" || d.variant === "D")
    return (
      <>
        <div className="dx-banner">
          <CostFigures inline />
          <span className="dx-spacer" />
          <button type="button" className="dx-link" onClick={() => (s.go("decks"), s.setDeck(s.loc))}>
            Open Deck List, Pick List and formats on Decks →
          </button>
        </div>
        {gallery}
      </>
    );
  if (d.variant === "B")
    return (
      <>
        <DeckB />
        <Dialogs />
      </>
    );
  return (
    <>
      <GatherInCollection s={s} />
      {gallery}
      <Dialogs />
    </>
  );
}

/** Collection header actions while a Deck is open. */
export function CollectionDeckActions() {
  const d = useDeck();
  if (d.variant === "B") return <DeckActionButtons />;
  return (
    <button type="button" className="ps-btn" onClick={() => set({ dialog: "export" })}>
      Export
    </button>
  );
}

export function DeckVariantPicker() {
  const d = useDeck();
  return (
    <label>
      deck{" "}
      <select value={d.variant} onChange={(e) => setDeckVariant(e.target.value as DeckVariant)}>
        {DECK_VARIANTS.map((v) => (
          <option key={v.key} value={v.key}>
            {v.key} ({v.name})
          </option>
        ))}
      </select>
    </label>
  );
}
