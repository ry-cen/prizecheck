// Throwaway refinement of owner-confirmed Variant A. Only display preferences persist.
import { useEffect, useRef, useState } from "react";
import "./minimal.css";

type Edition = {
  id: string;
  name: string;
  set: string;
  number: number;
  category: string;
  type: string;
  art: string;
};
const editions: Edition[] = [
  {
    id: "charizard",
    name: "Charizard ex",
    set: "Pokémon 151",
    number: 199,
    category: "Pokémon",
    type: "Fire",
    art: "sv03.5/199",
  },
  {
    id: "venusaur",
    name: "Venusaur ex",
    set: "Pokémon 151",
    number: 198,
    category: "Pokémon",
    type: "Grass",
    art: "sv03.5/198",
  },
  {
    id: "blastoise",
    name: "Blastoise ex",
    set: "Pokémon 151",
    number: 200,
    category: "Pokémon",
    type: "Water",
    art: "sv03.5/200",
  },
  {
    id: "pikachu",
    name: "Pikachu",
    set: "Pokémon 151",
    number: 173,
    category: "Pokémon",
    type: "Lightning",
    art: "sv03.5/173",
  },
  {
    id: "mew",
    name: "Mew ex",
    set: "Pokémon 151",
    number: 151,
    category: "Pokémon",
    type: "Psychic",
    art: "sv03.5/151",
  },
  {
    id: "alakazam",
    name: "Alakazam ex",
    set: "Pokémon 151",
    number: 201,
    category: "Pokémon",
    type: "Psychic",
    art: "sv03.5/201",
  },
  {
    id: "gengar",
    name: "Gengar",
    set: "Pokémon 151",
    number: 94,
    category: "Pokémon",
    type: "Psychic",
    art: "sv03.5/094",
  },
  {
    id: "dragonair",
    name: "Dragonair",
    set: "Pokémon 151",
    number: 181,
    category: "Pokémon",
    type: "Dragon",
    art: "sv03.5/181",
  },
  {
    id: "iono",
    name: "Iono",
    set: "Paldea Evolved",
    number: 185,
    category: "Trainer",
    type: "",
    art: "sv02/185",
  },
  {
    id: "energy",
    name: "Basic Fire Energy",
    set: "Obsidian Flames",
    number: 230,
    category: "Energy",
    type: "Fire",
    art: "sv03/230",
  },
];
type ManageMode =
  | { kind: "list" }
  | { kind: "rename"; id: string }
  | { kind: "move"; id: string; target?: string | null }
  | { kind: "delete"; id: string };
