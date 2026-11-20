import type { CatalogReader, CatalogSet, Edition, Query } from "../catalog";
const sets: CatalogSet[] = [
  { id: "1", name: "First Light", code: "FL" },
  { id: "2", name: "Distant Shores", code: "DS" },
];
// Original schematic art, delivered inline: no remote art or source identifiers.
const battlefield = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 250"><rect width="350" height="250" fill="midnightblue"/><path d="M0 200 95 60 165 175 240 80 350 200Z" fill="slateblue"/><text x="175" y="230" text-anchor="middle" fill="white">Moonlit Crossing</text></svg>')}`;
export const editions: Edition[] = [
  {
    id: "1",
    printingId: "1",
    name: "Ember Scout",
    set: sets[0],
    number: "001",
    domain: "Fury",
    type: "Unit",
    finish: "Standard",
    art: null,
    orientation: "portrait",
  },
  {
    id: "2",
    printingId: "1",
    name: "Ember Scout",
    set: sets[0],
    number: "001",
    domain: "Fury",
    type: "Unit",
    finish: "Foil",
    art: null,
    orientation: "portrait",
  },
  {
    id: "3",
    printingId: "2",
    name: "Quiet Resolve",
    set: sets[0],
    number: "002",
    domain: "Calm",
    type: "Spell",
    finish: "Standard",
    art: null,
    orientation: "portrait",
  },
  {
    id: "4",
    printingId: "3",
    name: "Moonlit Crossing",
    set: sets[0],
    number: "003",
    domain: null,
    type: "Battlefield",
    finish: "Standard",
    art: battlefield,
    orientation: "landscape",
  },
  {
    id: "5",
    printingId: "4",
    name: "Ember Scout",
    set: sets[1],
    number: "004",
    domain: "Fury",
    type: "Unit",
    finish: "Showcase",
    art: null,
    orientation: "portrait",
  },
  ...Array.from({ length: 9 }, (_, i): Edition => ({
    id: String(i + 6),
    printingId: String(i + 5),
    name: `Shore Guardian ${i + 1}`,
    set: sets[1],
    number: String(i + 5).padStart(3, "0"),
    domain: "Calm",
    type: "Unit",
    finish: "Standard",
    art: null,
    orientation: "portrait",
  })),
];
export type Scenario =
  "normal" | "empty" | "failure" | "detail-failure" | "slow";
export function fixtureReader(scenario: Scenario = "normal"): CatalogReader {
  let failed = false;
  async function read<T>(
    value: T,
    signal: AbortSignal,
    operation: string
  ): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        scenario === "slow" ? 900 : 120
      );
      function abort() {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    if (
      !failed &&
      ((scenario === "failure" && operation === "list") ||
        (scenario === "detail-failure" && operation === "detail"))
    ) {
      failed = true;
      throw new Error("Synthetic read failure");
    }
    return value;
  }
  const rows = scenario === "empty" ? [] : editions;
  return {
    scope: "riftbound",
    sets: (signal) => read(sets, signal, "sets"),
    list: (q: Query, signal) => {
      const search = q.search.trim().toLowerCase();
      const matches = rows.filter(
        (e) =>
          (!search ||
            e.name.toLowerCase().includes(search) ||
            e.number.toLowerCase().includes(search)) &&
          (!q.set || e.set.id === q.set) &&
          (!q.domain || e.domain === q.domain) &&
          (!q.type || e.type === q.type)
      );
      return read(
        {
          editions: matches.slice((q.page - 1) * 8, q.page * 8),
          total: matches.length,
          pages: Math.max(1, Math.ceil(matches.length / 8)),
          catalogEmpty: rows.length === 0,
        },
        signal,
        "list"
      );
    },
    detail: (id, signal) =>
      read(rows.find((e) => e.id === id) ?? null, signal, "detail"),
  };
}
