// PROTOTYPE — throwaway sample data for "Prototype the Deck experience" (#125). Not production code.
// Every hard case from the Decks UI inventory is here once. ASSUMPTION: not-owned lines have names and art. The real
// API gives Deck List lines only an edition_id today (inventory, "Backend gaps"); the design does not solve that.

export type Kind = "Pokémon" | "Trainer" | "Energy";
export type Source = {
  loc: string;
  name: string;
  /** 'storage_leaf' is loose storage; 'deck' is another Deck. */
  kind: "storage_leaf" | "deck";
  available: number;
  /** Copies that other Deck holds for its own line; taking more leaves it short. */
  committed: number;
  /** Copies the suggestion takes from here. */
  suggested: number;
};
export type Line = {
  id: string;
  name: string;
  set: string;
  variant: string;
  kind: Kind;
  qty: number;
  inDeck: number;
  sources: Source[];
  price: number | null;
  hue: number;
};

const S = (
  loc: string,
  name: string,
  available: number,
  suggested: number,
  deck = false,
  committed = 0
): Source => ({
  loc,
  name,
  kind: deck ? "deck" : "storage_leaf",
  available,
  committed,
  suggested,
});

export const LINES: Line[] = [
  { id: "e1", name: "Charmander", set: "MEW 4", variant: "Normal", kind: "Pokémon", qty: 4, inDeck: 4, sources: [], price: 0.4, hue: 18 },
  { id: "e2", name: "Charmeleon", set: "PAF 8", variant: "Reverse Holo", kind: "Pokémon", qty: 2, inDeck: 0, sources: [S("trade", "Trade box", 3, 2)], price: 0.6, hue: 22 },
  { id: "e3", name: "Charizard ex", set: "OBF 125", variant: "Holo", kind: "Pokémon", qty: 3, inDeck: 2, sources: [S("b151", "151 display binder", 1, 1)], price: 9.8, hue: 12 },
  { id: "e4", name: "Pidgey", set: "MEW 16", variant: "Unspecified Variant", kind: "Pokémon", qty: 2, inDeck: 2, sources: [], price: 0.25, hue: 40 },
  { id: "e5", name: "Pidgeot ex", set: "OBF 164", variant: "Holo", kind: "Pokémon", qty: 2, inDeck: 0, sources: [S("d-gard", "Gardevoir ex (Deck)", 1, 1, true, 1)], price: 4.2, hue: 220 },
  { id: "e6", name: "Charcadet", set: "PAR 32", variant: "Normal", kind: "Pokémon", qty: 1, inDeck: 0, sources: [S("unsorted", "Unsorted", 2, 1)], price: 0.15, hue: 8 },
  { id: "e7", name: "Rare Candy", set: "SVI 191", variant: "Normal", kind: "Trainer", qty: 4, inDeck: 1, sources: [S("trade", "Trade box", 1, 1), S("unsorted", "Unsorted", 1, 1), S("bulk-a", "Bulk box A", 2, 1)], price: 0.9, hue: 0 },
  { id: "e8", name: "Iono", set: "PAL 185", variant: "Normal", kind: "Trainer", qty: 4, inDeck: 2, sources: [S("bulk-a", "Bulk box A", 1, 1)], price: 1.1, hue: 0 },
  { id: "e9", name: "Arven", set: "SVI 166", variant: "Normal", kind: "Trainer", qty: 4, inDeck: 4, sources: [], price: 0.5, hue: 0 },
  { id: "e10", name: "Boss's Orders", set: "PAL 172", variant: "Normal", kind: "Trainer", qty: 3, inDeck: 0, sources: [], price: 1.6, hue: 0 },
  { id: "e11", name: "Ultra Ball", set: "SVI 196", variant: "Normal", kind: "Trainer", qty: 4, inDeck: 3, sources: [S("bulk-b", "Bulk box B", 5, 1)], price: 0.3, hue: 0 },
  { id: "e12", name: "Super Rod", set: "PAL 188", variant: "Normal", kind: "Trainer", qty: 2, inDeck: 0, sources: [], price: null, hue: 0 },
  { id: "e13", name: "Nest Ball", set: "SVI 181", variant: "Normal", kind: "Trainer", qty: 4, inDeck: 4, sources: [], price: 0.2, hue: 0 },
  { id: "e14", name: "Buddy-Buddy Poffin", set: "TEF 144", variant: "Normal", kind: "Trainer", qty: 4, inDeck: 4, sources: [], price: 0.35, hue: 0 },
  { id: "e15", name: "Counter Catcher", set: "PAR 160", variant: "Normal", kind: "Trainer", qty: 2, inDeck: 2, sources: [], price: 0.4, hue: 0 },
  { id: "e16", name: "Jet Energy", set: "PAL 190", variant: "Normal", kind: "Energy", qty: 2, inDeck: 0, sources: [], price: 0.7, hue: 50 },
  { id: "e17", name: "Basic Fire Energy", set: "SVE 2", variant: "Normal", kind: "Energy", qty: 13, inDeck: 13, sources: [], price: 0.05, hue: 10 },
];

