// PROTOTYPE — throwaway. Deck variant D: a deck builder modelled on Pokémon TCG Live and Limitless (owner, 2026-10-12).
// The Deck List is the main area (left); a narrower card library sits on the right (one tile per Card Edition, like
// Collection; owned by default, a toggle adds unowned, darkened; format and card-type chips). Dragging a library tile
// into the deck adds one copy of exactly that Edition; tapping it opens a card popup with −1 / N / +1 and arrows to step
// through the results. The deck shows one tile per copy (Spread or Stacked), each with its own state (in this Deck,
// elsewhere, not owned), or a dense List with prices. Tap a copy for its actions; drag a copy onto the library to remove
// it. Every edit offers Undo. Phones get Deck and Library tabs. Adding never moves a physical card.
// Research: docs/planning/app-redesign/wayfinder/research/ptcgl-deck-builder.md and limitless-deck-builder.md.
import React, { useEffect, useRef, useState, type ReactNode } from "react";
import { Art, pickRows, set, toast, useDeck } from "./DeckExperience";
import { ALT_EDITIONS, COST, FORMATS, GROUP, LIBRARY_EXTRA, elsewhere, type Kind, type Line } from "./sample";

type Edition = Omit<Line, "qty" | "inDeck" | "sources"> & { owned: number };
type Identity = { name: string; kind: Kind; editions: Edition[]; owned: number; hue: number };

/** Every Edition the library knows: the Deck List's, the extras and the alternates. */
function editions(lines: Line[]): Edition[] {
  const fromList: Edition[] = lines.map((l) => ({
    id: l.id, name: l.name, set: l.set, variant: l.variant, kind: l.kind, price: l.price, hue: l.hue,
    owned: l.inDeck + l.sources.reduce((n, s) => n + s.available, 0),
  }));
  const others = [...LIBRARY_EXTRA, ...ALT_EDITIONS].filter((x) => !lines.some((l) => l.id === x.id));
  return [...fromList, ...others];
}

