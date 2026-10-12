// PROTOTYPE — throwaway sample data for "Prototype Catalog search in the shell" (#126). Not production code.
// One catalog: Printings, each with its Card Editions. Covers the hard cases: several Editions per Printing, owned and
// unowned, an owner-reviewed manual record, an Edition with no price, an unavailable Edition, missing artwork, a
// Pokémon with an ex rule box (GLC), and a rotated set (Standard).

export type CatEdition = {
  id: string;
  variant: string;
  source: "tcgdex" | "manual";
  active: boolean;
  price: number | null;
  /** Copies the collector owns, and where. */
  owned: { loc: string; name: string; qty: number }[];
};
export type CatPrinting = {
  id: string;
  name: string;
  identity: string;
  set: string;
  setName: string;
  number: string;
  kind: "Pokémon" | "Trainer" | "Energy";
  sub: string;
  mark: string | null;
  hue: number;
  art: boolean;
  source: "tcgdex" | "manual";
  editions: CatEdition[];
};

const E = (
  id: string,
  variant: string,
  price: number | null,
  owned: [string, string, number][] = [],
  extra: Partial<CatEdition> = {}
): CatEdition => ({
  id,
  variant,
  source: "tcgdex",
  active: true,
  price,
  owned: owned.map(([loc, name, qty]) => ({ loc, name, qty })),
  ...extra,
});

export const CATALOG: CatPrinting[] = [
  { id: "p1", name: "Iono", identity: "Iono", set: "PAL", setName: "Paldea Evolved", number: "185", kind: "Trainer", sub: "Supporter", mark: "G", hue: 300, art: true, source: "tcgdex",
    editions: [E("c1", "Normal", 1.1, [["d-zard", "Charizard ex", 2], ["bulk-a", "Bulk box A", 1]]), E("c2", "Reverse Holo", 1.9)] },
  { id: "p2", name: "Iono", identity: "Iono", set: "PAL", setName: "Paldea Evolved", number: "237", kind: "Trainer", sub: "Supporter", mark: "G", hue: 300, art: true, source: "tcgdex",
    editions: [E("c3", "Full Art", 4.8, [["b151", "151 display binder", 1]])] },
  { id: "p3", name: "Iono", identity: "Iono", set: "PAL", setName: "Paldea Evolved", number: "254", kind: "Trainer", sub: "Supporter", mark: "G", hue: 300, art: true, source: "tcgdex",
    editions: [E("c4", "Special Illustration Rare", 62)] },
  { id: "p4", name: "Iono", identity: "Iono", set: "PAF", setName: "Paldean Fates", number: "80", kind: "Trainer", sub: "Supporter", mark: "G", hue: 300, art: true, source: "tcgdex",
    editions: [E("c5", "Normal", 0.6), E("c6", "Reverse Holo", 1.2), E("c7", "Cosmos Holo (League promo)", null, [], { source: "manual" })] },
  { id: "p5", name: "Iono's Bellibolt ex", identity: "Iono's Bellibolt ex", set: "JTG", setName: "Journey Together", number: "53", kind: "Pokémon", sub: "Stage 1", mark: "I", hue: 55, art: true, source: "tcgdex",
    editions: [E("c8", "Holo", 3.2)] },
  { id: "p6", name: "Iono's Tadbulb", identity: "Iono's Tadbulb", set: "JTG", setName: "Journey Together", number: "52", kind: "Pokémon", sub: "Basic", mark: "I", hue: 55, art: false, source: "tcgdex",
    editions: [E("c9", "Normal", 0.1, [["unsorted", "Unsorted", 4]]), E("c10", "Reverse Holo", 0.3)] },
  { id: "p7", name: "Rare Candy", identity: "Rare Candy", set: "SVI", setName: "Scarlet & Violet", number: "191", kind: "Trainer", sub: "Item", mark: "G", hue: 0, art: true, source: "tcgdex",
    editions: [E("c11", "Normal", 0.9, [["d-zard", "Charizard ex", 1], ["trade", "Trade box", 1], ["unsorted", "Unsorted", 1], ["bulk-a", "Bulk box A", 2]]), E("c12", "Reverse Holo", 1.4, [["trade", "Trade box", 1]])] },
  { id: "p8", name: "Rare Candy", identity: "Rare Candy", set: "SVI", setName: "Scarlet & Violet", number: "256", kind: "Trainer", sub: "Item", mark: "G", hue: 45, art: true, source: "tcgdex",
    editions: [E("c13", "Hyper Rare", 14.5)] },
  { id: "p9", name: "Rare Candy", identity: "Rare Candy", set: "SUM", setName: "Sun & Moon", number: "129", kind: "Trainer", sub: "Item", mark: null, hue: 0, art: true, source: "tcgdex",
    editions: [E("c14", "Normal", 0.5, [["b151", "151 display binder", 1]]), E("c15", "Reverse Holo", 1.1, [], { active: false })] },
  { id: "p10", name: "Charizard ex", identity: "Charizard ex", set: "OBF", setName: "Obsidian Flames", number: "125", kind: "Pokémon", sub: "Stage 2", mark: "G", hue: 12, art: true, source: "tcgdex",
    editions: [E("c16", "Holo", 9.8, [["d-zard", "Charizard ex", 2], ["b151", "151 display binder", 1]])] },
  { id: "p11", name: "Charizard ex", identity: "Charizard ex", set: "OBF", setName: "Obsidian Flames", number: "223", kind: "Pokémon", sub: "Stage 2", mark: "G", hue: 12, art: true, source: "tcgdex",
    editions: [E("c17", "Special Illustration Rare", 85)] },
  { id: "p12", name: "Radiant Charizard", identity: "Radiant Charizard", set: "CRZ", setName: "Crown Zenith", number: "20", kind: "Pokémon", sub: "Basic", mark: "F", hue: 14, art: true, source: "tcgdex",
    editions: [E("c18", "Holo", 2.1, [["trade", "Trade box", 1]])] },
  { id: "p13", name: "Pikachu", identity: "Pikachu", set: "MCD24", setName: "McDonald's Collection 2024", number: "3", kind: "Pokémon", sub: "Basic", mark: null, hue: 50, art: false, source: "manual",
    editions: [E("c19", "Holo", null, [], { source: "manual" })] },
  { id: "p14", name: "Ultra Ball", identity: "Ultra Ball", set: "SVI", setName: "Scarlet & Violet", number: "196", kind: "Trainer", sub: "Item", mark: "G", hue: 0, art: true, source: "tcgdex",
    editions: [E("c20", "Normal", 0.3, [["d-zard", "Charizard ex", 3], ["bulk-b", "Bulk box B", 5]]), E("c21", "Reverse Holo", 0.6)] },
  { id: "p15", name: "Basic Fire Energy", identity: "Basic Fire Energy", set: "SVE", setName: "Scarlet & Violet Energies", number: "2", kind: "Energy", sub: "Basic Energy", mark: null, hue: 10, art: true, source: "tcgdex",
    editions: [E("c22", "Normal", 0.05, [["d-zard", "Charizard ex", 13], ["unsorted", "Unsorted", 20]])] },
];

