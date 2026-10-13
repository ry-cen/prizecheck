// PROTOTYPE — throwaway sample data for "Prototype Missing cards and Owner controls" (#139).
// Shapes follow web/src/generated.ts, reconciliation_generated.ts and metadata_generated.ts on dev, trimmed to
// what the screens show. Built to reach the worst cases: a stale pull, a stale backup, a 70% quota, a Printing
// deprecation with per-Edition mapping, a metadata target with several reports, paging, and every report status.

export type PullRun = {
  id: number;
  phase: string;
  enumerated: number;
  fetched: number;
  validated: number;
  outcome: string | null;
  error: string | null;
  stale: boolean;
};
export const PULL_STATES: Record<"running" | "stale" | "done", PullRun> = {
  running: { id: 91, phase: "fetching", enumerated: 21840, fetched: 13112, validated: 12988, outcome: null, error: null, stale: false },
  stale: { id: 90, phase: "validating", enumerated: 21840, fetched: 21840, validated: 17406, outcome: null, error: null, stale: true },
  done: { id: 89, phase: "complete", enumerated: 21831, fetched: 21831, validated: 21831, outcome: "succeeded", error: null, stale: false },
};
export const LAST_SUCCESS = "2026-10-11 03:12";

export type Health = { label: string; value: string; tone: "ok" | "warn" | "bad" | "unverified"; detail?: string };
export const HEALTH: { group: string; rows: Health[] }[] = [
  {
    group: "Backups",
    rows: [
      { label: "Backup", value: "Stale", tone: "bad", detail: "Last success 2026-10-10 02:00 · 2 failed jobs" },
      { label: "Disposable restore", value: "2026-10-09 04:10", tone: "ok", detail: "0 failed restores" },
      { label: "Backup watchdog", value: "2026-10-12 06:00", tone: "ok", detail: "1 stale-backup alert" },
    ],
  },
  {
    group: "Sign-in and API (24 h)",
    rows: [
      { label: "Sign-in requests", value: "38", tone: "ok", detail: "Delivered 37 · failed 1" },
      { label: "Private API", value: "14,212 requests", tone: "ok", detail: "6 failures · 3 authorization denials · mean 41 ms" },
      { label: "Gateway denials", value: "12", tone: "ok" },
    ],
  },
  {
    group: "Catalog and public delivery",
    rows: [
      { label: "Catalog failures", value: "0", tone: "ok" },
      { label: "Public deliveries pending", value: "4", tone: "warn", detail: "Oldest 412 s" },
      { label: "Projection failures", value: "0", tone: "ok", detail: "2 pending · 0 release failures" },
    ],
  },
  {
    group: "Provider allowances",
    rows: [
      { label: "TCGdex requests", value: "71,400 / 100,000", tone: "warn", detail: "70% warning" },
      { label: "Price quotes", value: "Unverified", tone: "unverified", detail: "Measurement is stale" },
      { label: "Email sends", value: "212 / 3,000", tone: "ok" },
    ],
  },
];

export type QueueId = "catalog" | "metadata" | "attributes" | "reprints" | "missing";
export const QUEUES: { id: QueueId; label: string; short: string; today: boolean; blurb: string }[] = [
  { id: "catalog", label: "Catalog reconciliation", short: "Catalog", today: true, blurb: "Source drift waits for evidenced review. Confirming a source keeps identities and moves no copies." },
  { id: "metadata", label: "Metadata review", short: "Metadata", today: true, blurb: "Quarantined Editions, suspended Printings and collector reports. Nothing changes until you decide with a fresh code." },
  { id: "attributes", label: "Card attributes", short: "Attributes", today: false, blurb: "Derived attributes that feed format checks and the type chips. A correction overrides the source value." },
  { id: "reprints", label: "Reprint Groups", short: "Reprints", today: false, blurb: "Printings of one Card Identity with functionally identical text. Merge, split, or merge Card Identities." },
  { id: "missing", label: "Missing-card reports", short: "Missing cards", today: true, blurb: "Collector reports of Printings or Editions the catalog lacks. Approving creates a shared record." },
];

export type Item = {
  id: string;
  queue: QueueId;
  title: string;
  sub: string;
  kind: string;
  opened: string;
  age: string;
  reports: number;
  flag?: string;
};