export const elsewhere = (l: Line) => Math.min(l.qty - l.inDeck, l.sources.reduce((n, s) => n + s.suggested, 0));
export const notOwned = (l: Line) => l.qty - l.inDeck - elsewhere(l);

/** Copies held in the Deck beyond its Deck List: a line was cut. */
export const SURPLUS = [{ id: "s1", name: "Professor's Research", set: "SVI 189", variant: "Normal", qty: 2, hue: 0 }];

/** Several Decks count the same spare copies. */
export const COMPETITION = [
  { line: "e7", text: "Rare Candy: 1 spare copy, but this Deck and Lost Box both count it as elsewhere." },
];

export type Status = "legal" | "not_legal" | "unknown";
export type Issue = { code: string; reason: string; kind: "deck" | "card"; effect: "not_legal" | "unknown"; lines: string[] };
export type Format = { id: string; name: string; status: Status; issues: Issue[]; rules: string };
export const FORMATS: Format[] = [
  {
    id: "standard",
    name: "Standard",
    status: "unknown",
    rules: "standard r4 · 2026-09-01",
    issues: [
      { code: "set_date_not_recorded", reason: "Set legality date not recorded for Paradox Rift promos", kind: "card", effect: "unknown", lines: ["e15"] },
    ],
  },
  { id: "expanded", name: "Expanded", status: "legal", rules: "expanded r2 · 2026-09-01", issues: [] },
  {
    id: "glc",
    name: "Gym Leader Challenge",
    status: "not_legal",
    rules: "glc r1 · 2026-08-15",
    issues: [
      { code: "copy_limit", reason: "Only one copy of each card name (except Basic Energy)", kind: "deck", effect: "not_legal", lines: ["e1", "e2", "e3", "e7", "e8", "e9", "e11"] },
      { code: "single_type", reason: "Pokémon must share one type: Fire and Colorless found", kind: "deck", effect: "not_legal", lines: ["e4", "e5"] },
      { code: "rule_box_not_allowed", reason: "Rule Box cards, including Radiant and Prism Star cards, are not allowed", kind: "card", effect: "not_legal", lines: ["e3", "e5"] },
    ],
  },
];
export const FUTURE_NOTE =
  "2027-04-10 is in the future: rules published after this rules file (2026-09-01) are unknown.";

export const COST = {
  list: { amount: 112.4, priced: 58, total: 60 },
  complete: { amount: 21.9, priced: 9, total: 11 },
};

export const PUBLICATION = { title: "Charizard ex — Pidgeot", visibility: "Unlisted", version: 3 };
/** A publication whose Deck was deleted: still live until revoked. */
export const ORPHANS = [{ token: "k3J…", title: "Lost Box (Deck deleted)", visibility: "Listed", version: 2 }];

export const DECK_SUMMARIES = [
  { id: "d-zard", name: "Charizard ex", owned: 41, total: 60, toComplete: 21.9, status: ["unknown", "legal", "not_legal"] as Status[] },
  { id: "d-gard", name: "Gardevoir ex", owned: 60, total: 60, toComplete: 0, status: ["legal", "unknown", "not_legal"] as Status[] },
  { id: "d-new", name: "Raging Bolt (planning)", owned: 0, total: 0, toComplete: 0, status: ["unknown", "unknown", "unknown"] as Status[] },
];

// ---------- Variant D: a TCG Live–style builder (owner request, 2026-10-12) ----------