function identities(lines: Line[]): Identity[] {
  const byName = new Map<string, Edition[]>();
  for (const e of editions(lines)) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  return [...byName.entries()]
    .map(([name, eds]) => ({ name, kind: eds[0].kind, editions: eds, owned: eds.reduce((n, e) => n + e.owned, 0), hue: eds[0].hue }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const freeOf = (e: Edition, lines: Line[]) => Math.max(0, e.owned - (lines.find((l) => l.id === e.id)?.qty ?? 0));

function addEdition(e: Edition, lines: Line[]) {
  const existing = lines.find((l) => l.id === e.id);
  set((s) => ({
    lines: existing
      ? s.lines.map((l) => (l.id === e.id ? { ...l, qty: l.qty + 1 } : l))
      : [
          ...s.lines,
          {
            id: e.id, name: e.name, set: e.set, variant: e.variant, kind: e.kind, price: e.price, hue: e.hue, qty: 1, inDeck: 0,
            sources: e.owned
              ? [{ loc: "b151", name: "151 display binder", kind: "storage_leaf" as const, available: e.owned, committed: 0, suggested: e.owned }]
              : [],
          },
        ],
  }));
  const note = e.owned === 0 ? " (not owned)" : freeOf(e, lines) === 0 ? " (no spare copy: buy or gather from another Deck)" : "";
  toast(`+1 ${e.name} · ${e.set} ${e.variant}${note}`, lines);
}

function removeCopy(id: string, lines: Line[]) {
  const l = lines.find((x) => x.id === id);
  if (!l) return;
  set((s) => ({
    lines: l.qty > 1 ? s.lines.map((x) => (x.id === id ? { ...x, qty: x.qty - 1 } : x)) : s.lines.filter((x) => x.id !== id),
  }));
  toast(`−1 ${l.name} · ${l.set} ${l.variant}`, lines);
}

/** Swap one copy of a line to another Edition of the same Identity. */
function changeEdition(from: Line, to: Edition, lines: Line[]) {
  removeCopy(from.id, lines);
  addEdition(to, lines.filter((l) => l.id !== from.id || l.qty > 1));
  toast(`Swapped a ${from.name} copy to ${to.set} ${to.variant}`, lines);
}

type CopyState = { kind: "in" } | { kind: "else"; where: string } | { kind: "buy" };
function copyStates(l: Line): CopyState[] {
  const e = elsewhere(l);
  const where = l.sources.filter((s) => s.suggested > 0).flatMap((s) => Array(s.suggested).fill(s.name) as string[]);
  return Array.from({ length: l.qty }, (_, i) =>
    i < l.inDeck ? { kind: "in" } : i < l.inDeck + e ? { kind: "else", where: where[i - l.inDeck] ?? "elsewhere" } : { kind: "buy" }
  );
}
const STATE_LABEL = { in: "In this Deck", else: "Elsewhere", buy: "Not owned" };

/** Library type chips: Pokémon, the Trainer subtypes, Energy (Limitless-style). */
const TYPES = ["All", "Pokémon", "Supporter", "Item", "Tool", "Stadium", "Energy"] as const;
type TypeChip = (typeof TYPES)[number];
const typeOf = (e: { kind: Kind; name: string }): TypeChip =>
  e.kind === "Trainer" ? ((GROUP[e.name] as TypeChip) ?? "Item") : e.kind === "Energy" ? "Energy" : "Pokémon";
/** Sample legality for the library's format chips; the real filter reads the format checks. */
const ROTATED = ["LOR", "CRZ", "SIT", "BRS"];
const FORMAT_CHIPS = [
  { id: "any", label: "Any format" },
  { id: "standard", label: "Standard" },
  { id: "expanded", label: "Expanded" },
  { id: "glc", label: "GLC" },
] as const;
type FormatId = (typeof FORMAT_CHIPS)[number]["id"];
function legalIn(e: { name: string; set: string }, f: FormatId) {
  if (f === "standard") return !ROTATED.includes(e.set.split(" ")[0]);
  if (f === "glc") return !/ ex$/.test(e.name) && !e.name.startsWith("Radiant");
  return true;
}
const GROUP_ORDER = ["Charizard line", "Pidgeot line", "Other Pokémon", "Supporter", "Item", "Tool", "Stadium", "Special Energy", "Basic Energy"];
const byOwnedThenPrice = (a: Edition, b: Edition) => b.owned - a.owned || (a.price ?? 999) - (b.price ?? 999);

// Pointer-event drag, the same pattern as Collection's tile drag (web/src/workspace/tileDrag.tsx): mouse and pen only,
// a 6 px threshold turns a press into a drag, a badge follows the pointer, the target under it is highlighted, and the
// click after a drag is swallowed. Escape cancels. Touch never drags; it taps.
type DragPayload = { kind: "edition" | "copy"; id: string; label: string };
type DragState = DragPayload & { x: number; y: number; over: "deck" | "library" | null };
const DRAG_THRESHOLD = 6;
function swallowNextClick() {
  const swallow = (ev: MouseEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener("click", swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 0);
}
function dropZoneAt(x: number, y: number): "deck" | "library" | null {
  const el = document.elementFromPoint(x, y)?.closest("[data-drop]");
  return (el?.getAttribute("data-drop") as "deck" | "library" | null) ?? null;
}
function usePointerDrag(onDrop: (p: DragPayload, zone: "deck" | "library") => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const live = useRef(onDrop);
  live.current = onDrop;
  const start = (ev: React.PointerEvent, payload: DragPayload) => {
    if (ev.button !== 0 || ev.pointerType === "touch") return;
    const sx = ev.clientX;
    const sy = ev.clientY;
    let active = false;
    const move = (m: PointerEvent) => {
      if (!active && Math.hypot(m.clientX - sx, m.clientY - sy) < DRAG_THRESHOLD) return;
      active = true;
      setDrag({ ...payload, x: m.clientX, y: m.clientY, over: dropZoneAt(m.clientX, m.clientY) });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
      setDrag(null);
    };
    const up = (u: PointerEvent) => {
      const zone = active ? dropZoneAt(u.clientX, u.clientY) : null;
      if (active) swallowNextClick();
      stop();
      if (zone) live.current(payload, zone);
    };
    const key = (k: KeyboardEvent) => k.key === "Escape" && stop();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
  };
  return { drag, start };
}

function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="dx-scrim" onClick={onClose} />
      <div className="dx-modal" role="dialog" aria-modal="true" aria-label={label}>
        <div className="dx-modal-head">
          <strong>{label}</strong>
          <button type="button" className="dx-icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

export function DeckBuilder() {
  const d = useDeck();
  const [showAll, setShowAll] = useState(false);
  const [type, setType] = useState<TypeChip>("All");
  const [format, setFormat] = useState<FormatId>("any");
  const [q, setQ] = useState("");
  const [pane, setPane] = useState<"deck" | "library">("library"); // phone tabs
  const [view, setView] = useState<"spread" | "stacked" | "list">(() =>
    window.matchMedia("(max-width: 760px)").matches ? "stacked" : "spread"
  );
  const [peek, setPeek] = useState<string | null>(null); // Edition id in the card popup
  const [copy, setCopy] = useState<{ line: string; ordinal: number } | null>(null);
  const [bump, setBump] = useState(0);

  const all = editions(d.lines);
  const lib = all
    .filter(
      (e) =>
        (showAll || e.owned > 0) &&
        (type === "All" || typeOf(e) === type) &&
        legalIn(e, format) &&
        e.name.toLowerCase().includes(q.toLowerCase())
    )
    .sort((a, b) => a.name.localeCompare(b.name) || byOwnedThenPrice(a, b));
  const total = d.lines.reduce((n, l) => n + l.qty, 0);
  const toGather = pickRows(d.lines).reduce((n, r) => n + r.take, 0);
  const qtyOf = (id: string) => d.lines.find((l) => l.id === id)?.qty ?? 0;
  const add = (e: Edition) => {
    addEdition(e, d.lines);
    setBump((b) => b + 1);
  };
  const remove = (id: string) => {
    removeCopy(id, d.lines);
    setBump((b) => b + 1);
  };
  const { drag, start } = usePointerDrag((p, zone) => {
    if (p.kind === "edition" && zone === "deck") {
      const edition = all.find((x) => x.id === p.id);
      if (edition) add(edition);
    }
    if (p.kind === "copy" && zone === "library") remove(p.id);
  });
  const dropDeck = drag?.kind === "edition" && drag.over === "deck";
  const dropLib = drag?.kind === "copy" && drag.over === "library";

  const copyLine = copy && d.lines.find((l) => l.id === copy.line);
  const copyState = copyLine ? copyStates(copyLine)[Math.min(copy!.ordinal, copyLine.qty - 1)] : null;
  // The popup steps through the library's current results; a card opened from the deck may not be among them.
  const peekList = peek && lib.some((e) => e.id === peek) ? lib : all;
  const peekIndex = peek ? peekList.findIndex((e) => e.id === peek) : -1;
  const peekEdition = peekIndex >= 0 ? peekList[peekIndex] : null;
  const step = (n: number) => setPeek(peekList[(peekIndex + n + peekList.length) % peekList.length].id);

  const groups = GROUP_ORDER.map((g) => ({ g, lines: d.lines.filter((l) => (GROUP[l.name] ?? l.kind) === g) })).filter(
    (x) => x.lines.length
  );

  const deck = (
    <section
      className={`dx-deckmain${dropDeck ? " dx-drop" : ""}${pane === "deck" ? " dx-pane-on" : ""}`}
      aria-label="Deck List"
      data-drop="deck"
    >
      {/* Row 1: what the deck is (count, cost) and what to do next (gather, buy). */}
      <div className="dx-deckhead">
        <span className="dx-deckcount">
          <strong className="dx-num" key={bump} data-bump>
            {total}
          </strong>
          <span className="dx-muted">/60</span>
        </span>
        <span className="dx-costline dx-muted">
          <span className="dx-num">{`$${COST.list.amount.toFixed(2)}`}</span> deck ·{" "}
          <span className="dx-num">{`$${COST.complete.amount.toFixed(2)}`}</span> to complete
        </span>
        <span className="dx-spacer" />
        <button type="button" className="dx-b dx-b-primary" onClick={() => set({ dialog: "pick" })}>
          Gather {toGather}
        </button>
        <button type="button" className="dx-b" onClick={() => set({ dialog: "export" })}>
          Buy missing
        </button>
      </div>
      {/* Row 2: format status and how the deck is shown. */}
      <div className="dx-deckhead">
        {FORMATS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`dx-pill dx-${f.status}`}
            onClick={() => set({ dialog: "formats" })}
            title={`${f.name}: ${f.status.replace("_", " ")}. Open format checks.`}
          >
            <span aria-hidden="true">{f.status === "legal" ? "✓" : f.status === "not_legal" ? "✕" : "?"}</span>
            {f.id === "glc" ? "GLC" : f.name}
          </button>
        ))}
        <span className="dx-spacer" />
        <div className="dx-segs" role="radiogroup" aria-label="Deck view">
          {(
            [
              ["spread", "Spread"],
              ["stacked", "Stacked"],
              ["list", "List"],
            ] as const
          ).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={view === k} onClick={() => setView(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {dropDeck && <p className="dx-drop-hint">Drop to add one copy</p>}
      <div className="dx-deckbody">
        {groups.map(({ g, lines }) => (
          <section key={g} aria-label={g}>
            <h3 className="dx-group-h">
              {g} <span className="dx-muted dx-num">{lines.reduce((n, l) => n + l.qty, 0)}</span>
            </h3>
            {view === "list" ? (
              <ul className="dx-listview">
                {lines.map((l) => {
                  const st = copyStates(l);
                  const n = (k: CopyState["kind"]) => st.filter((x) => x.kind === k).length;
                  return (
                    <li key={l.id} className={d.focus.includes(l.id) ? "dx-focus" : undefined}>
                      <span className="dx-listqty" role="group" aria-label={`${l.name} quantity`}>
                        <button type="button" aria-label={`One fewer ${l.name}`} onClick={() => remove(l.id)}>
                          −
                        </button>
                        <span className="dx-num">{l.qty}</span>
                        <button type="button" aria-label={`One more ${l.name}`} onClick={() => add(all.find((e) => e.id === l.id)!)}>
                          +
                        </button>
                      </span>
                      <button type="button" className="dx-listname" onClick={() => setPeek(l.id)}>
                        <strong>{l.name}</strong>{" "}
                        <span className="dx-muted">
                          {l.set} · <span className={l.variant === "Unspecified Variant" ? "dx-unspec" : undefined}>{l.variant}</span>
                        </span>
                      </button>
                      <span className="dx-listown dx-small" aria-label={`${n("in")} in Deck, ${n("else")} elsewhere, ${n("buy")} not owned`}>
                        {n("in") > 0 && <span>{n("in")}✓</span>}
                        {n("else") > 0 && <span className="dx-stack-else">{n("else")}↻</span>}
                        {n("buy") > 0 && <span className="dx-stack-buy">{n("buy")}$</span>}
                      </span>
                      <span className="dx-num dx-listprice">{l.price !== null ? `$${(l.price * l.qty).toFixed(2)}` : "—"}</span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className={view === "stacked" ? "dx-copies dx-copies-stacked" : "dx-copies"}>
                {lines.map((l) => {
                  const states = copyStates(l);
                  const tiles = states.map((st, i) => (
                    <button
                      key={i}
                      type="button"
                      className={`dx-copy dx-copy-${st.kind}${d.focus.includes(l.id) ? " dx-focus" : ""}`}
                      onPointerDown={(ev) => start(ev, { kind: "copy", id: l.id, label: `−1 ${l.name}` })}
                      onClick={() => setCopy({ line: l.id, ordinal: i })}
                      onKeyDown={(e) => {
                        if (e.key === "Delete" || e.key === "Backspace") remove(l.id);
                      }}
                      aria-label={`${l.name}, ${l.set} ${l.variant}, copy ${i + 1} of ${l.qty}: ${STATE_LABEL[st.kind]}${st.kind === "else" ? ` in ${st.where}` : ""}`}
                      title={`${l.name} · ${l.set} · ${l.variant} — ${STATE_LABEL[st.kind]}${st.kind === "else" ? `: ${st.where}` : ""}`}
                    >
                      <Art name={l.name} hue={l.hue} ghost={st.kind === "buy"} />
                      {st.kind === "else" && <span className="dx-copy-tag" aria-hidden="true">↻</span>}
                      {st.kind === "buy" && <span className="dx-copy-tag" aria-hidden="true">$</span>}
                    </button>
                  ));
                  const sum = (k: CopyState["kind"]) => states.filter((x) => x.kind === k).length;
                  return view === "stacked" ? (
                    <div key={l.id} className="dx-stack">
                      {tiles}
                      <span className="dx-stack-n dx-num" aria-hidden="true">
                        ×{l.qty}
                        {sum("else") > 0 && <span className="dx-stack-else"> {sum("else")}↻</span>}
                        {sum("buy") > 0 && <span className="dx-stack-buy"> {sum("buy")}$</span>}
                      </span>
                    </div>
                  ) : (
                    <span key={l.id} className="dx-copygroup">
                      {tiles}
                    </span>
                  );
                })}
              </div>
            )}
          </section>
        ))}
        {!groups.length && <p className="dx-muted">Empty Deck List. Drag cards in from the library, or tap one.</p>}
      </div>
      {view !== "list" && groups.length > 0 && (
        <p className="dx-legend dx-legend-foot" aria-hidden="true">
          <span className="dx-copy-key in" />
          in deck
          <span className="dx-copy-key else" />
          elsewhere
          <span className="dx-copy-key buy" />
          to buy · tap a copy for its actions
        </p>
      )}
    </section>
  );

  const library = (
    <section
      className={`dx-library${dropLib ? " dx-drop-remove" : ""}${pane === "library" ? " dx-pane-on" : ""}`}
      aria-label="Card library"
      data-drop="library"
    >
      <div className="dx-libbar">
        <input className="dx-search" type="search" placeholder="Search cards" aria-label="Search cards" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="dx-segs" role="radiogroup" aria-label="Which cards">
          <button type="button" role="radio" aria-checked={!showAll} onClick={() => setShowAll(false)}>
            Owned
          </button>
          <button type="button" role="radio" aria-checked={showAll} onClick={() => setShowAll(true)}>
            All
          </button>
        </div>
      </div>
      <div className="dx-chips" role="radiogroup" aria-label="Format">
        {FORMAT_CHIPS.map((f) => (
          <button key={f.id} type="button" role="radio" className="dx-fchip" aria-checked={format === f.id} onClick={() => setFormat(f.id)}>
            {f.id === "any" ? "Any format" : f.label}
          </button>
        ))}
      </div>
      <div className="dx-chips" role="radiogroup" aria-label="Card type">
        {TYPES.map((t) => (
          <button key={t} type="button" role="radio" className="dx-fchip" aria-checked={type === t} onClick={() => setType(t)}>
            {t}
          </button>
        ))}
      </div>
      {dropLib ? (
        <p className="dx-drop-hint">Drop here to take one copy off the Deck List</p>
      ) : (
        <p className="dx-libhint">
          {lib.length} Editions · drag into the deck, or tap for −1 / +1
        </p>
      )}
      <div className="dx-libgrid">
        {lib.map((e) => {
          const onList = qtyOf(e.id);
          return (
            <button
              key={e.id}
              type="button"
              className={`dx-edtile${e.owned ? "" : " dx-unowned"}`}
              onPointerDown={(ev) => start(ev, { kind: "edition", id: e.id, label: `+1 ${e.name} · ${e.set}` })}
              onClick={() => setPeek(e.id)}
              aria-haspopup="dialog"
              aria-label={`${e.name}, ${e.set} ${e.variant}. ${e.owned ? `${e.owned} owned, ${freeOf(e, d.lines)} free` : "Not owned"}${onList ? `, ${onList} on the Deck List` : ""}`}
              title={`${e.name} · ${e.set} · ${e.variant}`}
            >
              <Art name={e.name} hue={e.hue} />
              {onList > 0 && <span className="dx-inlist dx-num">{onList}</span>}
              <span className="dx-edtile-cap">
                <span>
                  {e.set} · <span className={e.variant === "Unspecified Variant" ? "dx-unspec" : undefined}>{e.variant}</span>
                </span>
                <span className="dx-muted">
                  {e.owned ? `${freeOf(e, d.lines)}/${e.owned} free` : "Not owned"}
                  {e.price !== null ? ` · $${e.price.toFixed(2)}` : ""}
                </span>
              </span>
            </button>
          );
        })}
        {!lib.length && <p className="dx-muted">No cards match. Try All or another filter.</p>}
      </div>
    </section>
  );

  return (
    <div className="dx-d">
      <div className="dx-panes dx-phone" role="tablist" aria-label="Builder">
        <button type="button" role="tab" aria-selected={pane === "deck"} onClick={() => setPane("deck")}>
          Deck{" "}
          <span className="dx-num" key={bump} data-bump>
            {total}
          </span>
          /60
        </button>
        <button type="button" role="tab" aria-selected={pane === "library"} onClick={() => setPane("library")}>
          Library
        </button>
      </div>
      {deck}
      {library}
      {drag && (
        <div className="dx-dragbadge" style={{ left: drag.x + 14, top: drag.y + 10 }} aria-hidden="true">
          {drag.label}
          {drag.over === null && <span className="dx-muted"> — drop on the {drag.kind === "edition" ? "deck" : "library"}</span>}
        </div>
      )}

      {peekEdition && (
        <CardPopup
          e={peekEdition}
          qty={qtyOf(peekEdition.id)}
          free={freeOf(peekEdition, d.lines)}
          position={`${peekIndex + 1} of ${peekList.length}`}
          onAdd={() => add(peekEdition)}
          onRemove={() => remove(peekEdition.id)}
          onStep={step}
          onClose={() => setPeek(null)}
        />
      )}

      {copyLine && copyState && (
        <Sheet label={`${copyLine.name} · copy ${Math.min(copy!.ordinal, copyLine.qty - 1) + 1} of ${copyLine.qty}`} onClose={() => setCopy(null)}>
          <div className="dx-copydetail">
            <Art name={copyLine.name} hue={copyLine.hue} ghost={copyState.kind === "buy"} />
            <div>
              <p>
                <strong>
                  {copyLine.set} · {copyLine.variant}
                </strong>
              </p>
              <p>
                {copyState.kind === "in" && "In this Deck."}
                {copyState.kind === "else" && `Owned, in ${copyState.where}. Gather it to put it in this Deck.`}
                {copyState.kind === "buy" && `Not owned${copyLine.price !== null ? ` · about $${copyLine.price.toFixed(2)}` : ""}.`}
              </p>
            </div>
          </div>
          <div className="dx-row dx-wrap">
            <button type="button" className="dx-btn" onClick={() => add(editions(d.lines).find((e) => e.id === copyLine.id)!)}>
              + Another copy
            </button>
            <button
              type="button"
              className="dx-btn dx-danger"
              onClick={() => {
                remove(copyLine.id);
                if (copyLine.qty <= 1) setCopy(null);
              }}
            >
              − Remove a copy
            </button>
            {copyState.kind === "else" && (
              <button type="button" className="dx-btn dx-primary" onClick={() => (setCopy(null), set({ dialog: "pick" }))}>
                Gather
              </button>
            )}
          </div>
          {(() => {
            const others = identities(d.lines).find((i) => i.name === copyLine.name)?.editions.filter((e) => e.id !== copyLine.id) ?? [];
            return others.length ? (
              <>
                <h4 className="dx-group-h">Swap this copy for</h4>
                <ul className="dx-versions">
                  {others.map((e) => (
                    <li key={e.id} className={e.owned ? undefined : "dx-unowned"}>
                      <Art name={e.name} hue={e.hue} />
                      <span className="dx-name">
                        <strong>
                          {e.set} · {e.variant}
                        </strong>
                        <span className="dx-muted dx-small">{e.owned ? `${freeOf(e, d.lines)} free` : "Not owned"}</span>
                      </span>
                      <button type="button" className="dx-btn" onClick={() => (changeEdition(copyLine, e, d.lines), setCopy(null))}>
                        Swap
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : null;
          })()}
        </Sheet>
      )}
    </div>
  );
}

/** Limitless-style card popup: the card, its ownership and price, −1 / N / +1, and arrows to step through results. */
function CardPopup(props: {
  e: Edition;
  qty: number;
  free: number;
  position: string;
  onAdd: () => void;
  onRemove: () => void;
  onStep: (n: number) => void;
  onClose: () => void;
}) {
  const { e, qty, free, position, onAdd, onRemove, onStep, onClose } = props;
  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      if (ev.key === "ArrowLeft") onStep(-1);
      if (ev.key === "ArrowRight") onStep(1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onStep]);
  return (
    <Sheet label={`${e.name} · ${e.set}`} onClose={onClose}>
      <div className="dx-popup">
        <button type="button" className="dx-icon dx-step" aria-label="Previous card" onClick={() => onStep(-1)}>
          ‹
        </button>
        <div className={`dx-popup-art${e.owned ? "" : " dx-unowned"}`}>
          <Art name={e.name} hue={e.hue} />
        </div>
        <button type="button" className="dx-icon dx-step" aria-label="Next card" onClick={() => onStep(1)}>
          ›
        </button>
      </div>
      <p className="dx-popup-meta">
        <strong>{e.set}</strong> · <span className={e.variant === "Unspecified Variant" ? "dx-unspec" : undefined}>{e.variant}</span>
        <br />
        <span className="dx-muted">
          {e.owned ? `${e.owned} owned · ${free} free` : "Not owned"}
          {e.price !== null ? ` · $${e.price.toFixed(2)}` : " · no price"} · {position}
        </span>
        <br />
        <span className="dx-small">
          {FORMAT_CHIPS.filter((f) => f.id !== "any").map((f) => (
            <span key={f.id} className={`dx-chip ${legalIn(e, f.id) ? "dx-legal" : "dx-not_legal"}`}>
              {legalIn(e, f.id) ? "✓" : "✕"} {f.label}
            </span>
          ))}
        </span>
      </p>
      <div className="dx-qtybar" role="group" aria-label="Copies on the Deck List">
        <button type="button" disabled={qty === 0} onClick={onRemove}>
          −1
        </button>
        <span>
          <strong className="dx-num">{qty}</strong> on Deck List
        </span>
        <button type="button" onClick={onAdd}>
          +1
        </button>
      </div>
    </Sheet>
  );
}