export const ITEMS: Item[] = [
  { id: "cr-1", queue: "catalog", title: "Iono", sub: "PAL 185", kind: "source drift", opened: "2026-10-11", age: "1 d", reports: 0, flag: "Deprecate Printing" },
  { id: "cr-2", queue: "catalog", title: "Rare Candy", sub: "SVI 191", kind: "source match", opened: "2026-10-11", age: "1 d", reports: 0 },
  { id: "cr-3", queue: "catalog", title: "Pikachu ex", sub: "SSP 57", kind: "source drift", opened: "2026-10-09", age: "3 d", reports: 0 },
  { id: "md-1", queue: "metadata", title: "Charizard ex", sub: "OBF 125 · Holo", kind: "marketplace", opened: "2026-10-10", age: "2 d", reports: 3, flag: "Quarantined" },
  { id: "md-2", queue: "metadata", title: "Boss's Orders", sub: "PAL 172", kind: "live", opened: "2026-10-12", age: "6 h", reports: 1, flag: "Suspended" },
  { id: "md-3", queue: "metadata", title: "Arven", sub: "OBF 186 · Reverse Holo", kind: "marketplace", opened: "2026-10-08", age: "4 d", reports: 0 },
  { id: "md-4", queue: "metadata", title: "Nest Ball", sub: "SVI 181", kind: "marketplace", opened: "2026-10-07", age: "5 d", reports: 0 },
  { id: "md-5", queue: "metadata", title: "Ultra Ball", sub: "SVI 196", kind: "live", opened: "2026-10-07", age: "5 d", reports: 0 },
  { id: "md-6", queue: "metadata", title: "Counter Catcher", sub: "PAR 160", kind: "marketplace", opened: "2026-10-06", age: "6 d", reports: 0 },
  { id: "md-7", queue: "metadata", title: "Super Rod", sub: "PAL 188", kind: "marketplace", opened: "2026-10-05", age: "7 d", reports: 0 },
  { id: "at-1", queue: "attributes", title: "Professor's Research", sub: "SVI 189", kind: "Trainer Type unknown", opened: "2026-10-12", age: "2 h", reports: 1, flag: "Trainer Type" },
  { id: "at-2", queue: "attributes", title: "Forest Seal Stone", sub: "SIT 156", kind: "report", opened: "2026-10-11", age: "1 d", reports: 2 },
  { id: "rg-1", queue: "reprints", title: "Rare Candy", sub: "6 Printings · 2 groups", kind: "text differs", opened: "2026-10-10", age: "2 d", reports: 0 },
  { id: "mc-1", queue: "missing", title: "Iono", sub: "PAL 269 · Special Illustration", kind: "Printing", opened: "2026-10-12", age: "3 h", reports: 1 },
  { id: "mc-2", queue: "missing", title: "Edition of Charmander", sub: "MEW 4 · Cosmos Holo", kind: "Edition", opened: "2026-10-11", age: "1 d", reports: 1, flag: "Needs info" },
];
/** More items arrive with "Load more", as in today's metadata queue. */
export const MORE_METADATA: Item[] = [
  { id: "md-8", queue: "metadata", title: "Switch", sub: "SVI 194", kind: "marketplace", opened: "2026-10-04", age: "8 d", reports: 0 },
  { id: "md-9", queue: "metadata", title: "Earthen Vessel", sub: "PAR 163", kind: "live", opened: "2026-10-03", age: "9 d", reports: 0 },
];

export const EDITIONS_OF_IONO = [
  { id: "e1", label: "Normal", holdings: 14 },
  { id: "e2", label: "Reverse Holo", holdings: 6 },
  { id: "e3", label: "Poké Ball Reverse Holo", holdings: 2 },
  { id: "e4", label: "Unspecified Variant", holdings: 1 },
];
export const REPLACEMENTS = [
  "Iono · Paldea Evolved #185 · Normal",
  "Iono · Paldea Evolved #185 · Reverse Holo",
  "Iono · Paldea Evolved #185 · Poké Ball Reverse Holo",
  "Iono · Paldea Evolved #185 · Master Ball Reverse Holo",
];

export const METADATA_REPORTS = [
  { id: "a91c22e0", issue: "wrong product", status: "pending", proposed: "product 512330 · holofoil", note: "TCGplayer lists this as the Holo, not the Normal.", evidence: "https://www.tcgplayer.com/product/512330" },
  { id: "4be01f9d", issue: "wrong price", status: "needs info", proposed: "variant holofoil", note: "Price is 10x what it sells for.", evidence: null },
  { id: "77d3aa10", issue: "wrong product", status: "pending", proposed: "product 512331", note: "", evidence: "https://example.com/photo.jpg" },
];
export const METADATA_COMPARE = [
  { field: "product ID", source: "512331", reviewed: "512330" },
  { field: "quote variant", source: "normal", reviewed: "holofoil" },
  { field: "Live code", source: "OBF 125", reviewed: "OBF 125" },
];
export const HISTORY = [
  { at: "2026-10-02 18:40", who: "owner", what: "Accepted source mapping", why: "Matches the product page." },
  { at: "2026-09-21 09:12", who: "owner", what: "Corrected mapping", why: "Source pointed at the Japanese product." },
];

