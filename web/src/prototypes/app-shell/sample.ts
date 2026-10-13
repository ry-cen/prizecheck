// PROTOTYPE — throwaway sample data for the app shell prototype (ticket #122). Not production code.

export type PageId = "collection" | "decks" | "catalog" | "reports" | "owner" | "signins";
export const PAGES: { id: PageId; label: string; icon: string }[] = [
  { id: "collection", label: "Collection", icon: "▦" },
  { id: "decks", label: "Decks", icon: "❒" },
  { id: "catalog", label: "Catalog", icon: "⌕" },
  { id: "reports", label: "Missing cards", icon: "⚑" },
];
// PROTOTYPE (#140): the Sign-ins settings page, reached from the avatar menu and the More sheet.
export const SIGNINS_PAGE = { id: "signins" as const, label: "Sign-ins", icon: "⚿" };
export const OWNER_PAGE = {
  id: "owner" as const,
  label: "Owner controls",
  icon: "⚙",
};

export type Loc = {
  id: string;
  name: string;
  deck?: boolean;
  children?: Loc[];
};
export const LOCATIONS: Loc[] = [
  {
    id: "binders",
    name: "Binders",
    children: [
      { id: "b151", name: "151 display binder" },
      { id: "trade", name: "Trade box" },
    ],
  },
  {
    id: "deckbox",
    name: "Deck box",
    children: [
      { id: "d-zard", name: "Charizard ex", deck: true },
      { id: "d-gard", name: "Gardevoir ex", deck: true },
    ],
  },
  { id: "unsorted", name: "Unsorted" },
];
export function locName(id: string): string {
  if (id === "all") return "All owned";
  const walk = (list: Loc[]): string | null => {
    for (const l of list) {
      if (l.id === id) return l.name;
      const hit = l.children && walk(l.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(LOCATIONS) ?? id;
}

const NAMES = [
  ["Charizard ex", "OBF 125", 18],
  ["Pidgeot ex", "OBF 164", 220],
  ["Rare Candy", "SVI 191", 0],
  ["Gardevoir ex", "SVI 86", 290],
  ["Kirlia", "SIT 68", 300],
  ["Iono", "PAL 185", 0],
  ["Arven", "SVI 166", 0],
  ["Pikachu", "MEW 25", 50],
  ["Mew ex", "MEW 151", 330],
  ["Boss's Orders", "PAL 172", 0],
  ["Ultra Ball", "SVI 196", 0],
  ["Basic Psychic Energy", "SVE 5", 270],
] as const;
const LEAVES = ["b151", "trade", "d-zard", "d-gard", "unsorted"];

export type Tile = {
  id: string;
  name: string;
  set: string;
  hue: number;
  loc: string;
  price: number;
};
export const TILES: Tile[] = Array.from({ length: 72 }, (_, i) => {
  const [name, set, hue] = NAMES[i % NAMES.length];
  return {
    id: `t${i}`,
    name,
    set,
    hue,
    loc: LEAVES[(i * 7 + Math.floor(i / 12)) % LEAVES.length],
    price: Math.round(((i * 37) % 900) / 10 + 0.25),
  };
}).sort((a, b) => a.name.localeCompare(b.name));

export const DECKS = [
  {
    id: "d-zard",
    name: "Charizard ex",
    owned: 52,
    total: 60,
    cost: 184.2,
    toComplete: 31.4,
    standard: "legal",
    expanded: "legal",
    glc: "not legal",
  },
  {
    id: "d-gard",
    name: "Gardevoir ex",
    owned: 60,
    total: 60,
    cost: 142.75,
    toComplete: 0,
    standard: "legal",
    expanded: "unknown",
    glc: "not legal",
  },
  {
    id: "d-lost",
    name: "Lost Box (list only)",
    owned: 21,
    total: 60,
    cost: 96.1,
    toComplete: 70.3,
    standard: "not legal",
    expanded: "legal",
    glc: "not legal",
  },
];

export const REPORTS = [
  {
    card: "Pikachu (McDonald's 2024) 3/15",
    status: "Waiting for review",
    at: "2026-10-09",
  },
  {
    card: "Charizard ex SIR (Japanese)",
    status: "Declined: not English",
    at: "2026-10-02",
  },
  {
    card: "Professor's Research (Sada) promo",
    status: "Added to catalog",
    at: "2026-09-28",
  },
];

export const OWNER_ROWS = Array.from({ length: 8 }, (_, i) => ({
  id: `rv-${1040 + i}`,
  kind: ["variant", "metadata", "price map", "missing card"][i % 4],
  source: ["tcgdex", "tcgplayer", "owner", "collector"][i % 4],
  card: NAMES[i % NAMES.length][0],
  set: NAMES[i % NAMES.length][1],
  detail:
    "Reverse holo listed twice in source; proposed merge into one Variant Descriptor",
  opened: `2026-10-0${(i % 9) + 1}`,
  age: `${i + 1}d`,
}));