/** Pokémon by evolution family; Trainers and Energy by subtype. The deck panel groups by these. */
export const GROUP: Record<string, string> = {
  Charmander: "Charizard line", Charmeleon: "Charizard line", "Charizard ex": "Charizard line", Charcadet: "Charizard line",
  Pidgey: "Pidgeot line", "Pidgeot ex": "Pidgeot line", Pikachu: "Other Pokémon", "Mew ex": "Other Pokémon",
  "Radiant Charizard": "Other Pokémon", Dusknoir: "Other Pokémon", Duskull: "Other Pokémon",
  Iono: "Supporter", Arven: "Supporter", "Boss's Orders": "Supporter", "Professor's Research": "Supporter",
  "Rare Candy": "Item", "Ultra Ball": "Item", "Super Rod": "Item", "Nest Ball": "Item", "Buddy-Buddy Poffin": "Item",
  "Counter Catcher": "Item", "Lost Vacuum": "Item", "Forest Seal Stone": "Tool", "Artazon": "Stadium",
  "Jet Energy": "Special Energy", "Basic Fire Energy": "Basic Energy",
};

/** Library cards that are not on the Charizard ex Deck List. `owned` counts every copy in the Collection. */
export const LIBRARY_EXTRA: (Omit<Line, "qty" | "inDeck" | "sources"> & { owned: number })[] = [
  { id: "x1", name: "Pikachu", set: "MEW 25", variant: "Normal", kind: "Pokémon", owned: 3, price: 0.3, hue: 50 },
  { id: "x2", name: "Mew ex", set: "MEW 151", variant: "Holo", kind: "Pokémon", owned: 1, price: 3.4, hue: 330 },
  { id: "x3", name: "Radiant Charizard", set: "CRZ 20", variant: "Holo", kind: "Pokémon", owned: 1, price: 2.1, hue: 14 },
  { id: "x4", name: "Duskull", set: "SFA 18", variant: "Normal", kind: "Pokémon", owned: 0, price: 0.2, hue: 270 },
  { id: "x5", name: "Dusknoir", set: "SFA 20", variant: "Normal", kind: "Pokémon", owned: 0, price: 1.3, hue: 270 },
  { id: "x6", name: "Professor's Research", set: "SVI 189", variant: "Normal", kind: "Trainer", owned: 4, price: 0.3, hue: 0 },
  { id: "x7", name: "Lost Vacuum", set: "LOR 162", variant: "Normal", kind: "Trainer", owned: 0, price: 0.4, hue: 0 },
  { id: "x8", name: "Forest Seal Stone", set: "SIT 156", variant: "Normal", kind: "Trainer", owned: 1, price: 0.6, hue: 0 },
  { id: "x9", name: "Artazon", set: "PAL 171", variant: "Normal", kind: "Trainer", owned: 0, price: 0.5, hue: 0 },
];

/** More Editions of Identities already on the list, so the Identity picker has real choices. */
export const ALT_EDITIONS: (Omit<Line, "qty" | "inDeck" | "sources"> & { owned: number })[] = [
  { id: "a1", name: "Rare Candy", set: "SVI 191", variant: "Reverse Holo", kind: "Trainer", owned: 1, price: 1.4, hue: 0 },
  { id: "a2", name: "Rare Candy", set: "PAF 89", variant: "Normal", kind: "Trainer", owned: 2, price: 0.8, hue: 0 },
  { id: "a3", name: "Rare Candy", set: "SVI 256", variant: "Hyper Rare", kind: "Trainer", owned: 0, price: 14.5, hue: 45 },
  { id: "a4", name: "Iono", set: "PAL 254", variant: "Special Illustration Rare", kind: "Trainer", owned: 0, price: 62.0, hue: 300 },
  { id: "a5", name: "Iono", set: "PAL 237", variant: "Full Art", kind: "Trainer", owned: 1, price: 4.8, hue: 300 },
  { id: "a6", name: "Charizard ex", set: "OBF 223", variant: "Special Illustration Rare", kind: "Pokémon", owned: 0, price: 85.0, hue: 12 },
  { id: "a7", name: "Ultra Ball", set: "PAF 91", variant: "Normal", kind: "Trainer", owned: 3, price: 0.25, hue: 0 },
  { id: "a8", name: "Pikachu", set: "SVP 101", variant: "Promo", kind: "Pokémon", owned: 0, price: 2.2, hue: 50 },
];