export const ATTRIBUTE_ROWS = [
  { field: "Card kind", derived: "Trainer", correction: "—", effective: "Trainer" },
  { field: "Trainer Type", derived: "unknown", correction: "Supporter", effective: "Supporter", changed: true },
  { field: "Regulation mark", derived: "G", correction: "—", effective: "G" },
  { field: "Rule box", derived: "no", correction: "—", effective: "no" },
  { field: "ACE SPEC", derived: "no", correction: "—", effective: "no" },
  { field: "Evolves from", derived: "—", correction: "—", effective: "—" },
];

export const REPRINT_GROUPS = [
  {
    group: "Group 1 · me01-125 text",
    legal: "Standard via me01-125 (mark I)",
    printings: [
      { id: "me01-125", label: "Mega Evolution 125", mark: "I" },
      { id: "sv01-191", label: "Scarlet & Violet 191", mark: "G" },
      { id: "swsh1-180", label: "Sword & Shield 180", mark: "D" },
      { id: "swsh12.5-141", label: "Crown Zenith 141", mark: "—" },
    ],
  },
  {
    group: "Group 2 · older text",
    legal: "Expanded only",
    printings: [
      { id: "sm1-129", label: "Sun & Moon 129", mark: "—" },
      { id: "sm8-191", label: "Lost Thunder 191", mark: "—" },
    ],
  },
];

export const RULES = [
  { kind: "marketplace", active: 3, latest: 4, digest: "9f2c…a71e", note: "v4 maps Poké Ball and Master Ball patterns." },
  { kind: "live", active: 2, latest: 2, digest: "41d0…08bb", note: "Up to date." },
];

export type MyReport = {
  id: string;
  kind: "Missing Printing" | "Missing Edition" | "Metadata" | "Attribute";
  card: string;
  status: "pending" | "needs info" | "rejected" | "approved";
  sent: string;
  thread: { who: "you" | "owner"; at: string; text: string }[];
};
export const MY_REPORTS: MyReport[] = [
  {
    id: "r1",
    kind: "Missing Edition",
    card: "Charmander · MEW 4 · Cosmos Holo",
    status: "needs info",
    sent: "2026-10-11",
    thread: [
      { who: "you", at: "2026-10-11 20:02", text: "The Cosmos Holo from the 151 blister isn't listed." },
      { who: "owner", at: "2026-10-12 08:15", text: "Which blister? A photo of the stamp or pack would settle it." },
    ],
  },
  {
    id: "r2",
    kind: "Missing Printing",
    card: "Iono · PAL 269",
    status: "pending",
    sent: "2026-10-12",
    thread: [{ who: "you", at: "2026-10-12 09:30", text: "Special Illustration Rare is missing from Paldea Evolved." }],
  },
  {
    id: "r3",
    kind: "Metadata",
    card: "Charizard ex · OBF 125 · Holo",
    status: "pending",
    sent: "2026-10-10",
    thread: [{ who: "you", at: "2026-10-10 14:00", text: "Price is for the wrong product." }],
  },
  {
    id: "r4",
    kind: "Missing Printing",
    card: "Pikachu · SVP 27",
    status: "rejected",
    sent: "2026-10-02",
    thread: [
      { who: "you", at: "2026-10-02 11:11", text: "Promo missing." },
      { who: "owner", at: "2026-10-03 07:40", text: "It's in the catalog as SVP 027 — search the set and number." },
    ],
  },
  {
    id: "r5",
    kind: "Missing Printing",
    card: "Mew ex · MEW 232",
    status: "approved",
    sent: "2026-09-28",
    thread: [
      { who: "you", at: "2026-09-28 19:00", text: "Gold Mew ex isn't listed." },
      { who: "owner", at: "2026-09-29 08:00", text: "Added from the set list. Thanks!" },
    ],
  },
  {
    id: "r6",
    kind: "Attribute",
    card: "Forest Seal Stone · SIT 156",
    status: "pending",
    sent: "2026-10-11",
    thread: [{ who: "you", at: "2026-10-11 16:20", text: "It's a Pokémon Tool, not an Item." }],
  },
];
export const PRINTING_SUGGESTIONS = [
  "Charmander · 151 · MEW 4",
  "Charmander · Obsidian Flames · OBF 26",
  "Charmander · Paldea Evolved · PAL 7",
];