type SampleLocation = {
  id: string;
  name: string;
  parent: string | null;
  deck?: boolean;
};
const initialLocations = (): SampleLocation[] => [
  { id: "storage", name: "Storage", parent: null },
  { id: "decks", name: "Decks", parent: null },
  { id: "binder", name: "151 display binder", parent: "storage" },
  { id: "box", name: "Trade box", parent: "storage" },
  { id: "bulk2", name: "Bulk box 2", parent: "storage" },
  { id: "bulk10", name: "Bulk box 10", parent: "storage" },
  { id: "deck", name: "Crimson flight", parent: "decks", deck: true },
  { id: "psychic", name: "Psychic current", parent: "decks", deck: true },
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
  box: { charizard: 1, pikachu: 3, gengar: 2, mew: 1, iono: 3, energy: 4 },
  deck: { charizard: 1, dragonair: 1, energy: 3 },
  psychic: { mew: 1, alakazam: 1, iono: 1 },
});
type Tile = { key: string; source: string; edition: Edition; ordinal: number };
type Item = { source: string; id: string; quantity: number };
type Operation = { items: Item[]; destination: string | null; expires: number };
type Prefs = {
  filters: boolean;
  sort: string;
  size: string;
  names: boolean;
  set: string;
  category: string;
  element: string;
};
const preferenceKey = "tcg-prototype:collector-workspace:preferences:v1";
const sortValues = [
  "name-asc",
  "name-desc",
  "set-asc",
  "set-desc",
  "quantity-asc",
  "quantity-desc",
];
function preferences(): Prefs {
  const fallback = {
    filters: false,
    sort: "name-asc",
    size: "small",
    names: false,
    set: "",
    category: "",
    element: "",
  };
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  try {
    const p = JSON.parse(localStorage.getItem(preferenceKey) || "null");
    return p
      ? {
          filters: typeof p.filters === "boolean" ? p.filters : false,
          sort: sortValues.includes(p.sort) ? p.sort : "name-asc",
          size: ["small", "medium"].includes(p.size) ? p.size : "small",
          names: typeof p.names === "boolean" ? p.names : false,
          set: text(p.set),
          category: text(p.category),
          element: text(p.element),
        }
      : fallback;
  } catch {
    return fallback;
  }
}
function Art({ edition }: { edition: Edition }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [edition.id]);
  return (
    <div className="mw-art">
      {failed ? (
        <span>
          {edition.name}
          <small>
            {edition.set} · {edition.number}
          </small>
        </span>
      ) : (
        <img
          draggable={false}
          loading="lazy"
          src={`https://assets.tcgdex.net/en/sv/${edition.art}/high.webp`}
          alt={`${edition.name} card artwork`}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
export default function MinimalWorkspace() {
  const [locations, setLocations] = useState(initialLocations);
  // Siblings sort naturally A–Z ("Binder 2" before "Binder 10"); there is no stored order.
  const children = (id: string | null) =>
    locations
      .filter((l) => l.parent === id)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, {
          numeric: true,
          sensitivity: "base",
        })
      );
  const leaves = locations.filter((l) => !children(l.id).length);
  const path = (id: string): string => {
    const location = locations.find((l) => l.id === id);
    return location
      ? `${location.parent ? `${path(location.parent)} / ` : ""}${location.name}`
      : "Unknown location";
  };
  const depth = (id: string): number => {
    const parent = locations.find((l) => l.id === id)?.parent;
    return parent ? depth(parent) + 1 : 1;
  };
  const [inventory, setInventory] = useState(initial);
  const inventoryRef = useRef(inventory);
  const [prefs, setPrefs] = useState(preferences);
  const [view, setView] = useState("all");
  const [query, setQuery] = useState("");
  const [setFilter, setSetFilter] = useState(prefs.set);
  const [category, setCategory] = useState(prefs.category);
  const [element, setElement] = useState(prefs.element);
  const [selection, setSelection] = useState<string[]>([]);
  const selectionRef = useRef<string[]>([]);
  const anchor = useRef<string | null>(null);
  const [preview, setPreview] = useState<Tile | null>(null);
  const [hover, setHover] = useState<Tile | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [dialog, setDialog] = useState<
    | "move"
    | "remove"
    | "detail"
    | "nav"
    | "filters"
    | "create"
    | "manage"
    | null
  >(null);
  const [createParent, setCreateParent] = useState<string | null>(null);
  const [locationName, setLocationName] = useState("");
  const [conversion, setConversion] = useState("");
  const [createError, setCreateError] = useState("");
  const [createFromManage, setCreateFromManage] = useState(false);
  const [manage, setManage] = useState<ManageMode>({ kind: "list" });
  const [manageName, setManageName] = useState("");
  const [manageError, setManageError] = useState("");
  const draggedLocation = useRef<string | null>(null);
  const [manageDropHover, setManageDropHover] = useState<string | null>(null);
  const [draggingLocation, setDraggingLocation] = useState(false);
  const [actions, setActions] = useState(false);
  const [destination, setDestination] = useState("");
  const [destinationQuery, setDestinationQuery] = useState("");
  const [expanded, setExpanded] = useState<string[]>(["storage", "decks"]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [now, setNow] = useState(Date.now());
  const [message, setMessage] = useState("");
  const [dragging, setDragging] = useState(false);
  const [dropHover, setDropHover] = useState("");
  const dragItems = useRef<Item[]>([]);
  const grid = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const mobileNavRef = useRef<HTMLButtonElement>(null);
  const marquee = useRef<{ x: number; y: number; base: string[] } | null>(null);
  const [rectangle, setRectangle] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const allTiles: Tile[] = editions.flatMap((edition) =>
    leaves.flatMap((leaf) =>
      Array.from(
        { length: inventory[leaf.id]?.[edition.id] || 0 },
        (_, ordinal) => ({
          key: `${leaf.id}:${edition.id}:${ordinal}`,
          source: leaf.id,
          edition,
          ordinal,
        })
      )
    )
  );
  const sourceTiles = allTiles.filter(
    (t) => view === "all" || t.source === view
  );
  const visibleEditions = editions.filter(
    (e) =>
      sourceTiles.some((t) => t.edition.id === e.id) &&
      `${e.name} ${e.set} ${e.number}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!setFilter || e.set === setFilter) &&
      (!category || e.category === category) &&
      (!element || e.type === element)
  );
  const totalEdition = (id: string) =>
    sourceTiles.filter((t) => t.edition.id === id).length;
  visibleEditions.sort((a, b) => {
    const comparison = prefs.sort.startsWith("quantity")
      ? totalEdition(a.id) - totalEdition(b.id)
      : prefs.sort.startsWith("set")
        ? a.set.localeCompare(b.set) || a.number - b.number
        : a.name.localeCompare(b.name);
    return (
      comparison * (prefs.sort.endsWith("desc") ? -1 : 1) ||
      a.id.localeCompare(b.id)
    );
  });
  const tiles = visibleEditions.flatMap((e) =>
    sourceTiles
      .filter((t) => t.edition.id === e.id)
      .sort(
        (a, b) =>
          path(a.source).localeCompare(path(b.source)) || a.ordinal - b.ordinal
      )
  );
  const grouped = (keys = selectionRef.current): Item[] => {
    const result: Item[] = [];
    keys.forEach((key) => {
      const [source, id] = key.split(":");
      const existing = result.find((i) => i.source === source && i.id === id);
      if (existing) existing.quantity++;
      else result.push({ source, id, quantity: 1 });
    });
    return result;
  };
  function updateSelection(keys: string[], inspected?: Tile) {
    selectionRef.current = keys;
    setSelection(keys);
    if (!keys.length) {
      setPreview(null);
      setHover(null);
      setActions(false);
    } else
      setPreview((previous) =>
        inspected && keys.includes(inspected.key)
          ? inspected
          : previous && keys.includes(previous.key)
            ? previous
            : allTiles.find((t) => t.key === keys[keys.length - 1]) || null
      );
  }
  function clear() {
    updateSelection([]);
    anchor.current = null;
  }
  useEffect(() => {
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ ...prefs, set: setFilter, category, element })
      );
    } catch {
      /* Preferences remain available in memory. */
    }
  }, [prefs, setFilter, category, element]);
  useEffect(() => {
    clear();
  }, [query, setFilter, category, element, view]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (dialog) setDialog(null);
        else {
          clear();
          setActions(false);
        }
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      clearInterval(timer);
      window.removeEventListener("keydown", escape);
    };
  }, [dialog]);
  useEffect(() => {
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const elements = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input,select,[tabindex='0']"
        ) || []
      );
    (
      dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]") ||
      elements()[0]
    )?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const entries = elements();
      const first = entries[0];
      const last = entries[entries.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialogRef.current?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", trap);
    return () => {
      window.removeEventListener("keydown", trap);
      document.body.style.overflow = previousOverflow;
      const usable = (node: HTMLElement | null) =>
        !!node &&
        node !== document.body &&
        node.isConnected &&
        node.getClientRects().length > 0 &&
        !node.closest("[inert]");
      if (usable(opener)) opener.focus();
      else if (usable(mobileNavRef.current)) mobileNavRef.current?.focus();
    };
  }, [dialog]);
  function choose(
    tile: Tile,
    event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
    toggle = false
  ) {
    const current = selectionRef.current;
    if (
      event.shiftKey &&
      anchor.current &&
      tiles.some((t) => t.key === anchor.current)
    ) {
      const a = tiles.findIndex((t) => t.key === anchor.current);
      const b = tiles.findIndex((t) => t.key === tile.key);
      const range = tiles
        .slice(Math.min(a, b), Math.max(a, b) + 1)
        .map((t) => t.key);
      updateSelection(
        event.ctrlKey || event.metaKey
          ? [...new Set([...current, ...range])]
          : range,
        tile
      );
    } else {
      updateSelection(
        toggle || event.ctrlKey || event.metaKey || selectMode
          ? current.includes(tile.key)
            ? current.filter((k) => k !== tile.key)
            : [...current, tile.key]
          : current.length === 1 && current[0] === tile.key
            ? []
            : [tile.key],
        tile
      );
      anchor.current = tile.key;
    }
  }
  const activeOperations = operations.filter((o) => o.expires > now);
  function mutate(items: Item[], to: string | null) {
    const current = inventoryRef.current;
    if (to && !leaves.some((l) => l.id === to)) {
      setMessage("Choose a storage destination.");
      return;
    }
    const invalid = items.find(
      (i) =>
        !current[i.source] ||
        !Number.isInteger(i.quantity) ||
        i.quantity < 1 ||
        (current[i.source][i.id] || 0) < i.quantity
    );
    if (invalid) {
      setMessage(
        `Not enough ${editions.find((e) => e.id === invalid.id)?.name || "copies"} in ${path(invalid.source)}. Nothing changed.`
      );
      return;
    }
    const changes = items.filter((i) => i.source !== to);
    if (!changes.length) {
      setMessage("All selected copies are already here.");
      return;
    }
    const next = Object.fromEntries(
      Object.entries(current).map(([source, holdings]) => [
        source,
        { ...holdings },
      ])
    );
    changes.forEach((i) => {
      next[i.source][i.id] -= i.quantity;
      if (to) next[to][i.id] = (next[to][i.id] || 0) + i.quantity;
    });
    inventoryRef.current = next;
    setInventory(next);
    setOperations(
      [
        { items: changes, destination: to, expires: Date.now() + 600000 },
        ...activeOperations,
      ].slice(0, 5)
    );
    clear();
    setDialog(null);
    setMessage(
      `${to ? "Moved" : "Removed"} ${plural(
        changes.reduce((n, i) => n + i.quantity, 0),
        "copy",
        "copies"
      )}${to ? ` to ${path(to)}` : " from your collection"}.`
    );
  }
  const latest = activeOperations[0];
  const undoNeeded: Record<string, number> = {};
  latest?.items.forEach((i) => {
    undoNeeded[i.id] = (undoNeeded[i.id] || 0) + i.quantity;
  });
  const undoInvalid =
    !!latest &&
    (latest.items.some((i) => !leaves.some((l) => l.id === i.source)) ||
      (!!latest.destination &&
        (!leaves.some((l) => l.id === latest.destination) ||
          Object.entries(undoNeeded).some(
            ([id, amount]) =>
              (inventory[latest.destination!]?.[id] || 0) < amount
          ))));
  function undo() {
    if (!latest || undoInvalid) {
      setMessage(
        "This operation no longer matches the current storage locations or quantities. Nothing changed; dismiss this Undo to reach earlier operations."
      );
      return;
    }
    const next = Object.fromEntries(
      Object.entries(inventoryRef.current).map(([source, holdings]) => [
        source,
        { ...holdings },
      ])
    );
    latest.items.forEach((i) => {
      if (latest.destination) next[latest.destination][i.id] -= i.quantity;
      next[i.source][i.id] = (next[i.source][i.id] || 0) + i.quantity;
    });
    inventoryRef.current = next;
    setInventory(next);
    setOperations(activeOperations.slice(1));
    clear();
    setMessage("Restored all copies to their original locations.");
  }
  const movingCount = grouped()
    .filter((i) => i.source !== destination)
    .reduce((n, i) => n + i.quantity, 0);
  const total = (source: string) =>
    Object.values(inventory[source] || {}).reduce((a, b) => a + b, 0);
  function dropProps(id: string) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (dragItems.current.some((i) => i.source !== id)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setDropHover(id);
        }
      },
      onDragLeave: () => setDropHover(""),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        mutate(dragItems.current, id);
        dragItems.current = [];
        setDragging(false);
        setDropHover("");
      },
    };
  }
  const toggleFolder = (id: string) =>
    setExpanded((current) =>
      current.includes(id) ? current.filter((f) => f !== id) : [...current, id]
    );
  function openCreate(parent: string | null, fromManage = false) {
    setCreateFromManage(fromManage);
    setCreateParent(parent);
    setLocationName("");
    setConversion("");
    setCreateError("");
    setDialog("create");
  }
  function createLocation() {
    const name = locationName.trim();
    const parent = locations.find((l) => l.id === createParent);
    if (!name || name.length > 120 || /[\x00-\x1f]/.test(name)) {
      setCreateError("Enter a location name of 1–120 characters.");
      return;
    }
    if (createParent && (!parent || parent.deck)) {
      setCreateError("Choose a location that can contain children.");
      return;
    }
    if (createParent && depth(createParent) >= 12) {
      setCreateError("Locations can be nested at most 12 levels deep.");
      return;
    }
    const siblings = children(createParent);
    if (
      siblings.some((l) => l.name.trim().toLowerCase() === name.toLowerCase())
    ) {
      setCreateError(
        "A location with that name already exists under this parent."
      );
      return;
    }
    const stocked = !!createParent && total(createParent) > 0;
    if (stocked && !["named", "unsorted"].includes(conversion)) {
      setCreateError("Choose where to keep the existing cards.");
      return;
    }
    if (
      stocked &&
      conversion === "unsorted" &&
      (name.toLowerCase() === "unsorted" ||
        siblings.some((l) => l.name.trim().toLowerCase() === "unsorted"))
    ) {
      setCreateError(
        "The separate Unsorted child needs a unique name. Use another name for the new location or move cards directly into it."
      );
      return;
    }
    const id = crypto.randomUUID();
    const added: SampleLocation[] = [{ id, name, parent: createParent }];
    const next = Object.fromEntries(
      Object.entries(inventoryRef.current).map(([source, holdings]) => [
        source,
        { ...holdings },
      ])
    );
    next[id] = {};
    if (stocked && createParent) {
      const storageId = conversion === "named" ? id : crypto.randomUUID();
      if (conversion === "unsorted")
        added.push({ id: storageId, name: "Unsorted", parent: createParent });
      next[storageId] = { ...next[createParent] };
      next[createParent] = {};
    }
    // Validate before either tree or inventory changes; conversion is one sample transaction.
    setLocations([...locations, ...added]);
    inventoryRef.current = next;
    setInventory(next);
    const ancestors: string[] = [];
    let ancestor = createParent;
    while (ancestor) {
      ancestors.push(ancestor);
      ancestor = locations.find((l) => l.id === ancestor)?.parent || null;
    }
    setExpanded((current) => [...new Set([...current, ...ancestors])]);
    clear();
    setView(id);
    setDialog(createFromManage ? "manage" : null);
    setMessage(`Created ${name}.`);
  }
  const validName = (name: string) =>
    !!name && name.length <= 120 && !/[\x00-\x1f]/.test(name);
  const nameTaken = (name: string, parent: string | null, except?: string) =>
    children(parent).some(
      (l) =>
        l.id !== except && l.name.trim().toLowerCase() === name.toLowerCase()
    );
  const subtree = (id: string): string[] => [
    id,
    ...children(id).flatMap((c) => subtree(c.id)),
  ];
  // Valid new parents for a Location: never itself, a descendant, a Deck, its
  // current parent, or a parent that would push the subtree past 12 levels.
  const parentTargets = (id: string): (string | null)[] => {
    const moving = locations.find((l) => l.id === id);
    if (!moving) return [];
    const branch = subtree(id);
    const height = Math.max(...branch.map((b) => depth(b) - depth(id) + 1));
    const candidates: (string | null)[] = [
      null,
      ...locations
        .filter((l) => !l.deck && !branch.includes(l.id))
        .map((l) => l.id),
    ];
    return candidates
      .filter((c) => c !== moving.parent && (c ? depth(c) : 0) + height <= 12)
      .sort((a, b) =>
        a === null
          ? -1
          : b === null
            ? 1
            : path(a).localeCompare(path(b), undefined, {
                numeric: true,
                sensitivity: "base",
              })
      );
  };
  function openManage() {
    setManage({ kind: "list" });
    setManageError("");
    setDialog("manage");
  }
  function startManage(mode: ManageMode) {
    setManageError("");
    setManageName(
      mode.kind === "rename"
        ? locations.find((l) => l.id === mode.id)?.name || ""
        : ""
    );
    setManage(mode);
  }
  function renameLocation(id: string) {
    const location = locations.find((l) => l.id === id);
    const name = manageName.trim();
    if (!location) return;
    if (!validName(name)) {
      setManageError("Enter a location name of 1–120 characters.");
      return;
    }
    if (nameTaken(name, location.parent, id)) {
      setManageError(
        "A location with that name already exists under this parent."
      );
      return;
    }
    setLocations(locations.map((l) => (l.id === id ? { ...l, name } : l)));
    setManage({ kind: "list" });
    setMessage(`Renamed ${location.name} to ${name}.`);
  }
  function reparentLocation(id: string, target: string | null) {
    const location = locations.find((l) => l.id === id);
    if (!location || !parentTargets(id).includes(target)) {
      setManageError("That location can't be moved there.");
      return;
    }
    if (nameTaken(location.name, target)) {
      setManageError(
        `${target ? path(target) : "Top level"} already has a location named ${location.name}.`
      );
      return;
    }
    const stocked = !!target && total(target) > 0;
    if (stocked && location.name.trim().toLowerCase() === "unsorted") {
      setManageError(
        "The destination's cards go to a new Unsorted child, so rename this location first."
      );
      return;
    }
    const next = Object.fromEntries(
      Object.entries(inventoryRef.current).map(([source, holdings]) => [
        source,
        { ...holdings },
      ])
    );
    let moved = locations.map((l) =>
      l.id === id ? { ...l, parent: target } : l
    );
    if (stocked && target) {
      // A stocked leaf becomes a folder, so its cards move to a new Unsorted child in the same step.
      const unsorted = crypto.randomUUID();
      moved = [...moved, { id: unsorted, name: "Unsorted", parent: target }];
      next[unsorted] = { ...next[target] };
      next[target] = {};
      if (view === target) setView(unsorted);
    }
    setLocations(moved);
    inventoryRef.current = next;
    setInventory(next);
    const ancestors: string[] = [];
    for (
      let a: string | null = target;
      a;
      a = locations.find((l) => l.id === a)?.parent || null
    )
      ancestors.push(a);
    setExpanded((current) => [...new Set([...current, ...ancestors])]);
    setManage({ kind: "list" });
    setMessage(
      `Moved ${location.name} to ${target ? path(target) : "Top level"}.`
    );
  }
  function deleteLocation(id: string) {
    const location = locations.find((l) => l.id === id);
    if (!location) return;
    if (children(id).length || total(id) > 0) {
      setManageError("Only an empty location with no children can be deleted.");
      return;
    }
    if (manageName.trim() !== location.name) {
      setManageError(`Type ${location.name} to confirm.`);
      return;
    }
    setLocations(locations.filter((l) => l.id !== id));
    const next = { ...inventoryRef.current };
    delete next[id];
    inventoryRef.current = next;
    setInventory(next);
    if (view === id) setView("all");
    setManage({ kind: "list" });
    setMessage(`Deleted ${location.name}.`);
  }
  const navigation = (picker = false) => {
    const matching = leaves.filter(
      (l) =>
        !picker ||
        path(l.id).toLowerCase().includes(destinationQuery.toLowerCase())
    );
    const containsMatch = (node: SampleLocation): boolean =>
      matching.some(
        (l) => l.id === node.id || path(l.id).startsWith(`${path(node.id)} / `)
      );
    const renderNode = (
      location: SampleLocation,
      level: number
    ): React.ReactNode => {
      const nested = children(location.id);
      const folder = nested.length > 0;
      if (picker && !containsMatch(location)) return null;
      const opened =
        expanded.includes(location.id) || (picker && !!destinationQuery);
      return (
        <div key={location.id}>
          <div className="mw-location-row" style={{ paddingLeft: level * 12 }}>
            <button
              title={path(location.id)}
              className={`${folder ? "mw-folder" : "mw-leaf"} ${!folder && (picker ? destination === location.id : view === location.id) ? "active" : ""} ${!folder && dragging && dragItems.current.some((i) => i.source !== location.id) ? "mw-drop-valid" : ""} ${dropHover === location.id ? "mw-drop-hover" : ""}`}
              {...(!folder && !picker ? dropProps(location.id) : {})}
              aria-expanded={folder ? opened : undefined}
              aria-pressed={
                folder
                  ? undefined
                  : picker
                    ? destination === location.id
                    : view === location.id
              }
              onClick={() => {
                if (folder) toggleFolder(location.id);
                else if (picker) setDestination(location.id);
                else {
                  setView(location.id);
                  setDialog(null);
                }
              }}
            >
              <span className="mw-tree-chevron" aria-hidden="true">
                {folder ? (opened ? "⌄" : "›") : ""}
              </span>
              <span title={location.name}>{location.name}</span>
              {!folder && <small>{total(location.id)}</small>}
            </button>
            {!picker && !location.deck && (
              <button
                className="mw-add-child"
                aria-label={`Add child location to ${path(location.id)}`}
                title="Add child location"
                onClick={() => openCreate(location.id)}
              >
                +
              </button>
            )}
          </div>
          {folder &&
            opened &&
            nested.map((child) => renderNode(child, level + 1))}
        </div>
      );
    };
    return (
      <nav
        aria-label={picker ? "Move destinations" : "Storage locations"}
        className="mw-tree"
      >
        {!picker && (
          <button
            className={view === "all" ? "active" : ""}
            onClick={() => {
              setView("all");
              setDialog(null);
            }}
          >
            <span>All owned</span>
            <small>{allTiles.length}</small>
          </button>
        )}
        {children(null).map((location) => renderNode(location, 0))}
        {picker && !matching.length && <p>No matching storage locations.</p>}
      </nav>
    );
  };
  const filters = (
    <div className="mw-filter-controls">
      {[
        {
          label: "Set",
          value: setFilter,
          setter: setSetFilter,
          values: [...new Set(editions.map((e) => e.set))],
        },
        {
          label: "Category",
          value: category,
          setter: setCategory,
          values: ["Pokémon", "Trainer", "Energy"],
        },
        {
          label: "Elemental type",
          value: element,
          setter: setElement,
          values: [...new Set(editions.map((e) => e.type).filter(Boolean))],
        },
      ].map((f) => (
        <label key={f.label}>
          {f.label}
          <select value={f.value} onChange={(e) => f.setter(e.target.value)}>
            <option value="">All</option>
            {f.values.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      ))}
      <button
        onClick={() => {
          setSetFilter("");
          setCategory("");
          setElement("");
        }}
      >
        Clear filters
      </button>
    </div>
  );
  const displayControls = (
    <>
      <label className="mw-display-field">
        <span>Sort</span>
        <select
          aria-label="Sort cards"
          value={prefs.sort}
          onChange={(e) => setPrefs({ ...prefs, sort: e.target.value })}
        >
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="set-asc">Set / number ↑</option>
          <option value="set-desc">Set / number ↓</option>
          <option value="quantity-desc">Quantity ↓</option>
          <option value="quantity-asc">Quantity ↑</option>
        </select>
      </label>
      <label className="mw-display-field">
        <span>Card size</span>
        <select
          aria-label="Card size"
          value={prefs.size}
          onChange={(e) => setPrefs({ ...prefs, size: e.target.value })}
        >
          <option value="small">Small</option>
          <option value="medium">Medium</option>
        </select>
      </label>
      <button
        aria-pressed={prefs.names}
        onClick={() => setPrefs({ ...prefs, names: !prefs.names })}
      >
        Names
      </button>
    </>
  );
  const locationHeading = (label = true) => (
    <div className="mw-location-heading">
      {label && <span className="mw-section-label">LOCATIONS</span>}
      <span className="mw-location-tools">
        <button
          aria-label="Add location"
          title="Add top-level location"
          onClick={() => openCreate(null)}
        >
          +
        </button>
        <button
          aria-label="Manage locations"
          title="Manage locations"
          onClick={openManage}
        >
          ⚙
        </button>
      </span>
    </div>
  );
  const kindLabel = (l: SampleLocation) =>
    l.deck
      ? `Deck · ${plural(total(l.id), "copy", "copies")}`
      : children(l.id).length
        ? "Folder"
        : plural(total(l.id), "copy", "copies");
  const manageTarget = manage.kind === "move" ? manage.target : undefined;
  const managed =
    manage.kind === "list"
      ? undefined
      : locations.find((l) => l.id === manage.id);
  const locationDragProps = (target: string | null) => ({
    onDragOver: (e: React.DragEvent) => {
      const id = draggedLocation.current;
      if (id && parentTargets(id).includes(target)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setManageDropHover(target ?? "top");
      }
    },
    onDragLeave: () => setManageDropHover(null),
    onDrop: (e: React.DragEvent) => {
      const id = draggedLocation.current;
      e.preventDefault();
      setManageDropHover(null);
      if (id && parentTargets(id).includes(target)) {
        setManageError("");
        setManage({ kind: "move", id, target });
      }
    },
  });
  const dropTargetClass = (target: string | null) =>
    draggingLocation && draggedLocation.current
      ? parentTargets(draggedLocation.current).includes(target)
        ? manageDropHover === (target ?? "top")
          ? "mw-drop-hover"
          : "mw-drop-valid"
        : "mw-drop-invalid"
      : "";
  const manageRows = (parent: string | null, level: number): React.ReactNode =>
    children(parent).map((l) => (
      <li key={l.id}>
        <div
          className={`mw-manage-row ${dropTargetClass(l.id)}`}
          draggable
          onDragStart={(e) => {
            draggedLocation.current = l.id;
            setDraggingLocation(true);
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("application/x-location", l.id);
          }}
          onDragEnd={() => {
            draggedLocation.current = null;
            setDraggingLocation(false);
            setManageDropHover(null);
          }}
          {...locationDragProps(l.id)}
          style={{ paddingLeft: 10 + level * 16 }}
        >
          <span className="mw-manage-name">
            <span title={path(l.id)}>{l.name}</span>
            <small>{kindLabel(l)}</small>
          </span>
          <span className="mw-manage-actions">
            <button
              onClick={() => startManage({ kind: "rename", id: l.id })}
              aria-label={`Rename ${path(l.id)}`}
            >
              Rename
            </button>
            <button
              onClick={() => startManage({ kind: "move", id: l.id })}
              aria-label={`Move ${path(l.id)}`}
            >
              Move
            </button>
            {l.deck ? (
              // Decks can't have children; the spacer keeps action columns aligned.
              <span className="mw-manage-spacer" aria-hidden="true">
                Add child
              </span>
            ) : (
              <button
                onClick={() => openCreate(l.id, true)}
                aria-label={`Add child location to ${path(l.id)}`}
              >
                Add child
              </button>
            )}
            <button
              disabled={children(l.id).length > 0 || total(l.id) > 0}
              title={
                children(l.id).length || total(l.id)
                  ? "Only an empty location with no children can be deleted"
                  : undefined
              }
              onClick={() => startManage({ kind: "delete", id: l.id })}
              aria-label={`Delete ${path(l.id)}`}
            >
              Delete
            </button>
          </span>
        </div>
        {children(l.id).length > 0 && <ul>{manageRows(l.id, level + 1)}</ul>}
      </li>
    ));
  const managePanel = (
    <div className="mw-manage">
      {manage.kind === "list" && (
        <>
          <p className="mw-manage-hint">
            <span className="mw-desktop">
              Drag a location onto another to nest it, or onto Top level. Every
              move asks you to confirm.
            </span>
            <span className="mw-mobile">
              Use Move to nest a location or bring it to the top level.
            </span>
          </p>
          <div
            className={`mw-manage-top mw-desktop ${dropTargetClass(null)}`}
            {...locationDragProps(null)}
          >
            Top level
          </div>
          <ul className="mw-manage-tree">{manageRows(null, 0)}</ul>
          <button className="mw-primary" onClick={() => openCreate(null, true)}>
            Add top-level location
          </button>
        </>
      )}
      {manage.kind === "rename" && managed && (
        <form
          className="mw-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            renameLocation(managed.id);
          }}
        >
          <p>{path(managed.id)}</p>
          <label>
            New name
            <input
              data-autofocus
              value={manageName}
              onChange={(e) => setManageName(e.target.value)}
            />
          </label>
          <div className="mw-create-actions">
            <button className="mw-primary">Save name</button>
            <button type="button" onClick={() => startManage({ kind: "list" })}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {manage.kind === "move" && managed && (
        <div className="mw-create-form">
          <p>
            Move <strong>{path(managed.id)}</strong>
            {children(managed.id).length > 0 &&
              ` and its ${plural(subtree(managed.id).length - 1, "nested location", "nested locations")}`}
          </p>
          {manageTarget === undefined ? (
            <ul className="mw-manage-targets" aria-label="New parent">
              {parentTargets(managed.id).map((t) => (
                <li key={t ?? "top"}>
                  <button onClick={() => setManage({ ...manage, target: t })}>
                    {t ? path(t) : "Top level"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mw-move-summary">
              <p>
                New path:{" "}
                <strong>
                  {manageTarget ? `${path(manageTarget)} / ` : ""}
                  {managed.name}
                </strong>
              </p>
              {manageTarget && total(manageTarget) > 0 && (
                <p className="mw-manage-warning">
                  {locations.find((l) => l.id === manageTarget)?.name} holds{" "}
                  {plural(total(manageTarget), "copy", "copies")}. They move
                  into a new Unsorted child so that every card stays in a
                  storage location.
                </p>
              )}
              <div className="mw-create-actions">
                <button
                  className="mw-primary"
                  data-autofocus
                  onClick={() => reparentLocation(managed.id, manageTarget)}
                >
                  Move here
                </button>
                <button
                  onClick={() => setManage({ kind: "move", id: managed.id })}
                >
                  Choose another
                </button>
              </div>
            </div>
          )}
          <button onClick={() => startManage({ kind: "list" })}>Cancel</button>
        </div>
      )}
      {manage.kind === "delete" && managed && (
        <form
          className="mw-create-form"
          onSubmit={(e) => {
            e.preventDefault();
            deleteLocation(managed.id);
          }}
        >
          <p>
            Delete <strong>{path(managed.id)}</strong>? It is empty and has no
            children.
          </p>
          <label>
            Type {managed.name} to confirm
            <input
              data-autofocus
              value={manageName}
              onChange={(e) => setManageName(e.target.value)}
            />
          </label>
          <div className="mw-create-actions">
            <button className="mw-danger">Delete location</button>
            <button type="button" onClick={() => startManage({ kind: "list" })}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {manageError && (
        <p className="mw-create-error" role="alert">
          {manageError}
        </p>
      )}
    </div>
  );
  const search = (className: string) => (
    <input
      className={className}
      aria-label="Search cards"
      placeholder="Search your cards…"
      value={query}
      onChange={(e) => setQuery(e.target.value)}
    />
  );
  const inspected = selection.length ? preview : hover || preview;
  const details = inspected && (
    <>
      <Art edition={inspected.edition} />
      <h2>{inspected.edition.name}</h2>
      <p>
        {inspected.edition.set} · {inspected.edition.number}
      </p>
      <p>
        {inspected.edition.category}
        {inspected.edition.type ? ` · ${inspected.edition.type}` : ""}
      </p>
      <div className="mw-detail-location">
        {path(inspected.source)}
        <small>
          {plural(
            inventory[inspected.source][inspected.edition.id] || 0,
            "copy",
            "copies"
          )}{" "}
          here ·{" "}
          {allTiles.filter((t) => t.edition.id === inspected.edition.id).length}{" "}
          owned
        </small>
      </div>
    </>
  );
  const openMove = () => {
    setDestination("");
    setDestinationQuery("");
    setDialog("move");
    setActions(false);
  };
  return (
    <div className="mw-root">
      <div className="mw-surface" inert={!!dialog}>
        <header className="mw-header">
          <button
            ref={mobileNavRef}
            className="mw-mobile mw-mobile-nav"
            onClick={() => setDialog("nav")}
            aria-label="Open locations"
          >
            ☰
          </button>
          {search("mw-mobile mw-mobile-search")}
          <button
            className="mw-mobile mw-mobile-settings"
            onClick={() => setDialog("filters")}
          >
            Filters &amp; display{setFilter || category || element ? " •" : ""}
          </button>
          <span className="mw-brand mw-desktop">
            ✦ <b>PRIZECHECK</b>
          </span>
          <small>Collection</small>
          <span className="mw-header-right mw-desktop">
            Sample prototype{" "}
            <button
              onClick={() => {
                const next = initial();
                inventoryRef.current = next;
                setInventory(next);
                setOperations([]);
                setLocations(initialLocations());
                setExpanded(["storage", "decks"]);
                setView("all");
                clear();
                setMessage("Sample collection reset.");
              }}
            >
              Reset
            </button>
          </span>
        </header>
        <div className="mw-layout">
          <aside className="mw-navigation">
            {locationHeading()}
            {navigation()}
          </aside>
          <main
            className="mw-main"
            onPointerDown={(e) => {
              // Any empty part of the gallery area starts a marquee; controls and panels don't.
              if (
                e.button !== 0 ||
                e.pointerType === "touch" ||
                !grid.current ||
                (e.target as HTMLElement).closest(
                  "button, input, select, textarea, label, a, .mw-heading, .mw-toolbar, .mw-filters, .mw-inspection, .mw-selection-bar, .mw-toast"
                )
              )
                return;
              const bounds = grid.current.getBoundingClientRect();
              const x = e.clientX - bounds.left;
              const y = e.clientY - bounds.top;
              const base =
                e.ctrlKey || e.metaKey ? [...selectionRef.current] : [];
              marquee.current = { x, y, base };
              updateSelection(base);
              setRectangle({ x, y, width: 0, height: 0 });
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              const start = marquee.current;
              if (!start || !grid.current) return;
              const bounds = grid.current.getBoundingClientRect();
              const x = e.clientX - bounds.left;
              const y = e.clientY - bounds.top;
              const box = {
                x: Math.min(start.x, x),
                y: Math.min(start.y, y),
                width: Math.abs(x - start.x),
                height: Math.abs(y - start.y),
              };
              setRectangle(box);
              const hits = Array.from(
                grid.current.querySelectorAll<HTMLElement>("[data-tile-key]")
              )
                .filter((node) => {
                  const rect = node.getBoundingClientRect();
                  return (
                    rect.left < bounds.left + box.x + box.width &&
                    rect.right > bounds.left + box.x &&
                    rect.top < bounds.top + box.y + box.height &&
                    rect.bottom > bounds.top + box.y
                  );
                })
                .map((node) => node.dataset.tileKey!);
              updateSelection([...new Set([...start.base, ...hits])]);
            }}
            onPointerUp={(e) => {
              marquee.current = null;
              setRectangle(null);
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              marquee.current = null;
              setRectangle(null);
            }}
          >
            <div className="mw-heading">
              <h1>
                {view === "all"
                  ? "All owned"
                  : leaves.find((l) => l.id === view)?.name}
              </h1>
              <span>
                {plural(tiles.length, "copy", "copies")} ·{" "}
                {plural(visibleEditions.length, "edition", "editions")}
              </span>
            </div>
            <div className="mw-toolbar">
              {search("mw-desktop")}
              <button
                className="mw-desktop"
                aria-pressed={prefs.filters}
                onClick={() => setPrefs({ ...prefs, filters: !prefs.filters })}
              >
                Filters{setFilter || category || element ? " •" : ""}
              </button>
              <div className="mw-display-controls mw-desktop">
                {displayControls}
              </div>
              <button
                className="mw-mobile"
                aria-pressed={selectMode}
                onClick={() => setSelectMode(!selectMode)}
              >
                Select
              </button>
            </div>
            {prefs.filters && (
              <section
                className="mw-filters mw-desktop"
                aria-label="Card filters"
              >
                {filters}
              </section>
            )}
            <div className="mw-gallery-layout">
              <div className="mw-gallery">
                <div
                  ref={grid}
                  className={`mw-grid mw-size-${prefs.size} ${selectMode ? "mw-select-mode" : ""}`}
                >
                  {tiles.map((tile) => (
                    <button
                      key={tile.key}
                      data-tile-key={tile.key}
                      className={`mw-tile ${selection.includes(tile.key) ? "mw-selected" : ""}`}
                      aria-pressed={selection.includes(tile.key)}
                      aria-label={`${tile.edition.name}, copy ${tile.ordinal + 1}, ${path(tile.source)}`}
                      title={`${tile.edition.name} · ${path(tile.source)}`}
                      draggable
                      onMouseEnter={() => {
                        if (!selectionRef.current.length) setHover(tile);
                      }}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => {
                        if (!selectionRef.current.length) setHover(tile);
                      }}
                      onBlur={() => setHover(null)}
                      onClick={(e) => {
                        if (
                          matchMedia("(pointer: coarse)").matches &&
                          !selectMode
                        ) {
                          setPreview(tile);
                          setDialog("detail");
                        } else choose(tile, e);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === " ") {
                          e.preventDefault();
                          choose(tile, e, true);
                        }
                      }}
                      onDragStart={(e) => {
                        if (!selectionRef.current.includes(tile.key))
                          updateSelection([tile.key], tile);
                        dragItems.current = grouped();
                        const counts = dragItems.current.reduce(
                          (n, i) => n + i.quantity,
                          0
                        );
                        const badge = document.createElement("div");
                        badge.className = "mw-drag-badge";
                        badge.textContent = `${plural(counts, "copy", "copies")} · ${plural(new Set(dragItems.current.map((i) => i.id)).size, "edition", "editions")}`;
                        document.body.append(badge);
                        e.dataTransfer.setDragImage(badge, 16, 16);
                        e.dataTransfer.setData(
                          "application/x-collector-move",
                          JSON.stringify(dragItems.current)
                        );
                        e.dataTransfer.effectAllowed = "move";
                        setDragging(true);
                        setTimeout(() => badge.remove(), 0);
                      }}
                      onDragEnd={() => {
                        dragItems.current = [];
                        setDragging(false);
                        setDropHover("");
                      }}
                    >
                      <Art edition={tile.edition} />
                      {prefs.names && (
                        <span className="mw-tile-name">
                          {tile.edition.name}
                        </span>
                      )}
                      {view === "all" && (
                        <small className="mw-tile-location">
                          {leaves.find((l) => l.id === tile.source)!.name}
                        </small>
                      )}
                      {selection.includes(tile.key) && (
                        <span className="mw-check" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  ))}
                  {!tiles.length && (
                    <p className="mw-empty">
                      No cards match these filters.
                      <button
                        onClick={() => {
                          setQuery("");
                          setSetFilter("");
                          setCategory("");
                          setElement("");
                        }}
                      >
                        Clear search and filters
                      </button>
                    </p>
                  )}
                  {rectangle && (
                    <div
                      className="mw-marquee"
                      style={{
                        left: rectangle.x,
                        top: rectangle.y,
                        width: rectangle.width,
                        height: rectangle.height,
                      }}
                    />
                  )}
                </div>
              </div>
              <aside className="mw-inspection" aria-label="Card inspection">
                {details}
              </aside>
            </div>
          </main>
        </div>
        {(selection.length > 0 || inspected) && (
          <div
            className={`mw-selection-bar ${selection.length ? "" : "mw-mobile"}`}
          >
            {selection.length > 0 ? (
              <>
                <strong>{selection.length} selected</strong>
                <span className="mw-selection-editions">
                  {plural(
                    new Set(grouped().map((i) => i.id)).size,
                    "edition",
                    "editions"
                  )}{" "}
                  ·{" "}
                  {plural(
                    new Set(grouped().map((i) => i.source)).size,
                    "location",
                    "locations"
                  )}
                </span>
              </>
            ) : (
              <strong className="mw-mobile">{inspected?.edition.name}</strong>
            )}
            {inspected && (
              <button className="mw-mobile" onClick={() => setDialog("detail")}>
                Details
              </button>
            )}
            {selection.length > 0 && (
              <div className="mw-actions">
                <button
                  aria-expanded={actions}
                  onClick={() => setActions(!actions)}
                >
                  Actions ▾
                </button>
                {actions && (
                  <div className="mw-action-menu">
                    <button onClick={openMove}>Move…</button>
                    <button
                      onClick={() => {
                        setDialog("remove");
                        setActions(false);
                      }}
                    >
                      Inventory Removal…
                    </button>
                    <button onClick={clear}>Clear selection</button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {(message || activeOperations.length > 0) && (
          <div className="mw-toast" role="status">
            <span>{message}</span>
            {latest && (
              <button onClick={undo} disabled={undoInvalid}>
                {undoInvalid
                  ? "Undo unavailable"
                  : `Undo (${activeOperations.length})`}
              </button>
            )}
            {latest && undoInvalid && (
              <button
                onClick={() => {
                  setOperations(activeOperations.slice(1));
                  setMessage("Dismissed unavailable Undo.");
                }}
              >
                Dismiss Undo
              </button>
            )}
          </div>
        )}
        <nav className="mw-prototype-bar" aria-label="Prototype variants">
          <a
            href="?prototype=collector&variant=C"
            aria-label="Previous variant"
          >
            ←
          </a>
          <small>A · Refined gallery</small>
          <a href="?prototype=collector&variant=B" aria-label="Next variant">
            →
          </a>
        </nav>
      </div>
      {dialog && (
        <div className="mw-backdrop" onClick={() => setDialog(null)}>
          <section
            className={`mw-dialog mw-dialog-${dialog}`}
            role="dialog"
            aria-modal="true"
            aria-label={
              dialog === "move"
                ? "Move selected copies"
                : dialog === "remove"
                  ? "Remove selected copies"
                  : dialog === "nav"
                    ? "Locations"
                    : dialog === "filters"
                      ? "Filters & display"
                      : dialog === "create"
                        ? "Add location"
                        : dialog === "manage"
                          ? "Manage locations"
                          : "Card details"
            }
            ref={dialogRef}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mw-dialog-heading">
              <h2>
                {dialog === "move"
                  ? "Move selected copies"
                  : dialog === "remove"
                    ? "Remove from collection"
                    : dialog === "nav"
                      ? "Locations"
                      : dialog === "filters"
                        ? "Filters & display"
                        : dialog === "create"
                          ? "Add location"
                          : dialog === "manage"
                            ? "Manage locations"
                            : "Card details"}
              </h2>
              <button onClick={() => setDialog(null)} aria-label="Close dialog">
                ✕
              </button>
            </div>
            {dialog === "move" && (
              <>
                <input
                  autoComplete="off"
                  aria-label="Search destinations"
                  placeholder="Find a location…"
                  value={destinationQuery}
                  onChange={(e) => setDestinationQuery(e.target.value)}
                />
                {navigation(true)}
                <div className="mw-move-summary">
                  {destination ? (
                    <>
                      <strong>{path(destination)}</strong>
                      <p>
                        {plural(movingCount, "copy", "copies")} will move.
                        {movingCount < selection.length &&
                          ` ${selection.length - movingCount} already here will stay.`}
                      </p>
                    </>
                  ) : (
                    <p>Choose a destination.</p>
                  )}
                </div>
                <button
                  className="mw-primary"
                  disabled={!destination || !movingCount}
                  onClick={() => mutate(grouped(), destination)}
                >
                  Move {plural(movingCount, "copy", "copies")}
                </button>
              </>
            )}
            {dialog === "remove" && (
              <>
                <p>
                  Remove{" "}
                  {plural(selection.length, "selected copy", "selected copies")}{" "}
                  from your collection?
                </p>
                <ul className="mw-removal-list">
                  {grouped().map((i) => (
                    <li key={`${i.source}:${i.id}`}>
                      <strong>
                        {i.quantity} ×{" "}
                        {editions.find((e) => e.id === i.id)!.name}
                      </strong>
                      <small>{path(i.source)}</small>
                    </li>
                  ))}
                </ul>
                <button
                  className="mw-danger"
                  onClick={() => mutate(grouped(), null)}
                >
                  Remove {plural(selection.length, "copy", "copies")}
                </button>
              </>
            )}
            {dialog === "detail" && (
              <div className="mw-sheet-details">{details}</div>
            )}
            {dialog === "manage" && managePanel}
            {dialog === "nav" && (
              <>
                {locationHeading(false)}
                {navigation()}
              </>
            )}
            {dialog === "filters" && (
              <>
                {filters}
                <div className="mw-drawer-display">
                  <h3>Display</h3>
                  {displayControls}
                </div>
              </>
            )}
            {dialog === "create" && (
              <form
                className="mw-create-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  createLocation();
                }}
              >
                <label>
                  Location name
                  <input
                    aria-label="Location name"
                    data-autofocus
                    value={locationName}
                    maxLength={120}
                    onChange={(e) => {
                      setLocationName(e.target.value);
                      setCreateError("");
                    }}
                    autoComplete="off"
                  />
                </label>
                <label>
                  Parent location
                  <select
                    aria-label="Parent location"
                    value={createParent || ""}
                    onChange={(e) => {
                      setCreateParent(e.target.value || null);
                      setConversion("");
                      setCreateError("");
                    }}
                  >
                    <option value="">Top level</option>
                    {locations
                      .filter((l) => !l.deck)
                      .map((l) => (
                        <option key={l.id} value={l.id}>
                          {path(l.id)}
                        </option>
                      ))}
                  </select>
                </label>
                {createParent && total(createParent) > 0 && (
                  <fieldset>
                    <legend>
                      This location contains {total(createParent)} cards. Where
                      should they go?
                    </legend>
                    <label>
                      <input
                        type="radio"
                        name="conversion"
                        checked={conversion === "named"}
                        onChange={() => setConversion("named")}
                      />
                      Move existing cards into{" "}
                      {locationName.trim() || "the new child"}
                    </label>
                    <label>
                      <input
                        type="radio"
                        name="conversion"
                        checked={conversion === "unsorted"}
                        onChange={() => setConversion("unsorted")}
                      />
                      Create a separate Unsorted child for existing cards
                    </label>
                  </fieldset>
                )}
                {createError && (
                  <p role="alert" className="mw-create-error">
                    {createError}
                  </p>
                )}
                <div className="mw-create-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setDialog(createFromManage ? "manage" : null)
                    }
                  >
                    Cancel
                  </button>
                  <button className="mw-primary" type="submit">
                    Create location
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
