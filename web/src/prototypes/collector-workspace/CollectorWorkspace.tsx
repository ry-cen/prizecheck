/// <reference types="vite/client" />
// Throwaway: three collector workspace layouts on /locations?prototype=collector&variant=A|B|C.
import { useEffect, useRef, useState } from "react";
import "./prototype.css";
import MinimalWorkspace from "./MinimalWorkspace";

type Card = {
  id: string;
  name: string;
  number: string;
  set: string;
  type: string;
  finish: string;
  art: string;
};
const cards: Card[] = [
  {
    id: "charizard",
    name: "Charizard ex",
    number: "199 / 165",
    set: "Pokémon 151",
    type: "Fire",
    finish: "Special illustration rare",
    art: "sv03.5/199",
  },
  {
    id: "venusaur",
    name: "Venusaur ex",
    number: "198 / 165",
    set: "Pokémon 151",
    type: "Grass",
    finish: "Special illustration rare",
    art: "sv03.5/198",
  },
  {
    id: "blastoise",
    name: "Blastoise ex",
    number: "200 / 165",
    set: "Pokémon 151",
    type: "Water",
    finish: "Special illustration rare",
    art: "sv03.5/200",
  },
  {
    id: "pikachu",
    name: "Pikachu",
    number: "173 / 165",
    set: "Pokémon 151",
    type: "Lightning",
    finish: "Illustration rare",
    art: "sv03.5/173",
  },
  {
    id: "mew",
    name: "Mew ex",
    number: "151 / 165",
    set: "Pokémon 151",
    type: "Psychic",
    finish: "Double rare · holofoil",
    art: "sv03.5/151",
  },
  {
    id: "alakazam",
    name: "Alakazam ex",
    number: "201 / 165",
    set: "Pokémon 151",
    type: "Psychic",
    finish: "Special illustration rare",
    art: "sv03.5/201",
  },
  {
    id: "gengar",
    name: "Gengar",
    number: "094 / 165",
    set: "Pokémon 151",
    type: "Psychic",
    finish: "Reverse holofoil",
    art: "sv03.5/094",
  },
  {
    id: "dragonair",
    name: "Dragonair",
    number: "181 / 165",
    set: "Pokémon 151",
    type: "Dragon",
    finish: "Illustration rare",
    art: "sv03.5/181",
  },
];
const leaves = [
  { id: "binder", name: "151 display binder", kind: "Storage leaf", icon: "▤" },
  { id: "box", name: "Trade box", kind: "Storage leaf", icon: "▣" },
  { id: "deck", name: "Crimson flight", kind: "Physical Deck", icon: "◇" },
  { id: "psychic", name: "Psychic current", kind: "Physical Deck", icon: "◇" },
];
type Inventory = Record<string, Record<string, number>>;
const initial = (): Inventory => ({
  binder: {
    charizard: 5,
    venusaur: 2,
    blastoise: 2,
    pikachu: 4,
    mew: 2,
    alakazam: 2,
    gengar: 3,
    dragonair: 2,
  },
  box: { charizard: 1, pikachu: 3, gengar: 2, mew: 1 },
  deck: { charizard: 1, dragonair: 1 },
  psychic: { mew: 1, alakazam: 1 },
});
type Move = {
  items: Record<string, number>;
  from: string;
  to: string;
  expires: number;
};
const names = {
  A: "Gallery workspace",
  B: "Deck building table",
  C: "Inventory & inspection",
};
type Variant = keyof typeof names;
function readVariant(): Variant {
  const value = new URLSearchParams(location.search).get("variant");
  return value === "B" || value === "C" ? value : "A";
}
function Artwork({ card, large = false }: { card: Card; large?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [card.id]);
  return (
    <div
      className={`cp-art cp-${card.type.toLowerCase()} ${large ? "cp-art-large" : ""}`}
    >
      {!failed && (
        <img
          draggable={false}
          src={`https://assets.tcgdex.net/en/sv/${card.art}/high.webp`}
          alt={`${card.name} card artwork`}
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <div className="cp-art-fallback">
          <span>POKÉMON</span>
          <strong>{card.name}</strong>
          <div>✦</div>
          <small>
            {card.finish}
            <br />
            {card.number}
          </small>
        </div>
      )}
    </div>
  );
}
function HistoricalWorkspace() {
  const [variant, setVariant] = useState<Variant>(readVariant);
  const [inventory, setInventory] = useState(initial);
  const [view, setView] = useState("all");
  const [selected, setSelected] = useState("charizard");
  const [source, setSource] = useState("binder");
  const [destination, setDestination] = useState("deck");
  const [quantity, setQuantity] = useState(1);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("All types");
  const [moves, setMoves] = useState<Move[]>([]);
  const [message, setMessage] = useState(
    "Select a card. Choose where its physical copies go."
  );
  const [drawer, setDrawer] = useState<"nav" | "detail" | null>(null);
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState("");
  const [now, setNow] = useState(Date.now());
  const [copySource, setCopySource] = useState("binder");
  const [copySelection, setCopySelection] = useState<string[]>([]);
  const selectionRef = useRef<string[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const dragPayload = useRef<{
    from: string;
    items: Record<string, number>;
  } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<{ x: number; y: number; base: string[] } | null>(null);
  const [box, setBox] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  function updateSelection(keys: string[]) {
    selectionRef.current = keys;
    setCopySelection(keys);
  }
  function selectedItems(keys = selectionRef.current) {
    const items: Record<string, number> = {};
    keys.forEach((key) => {
      const id = key.split(":")[0];
      items[id] = (items[id] || 0) + 1;
    });
    return items;
  }
  function changeCopySource(place: string) {
    updateSelection([]);
    setCopySource(place);
  }
  useEffect(() => {
    updateSelection([]);
  }, [variant, query, type]);
  const drawerRef = useRef<HTMLElement>(null);
  const card = cards.find((c) => c.id === selected)!;
  const count = (id: string, place = view) =>
    place === "all"
      ? leaves.reduce((n, l) => n + (inventory[l.id][id] || 0), 0)
      : inventory[place][id] || 0;
  const leafTotal = (place: string) =>
    Object.values(inventory[place]).reduce((a, b) => a + b, 0);
  const available = count(selected, source);
  const valid = source !== destination && quantity > 0 && quantity <= available;
  const visible = cards.filter(
    (c) =>
      count(c.id) > 0 &&
      `${c.name} ${c.set} ${c.number} ${c.finish}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (type === "All types" || c.type === type)
  );
  const activeMoves = moves.filter((m) => m.expires > now);
  function cycle(delta: number) {
    setVariant((current) => {
      const keys: Variant[] = ["A", "B", "C"];
      const next = keys[(keys.indexOf(current) + delta + 3) % 3];
      const url = new URL(location.href);
      url.searchParams.set("variant", next);
      if (next === "A") location.assign(url);
      else history.pushState(null, "", url);
      return next;
    });
  }
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        updateSelection([]);
        boxRef.current = null;
        setBox(null);
      }
      if (
        (e.target as HTMLElement).closest(
          "input,textarea,select,button,[contenteditable],[role=dialog]"
        ) ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      )
        return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        cycle(e.key === "ArrowLeft" ? -1 : 1);
      }
    };
    const pop = () => setVariant(readVariant());
    window.addEventListener("keydown", keyboard);
    window.addEventListener("popstate", pop);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener("keydown", keyboard);
      window.removeEventListener("popstate", pop);
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!drawer) return;
    const opener = document.activeElement as HTMLElement;
    const focusable = () =>
      Array.from(
        drawerRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),select,input,[tabindex='0']"
        ) || []
      );
    focusable()[0]?.focus();
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(null);
      if (e.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            !drawerRef.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          last?.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            !drawerRef.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("keydown", close);
      opener?.focus();
    };
  }, [drawer]);
  function select(id: string, from?: string) {
    updateSelection([]);
    setSelected(id);
    setSource(
      from ||
        (view !== "all" && count(id, view)
          ? view
          : leaves.find((l) => count(id, l.id))!.id)
    );
    setQuantity(1);
  }
  function browse(place: string) {
    updateSelection([]);
    if (place !== "all") changeCopySource(place);
    setView(place);
    if (place !== "all") {
      const nextCard =
        count(selected, place) > 0
          ? selected
          : cards.find((c) => count(c.id, place) > 0)?.id;
      if (nextCard) select(nextCard, place);
    }
  }
  function transfer(
    from: string,
    to: string,
    items: Record<string, number>,
    record = true
  ) {
    const entries = Object.entries(items);
    if (
      !inventory[from] ||
      !inventory[to] ||
      from === to ||
      !entries.length ||
      entries.some(
        ([id, n]) =>
          !cards.some((c) => c.id === id) ||
          !Number.isInteger(n) ||
          n < 1 ||
          count(id, from) < n
      )
    ) {
      setMessage(
        "Choose available copies and a different physical destination. Nothing moved."
      );
      return false;
    }
    const next = {
      ...inventory,
      [from]: { ...inventory[from] },
      [to]: { ...inventory[to] },
    };
    entries.forEach(([id, n]) => {
      next[from][id] = (next[from][id] || 0) - n;
      next[to][id] = (next[to][id] || 0) + n;
    });
    setInventory(next);
    if (record)
      setMoves(
        [
          { from, to, items, expires: Date.now() + 600000 },
          ...activeMoves,
        ].slice(0, 5)
      );
    updateSelection([]);
    setQuantity(Math.max(1, Math.min(quantity, next[source][selected] || 1)));
    if (!next[source][selected]) {
      const home = leaves.find((l) => next[l.id][selected] > 0);
      if (home) setSource(home.id);
    }
    const total = entries.reduce((n, [, amount]) => n + amount, 0);
    setMessage(
      `${record ? "Moved" : "Undid move of"} ${total} copies / ${entries.length} Editions from ${leaves.find((l) => l.id === from)!.name} to ${leaves.find((l) => l.id === to)!.name}.`
    );
    return true;
  }
  function move(to = destination) {
    if (transfer(source, to, { [selected]: quantity })) {
      setDestination(to);
      if (count(selected, source) === quantity) setSource(to);
    }
  }
  function undo() {
    const latest = activeMoves[0];
    if (!latest) return;
    if (transfer(latest.to, latest.from, latest.items, false)) {
      setMoves(activeMoves.slice(1));
      setSelected(Object.keys(latest.items)[0]);
      setSource(latest.from);
      setQuantity(1);
    } else {
      setMoves(activeMoves.slice(1));
      setMessage(
        "This move can no longer be undone: its destination has fewer copies. Nothing moved; older Undo moves remain available."
      );
    }
  }
  function beginSingleDrag(e: React.DragEvent, id: string) {
    const from =
      view !== "all" && count(id, view)
        ? view
        : leaves.find((l) => count(id, l.id))!.id;
    const amount = selected === id && source === from ? quantity : 1;
    dragPayload.current = { from, items: { [id]: amount } };
    e.dataTransfer.setData(
      "application/x-collector-move",
      JSON.stringify(dragPayload.current)
    );
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
  }
  function endDrag() {
    dragPayload.current = null;
    setDragging(false);
    setHover("");
  }
  function dropProps(id: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        const payload = dragPayload.current;
        if (dragging && payload && payload.from !== id) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setHover(id);
        }
      },
      onDragLeave: () => setHover(""),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        const payload = dragPayload.current;
        if (payload) transfer(payload.from, id, payload.items);
        endDrag();
      },
    };
  }
  const navigation = (
    <>
      <div className="cp-side-title">
        YOUR COLLECTION{" "}
        <span>{leaves.reduce((n, l) => n + leafTotal(l.id), 0)}</span>
      </div>
      <button
        className={`cp-location ${view === "all" ? "active" : ""}`}
        onClick={() => {
          browse("all");
          setDrawer(null);
        }}
      >
        <span>◈</span>
        <div>
          All owned cards<small>Collection · aggregate view</small>
        </div>
      </button>
      <div className="cp-side-title">STORAGE</div>
      {leaves.map((l) => (
        <div
          key={l.id}
          className={`cp-location-wrap ${hover === l.id ? "cp-drop-active" : ""}`}
          {...dropProps(l.id)}
        >
          <button
            className={`cp-location ${view === l.id ? "active" : ""}`}
            onClick={() => {
              browse(l.id);
              setDrawer(null);
            }}
          >
            <span>{l.icon}</span>
            <div>
              {l.name}
              <small>
                {l.kind} · {leafTotal(l.id)} copies
              </small>
            </div>
          </button>
          <button
            className={`cp-target ${destination === l.id ? "chosen" : ""}`}
            aria-label={`Set ${l.name} as destination`}
            aria-pressed={destination === l.id}
            onClick={() => setDestination(l.id)}
          >
            ↗
          </button>
        </div>
      ))}
      <div className="cp-side-note">
        Every card has a home.
        <br />
        Drag selected copies to a leaf or Deck, or use Move.
      </div>
    </>
  );
  const controls = (
    <div className="cp-toolbar">
      <label className="cp-search">
        <span>⌕</span>
        <input
          aria-label="Search owned cards"
          placeholder="Search your owned cards…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      <select
        aria-label="Filter by card type"
        value={type}
        onChange={(e) => setType(e.target.value)}
      >
        {[
          "All types",
          "Fire",
          "Grass",
          "Water",
          "Lightning",
          "Psychic",
          "Dragon",
        ].map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
    </div>
  );
  const copyCards = visible.filter((c) => count(c.id, copySource) > 0);
  const selectionItems = selectedItems(copySelection);
  const selectionControls = (
    <div className="cp-selection-controls">
      <label>
        Select copies from
        <select
          value={copySource}
          onChange={(e) => changeCopySource(e.target.value)}
        >
          {leaves.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({leafTotal(l.id)} copies)
            </option>
          ))}
        </select>
      </label>
      <div className="cp-selection-actions">
        <button
          aria-pressed={selectMode}
          onClick={() => setSelectMode(!selectMode)}
        >
          Select mode {selectMode ? "on" : "off"}
        </button>
        <strong aria-live="polite">
          {copySelection.length} copies / {Object.keys(selectionItems).length}{" "}
          Editions
        </strong>
        <button
          disabled={!copySelection.length}
          onClick={() => updateSelection([])}
        >
          Clear
        </button>
      </div>
      <p>
        Ctrl / Cmd-click copies, or drag empty space to box select. Select mode
        adds copies by tap or Space. Escape clears.
      </p>
      <label>
        Destination
        <select
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          {leaves.map((l) => (
            <option key={l.id} value={l.id} disabled={l.id === copySource}>
              {l.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="cp-primary"
        disabled={!copySelection.length || destination === copySource}
        onClick={() => transfer(copySource, destination, selectionItems)}
      >
        Move selected ({copySelection.length}) →
      </button>
    </div>
  );
  const grid = (
    <div
      className={`cp-grid ${variant === "B" ? `cp-copy-grid ${selectMode ? "cp-select-mode" : ""}` : ""}`}
      ref={gridRef}
      onPointerDown={(e) => {
        if (
          variant !== "B" ||
          (e.pointerType === "touch" && !selectMode) ||
          e.button !== 0 ||
          (e.target as HTMLElement).closest(
            "button,input,select,label,[data-copy-card]"
          )
        )
          return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
        const y = e.clientY - rect.top + e.currentTarget.scrollTop;
        boxRef.current = {
          x,
          y,
          base:
            e.ctrlKey || e.metaKey || selectMode
              ? [...selectionRef.current]
              : [],
        };
        updateSelection(boxRef.current.base);
        setBox({ x, y, width: 0, height: 0 });
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const start = boxRef.current;
        if (!start) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
        const y = e.clientY - rect.top + e.currentTarget.scrollTop;
        const selectionBox = {
          x: Math.min(x, start.x),
          y: Math.min(y, start.y),
          width: Math.abs(x - start.x),
          height: Math.abs(y - start.y),
        };
        setBox(selectionBox);
        const hits: string[] = [];
        e.currentTarget
          .querySelectorAll<HTMLElement>("[data-copy-key]")
          .forEach((target) => {
            const hit = target.getBoundingClientRect();
            const left = hit.left - rect.left + e.currentTarget.scrollLeft;
            const top = hit.top - rect.top + e.currentTarget.scrollTop;
            if (
              left < selectionBox.x + selectionBox.width &&
              left + hit.width > selectionBox.x &&
              top < selectionBox.y + selectionBox.height &&
              top + hit.height > selectionBox.y
            )
              hits.push(target.dataset.copyKey!);
          });
        updateSelection([...new Set([...start.base, ...hits])]);
      }}
      onPointerUp={(e) => {
        boxRef.current = null;
        setBox(null);
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        boxRef.current = null;
        setBox(null);
      }}
    >
      {(variant === "B" ? copyCards : visible).map((c) =>
        variant === "B" ? (
          <div key={c.id} className="cp-copy-card" data-copy-card>
            <div
              className="cp-fan"
              aria-label={`${count(c.id, copySource)} available copies of ${c.name}`}
            >
              {Array.from({ length: count(c.id, copySource) }, (_, index) => {
                const key = `${c.id}:${index}`;
                return (
                  <button
                    key={key}
                    data-copy-key={key}
                    className={`cp-copy-handle ${copySelection.includes(key) ? "cp-copy-selected" : ""}`}
                    aria-label={`${c.name}, copy ${index + 1} in ${leaves.find((l) => l.id === copySource)!.name}`}
                    aria-pressed={copySelection.includes(key)}
                    draggable
                    onClick={(e) => {
                      setSelected(c.id);
                      setSource(copySource);
                      setQuantity(1);
                      const current = selectionRef.current;
                      updateSelection(
                        e.ctrlKey || e.metaKey || selectMode
                          ? current.includes(key)
                            ? current.filter((k) => k !== key)
                            : [...current, key]
                          : [key]
                      );
                    }}
                    onDragStart={(e) => {
                      if (!selectionRef.current.includes(key))
                        updateSelection([key]);
                      dragPayload.current = {
                        from: copySource,
                        items: selectedItems(),
                      };
                      e.dataTransfer.setData(
                        "application/x-collector-move",
                        JSON.stringify(dragPayload.current)
                      );
                      e.dataTransfer.effectAllowed = "move";
                      setDragging(true);
                    }}
                    onDragEnd={endDrag}
                  >
                    <Artwork card={c} />
                    <span className="cp-copy-number">
                      {index + 1}
                      {copySelection.includes(key) ? " ✓" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="cp-card-caption">
              <strong>{c.name}</strong>
              <span>×{count(c.id, copySource)}</span>
            </div>
            <small>
              {c.number} · {c.finish}
            </small>
            <button
              className="cp-inspect-copy"
              onClick={() => {
                setSelected(c.id);
                setSource(copySource);
                setQuantity(1);
                setDrawer("detail");
              }}
            >
              Inspect
            </button>
          </div>
        ) : (
          <button
            key={c.id}
            className={`cp-card ${selected === c.id ? "selected" : ""}`}
            onClick={() => select(c.id)}
            draggable
            onDragStart={(e) => beginSingleDrag(e, c.id)}
            onDragEnd={endDrag}
          >
            <Artwork card={c} />
            <div className="cp-card-caption">
              <strong>{c.name}</strong>
              <span>×{count(c.id)}</span>
            </div>
            <small>
              {c.number} · {c.finish}
            </small>
          </button>
        )
      )}
      {box && (
        <div
          className="cp-selection-box"
          style={{
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
          }}
        />
      )}
    </div>
  );
  const details = (
    <>
      <div className="cp-detail-heading">
        <span>CARD INSPECTION</span>
        <button className="cp-mobile-only" onClick={() => setDrawer(null)}>
          Close
        </button>
      </div>
      <Artwork card={card} large />
      <div className="cp-detail-copy">
        <div className="cp-eyebrow">{card.set} · English</div>
        <h2>{card.name}</h2>
        <p>
          {card.number} <span className="cp-type-tag">{card.type}</span>
        </p>
        <p>{card.finish}</p>
        <div className="cp-held">
          <span>Owned in Collection</span>
          <strong>{count(selected, "all")} copies</strong>
        </div>
        <div className="cp-move-form">
          <label>
            Move from
            <select
              value={source}
              onChange={(e) => {
                updateSelection([]);
                setSource(e.target.value);
                setQuantity(1);
              }}
            >
              {leaves
                .filter((l) => count(selected, l.id) > 0)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({count(selected, l.id)})
                  </option>
                ))}
            </select>
          </label>
          <div className="cp-move-line">
            <label>
              Copies
              <select
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              >
                {Array.from({ length: available }, (_, i) => (
                  <option key={i + 1}>{i + 1}</option>
                ))}
              </select>
            </label>
            <label>
              Destination
              <select
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                {leaves.map((l) => (
                  <option key={l.id} value={l.id} disabled={l.id === source}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button
            className="cp-primary"
            disabled={!valid}
            onClick={() => move()}
          >
            Move {quantity} {quantity === 1 ? "copy" : "copies"} →
          </button>
          <small>
            {leaves.find((l) => l.id === source)?.kind === "Physical Deck"
              ? "Move back to storage by choosing a Storage Leaf."
              : "Physical copies move together immediately."}
          </small>
        </div>
      </div>
    </>
  );
  const deck = (
    <section
      className={`cp-deck ${hover === destination ? "cp-drop-active" : ""}`}
      {...dropProps(destination)}
    >
      <div className="cp-eyebrow">
        SELECTED DESTINATION · {leaves.find((l) => l.id === destination)!.kind}
      </div>
      <h2>{leaves.find((l) => l.id === destination)!.name}</h2>
      <div className="cp-deck-count">
        <strong>{leafTotal(destination)}</strong>
        <span>
          physical copies
          <br />
          {destination === "deck" || destination === "psychic"
            ? "of 60 in a complete Deck"
            : "stored in this leaf"}
        </span>
      </div>
      <div className="cp-drop-hint">↘ Drop selected copies here</div>
      <div className="cp-deck-list">
        {cards
          .filter((c) => count(c.id, destination))
          .map((c) => (
            <button key={c.id} onClick={() => select(c.id, destination)}>
              <Artwork card={c} />
              <span>
                <strong>{c.name}</strong>
                <small>{c.finish}</small>
              </span>
              <b>×{count(c.id, destination)}</b>
            </button>
          ))}
      </div>
      <button
        onClick={() => {
          browse(destination);
          setQuery("");
          setType("All types");
        }}
      >
        Browse this{" "}
        {destination === "deck" || destination === "psychic" ? "Deck" : "leaf"}{" "}
        →
      </button>
    </section>
  );
  return (
    <div className={`cp-root cp-variant-${variant}`}>
      <div className="cp-surface" inert={!!drawer}>
        <header className="cp-header">
          <div className="cp-brand">
            <span>◈</span> CARD ATLAS <small>COLLECTOR WORKSPACE</small>
          </div>
          <div className="cp-prototype-tag">SAMPLE DATA · PROTOTYPE</div>
          <button
            className="cp-reset"
            onClick={() => {
              updateSelection([]);
              setCopySource("binder");
              setInventory(initial());
              setMoves([]);
              setSource("binder");
              setSelected("charizard");
              setQuantity(1);
              setDestination("deck");
              setMessage("Sample Collection reset.");
            }}
          >
            Reset sample
          </button>
        </header>
        <div className="cp-mobile-tools">
          <button onClick={() => setDrawer("nav")}>☰ Locations</button>
          <button onClick={() => setDrawer("detail")}>
            Inspect · {card.name}
          </button>
        </div>
        <div className="cp-layout">
          <aside className="cp-sidebar">{navigation}</aside>
          <div className="cp-workspace">
            <div className="cp-workspace-heading">
              <div>
                <div className="cp-eyebrow">
                  {variant === "B"
                    ? "BUILD FROM WHAT YOU OWN"
                    : "YOUR PHYSICAL COLLECTION"}
                </div>
                <h1>
                  {view === "all"
                    ? variant === "C"
                      ? "The inventory"
                      : "All owned cards"
                    : leaves.find((l) => l.id === view)!.name}
                </h1>
                <p>
                  {visible.length} editions ·{" "}
                  {visible.reduce((n, c) => n + count(c.id), 0)} copies{" "}
                  <span>
                    {" "}
                    /{" "}
                    {variant === "A"
                      ? "A little closer to your collection."
                      : variant === "B"
                        ? "Find the next card for your Deck."
                        : "Every edition. Every home."}
                  </span>
                </p>
              </div>
            </div>
            <div className="cp-destination-strip">
              <span>
                Moving to{" "}
                <strong>
                  {leaves.find((l) => l.id === destination)!.name}
                </strong>
              </span>
              <span>{leaves.find((l) => l.id === destination)!.kind} ↗</span>
            </div>
            {variant === "B" ? (
              <div className="cp-build-split">
                <section className="cp-pool">
                  {controls}
                  {selectionControls}
                  {grid}
                  {!copyCards.length && (
                    <p className="cp-empty">
                      No owned editions match these filters.
                    </p>
                  )}
                </section>
                {deck}
              </div>
            ) : (
              <>
                {controls}
                {variant === "A" ? (
                  grid
                ) : (
                  <div className="cp-inventory-list">
                    <div className="cp-row-header">
                      <span>CARD EDITION</span>
                      <span>PHYSICAL HOME</span>
                      <span>OWNED</span>
                    </div>
                    {visible.map((c) => (
                      <button
                        key={c.id}
                        className={`cp-inventory-row ${selected === c.id ? "selected" : ""}`}
                        onClick={() => select(c.id)}
                        draggable
                        onDragStart={(e) => beginSingleDrag(e, c.id)}
                        onDragEnd={endDrag}
                      >
                        <Artwork card={c} />
                        <span>
                          <strong>{c.name}</strong>
                          <small>
                            {c.number} · {c.finish}
                          </small>
                        </span>
                        <span className="cp-row-home">
                          {leaves
                            .filter((l) => count(c.id, l.id))
                            .map((l) => l.name)
                            .join(" · ")}
                        </span>
                        <b>×{count(c.id)}</b>
                      </button>
                    ))}
                  </div>
                )}
                {!visible.length && (
                  <p className="cp-empty">
                    No owned editions match these filters.
                  </p>
                )}
              </>
            )}
            <div className="cp-feedback" role="status">
              <span>✓ {message}</span>
              <button disabled={!activeMoves.length} onClick={undo}>
                Undo{activeMoves.length ? ` (${activeMoves.length})` : ""}
              </button>
            </div>
            <details className="cp-state">
              <summary>Prototype notes & current selection</summary>
              <p>
                Exploring where destination and inspection belong. Collection is
                an aggregate; sources and destinations are physical Storage
                Leaves. Moves preserve Edition identity and total quantity. Undo
                retains the newest five moves for ten minutes. Sample Decks are
                intentionally incomplete. No location ordering is proposed.
              </p>
              <pre>
                {JSON.stringify(
                  {
                    variant,
                    selectedEdition: selected,
                    source,
                    destination,
                    quantity,
                    copySource,
                    selectedCopies: copySelection.length,
                    selectedEditionCounts: selectionItems,
                    holdings: inventory,
                    undoMoves: activeMoves,
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          </div>
          <aside className="cp-detail">{details}</aside>
        </div>
      </div>
      {drawer && (
        <div className="cp-drawer-backdrop" onClick={() => setDrawer(null)}>
          <section
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label={drawer === "nav" ? "Locations" : "Card inspection"}
            className={`cp-drawer cp-drawer-${drawer}`}
            onClick={(e) => e.stopPropagation()}
          >
            {drawer === "nav" ? (
              <>
                <button className="cp-close" onClick={() => setDrawer(null)}>
                  Close locations
                </button>
                {navigation}
              </>
            ) : (
              <>
                {details}
                <div className="cp-feedback" role="status">
                  <span>✓ {message}</span>
                  <button disabled={!activeMoves.length} onClick={undo}>
                    Undo{activeMoves.length ? ` (${activeMoves.length})` : ""}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <nav
        className="cp-switcher"
        aria-label="Prototype variants"
        inert={!!drawer}
      >
        <button aria-label="Previous variant" onClick={() => cycle(-1)}>
          ←
        </button>
        <span>
          <b>{variant}</b> {names[variant]}
        </span>
        <button aria-label="Next variant" onClick={() => cycle(1)}>
          →
        </button>
      </nav>
    </div>
  );
}

export default function CollectorWorkspace() {
  return readVariant() === "A" ? <MinimalWorkspace /> : <HistoricalWorkspace />;
}