export const LEAVES = [
  { id: "b151", path: "Binders / 151 display binder" },
  { id: "trade", path: "Binders / Trade box" },
  { id: "bulk-a", path: "Bulk box A" },
  { id: "bulk-b", path: "Bulk box B" },
  { id: "d-zard", path: "Deck box / Charizard ex (Deck)" },
  { id: "d-gard", path: "Deck box / Gardevoir ex (Deck)" },
  { id: "unsorted", path: "Unsorted" },
];
export const DECKS = [
  { id: "d-zard", name: "Charizard ex" },
  { id: "d-gard", name: "Gardevoir ex" },
  { id: "d-new", name: "Raging Bolt (planning)" },
];

export const LAST_PULL = "2026-10-12 06:00";
export const MY_REPORTS = [
  { card: "Rare Candy SUM 129 · Reverse Holo", status: "Waiting for review" },
  { card: "Pikachu MCD24 3", status: "Approved: added as a manual record" },
];

const ROTATED_MARKS = ["F", "E", "D"];
export function legal(p: CatPrinting, f: "standard" | "expanded" | "glc"): boolean | null {
  if (f === "glc") return !/ ex$/.test(p.name) && !p.name.startsWith("Radiant");
  if (f === "standard") return p.mark === null ? (p.kind === "Energy" ? true : null) : !ROTATED_MARKS.includes(p.mark);
  return true;
}
export const ownedCount = (e: CatEdition) => e.owned.reduce((n, o) => n + o.qty, 0);
