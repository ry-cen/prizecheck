import type { CatalogSet } from "../catalog_browse_generated";

/** One folder of Catalog's set picker: the sets of one Pokémon TCG era (series), or the sets with no known era. */
export type SetEra = {
  /** The series ID, or OTHER_ERA for the sets with no known era. */
  key: string;
  name: string;
  sets: CatalogSet[];
};

/**
 * TCGdex series that are not a main line of the game: miscellaneous cards, POP, trainer kits and the McDonald's
 * Collection. Their folders sit in a block below the main eras. Any series not listed here, including one TCGdex
 * adds later, counts as a main era.
 */
export const SIDE_SERIES: ReadonlySet<string> = new Set([
  "misc",
  "pop",
  "tk",
  "mc",
]);

/** The key of the last folder, which holds the sets with no known era. */
export const OTHER_ERA = "other";
export const OTHER_ERA_NAME = "Other sets";

/** The newest first order of two ISO dates; a missing date goes after every date. */
function newestFirst(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  if (a == b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a < b ? 1 : -1;
}

function byName(a: CatalogSet, b: CatalogSet): number {
  return (
    a.set_name.localeCompare(b.set_name, "en", { sensitivity: "base" }) ||
    a.set_id.localeCompare(b.set_id)
  );
}

/** Whether any set names its era. Without one (a catalog not imported since eras were added) the picker stays a flat list. */
export function hasEras(sets: readonly CatalogSet[]): boolean {
  return sets.some((entry) => entry.series_id != null);
}

/**
 * Groups sets into era folders. Main eras run newest first, by the latest release date among their sets (a folder with
 * no dated set after the dated ones, then by name), then the side series (SIDE_SERIES) the same way, and the folder of
 * sets with no known era comes last. Inside a
 * folder the newest release is first, then by name.
 */
export function groupSetsByEra(sets: readonly CatalogSet[]): SetEra[] {
  const eras = new Map<string, SetEra>();
  for (const entry of sets) {
    const known = entry.series_id != null;
    const key = known ? entry.series_id! : OTHER_ERA;
    let era = eras.get(key);
    if (!era) {
      era = {
        key,
        name: known ? (entry.series_name ?? entry.series_id!) : OTHER_ERA_NAME,
        sets: [],
      };
      eras.set(key, era);
    }
    era.sets.push(entry);
  }
  const newest = (era: SetEra) =>
    era.sets.reduce<string | null>(
      (latest, entry) =>
        entry.release_date != null &&
        (latest === null || entry.release_date > latest)
          ? entry.release_date
          : latest,
      null
    );
  for (const era of eras.values()) {
    era.sets.sort(
      (a, b) => newestFirst(a.release_date, b.release_date) || byName(a, b)
    );
  }
  const rank = (era: SetEra) =>
    era.key === OTHER_ERA ? 2 : SIDE_SERIES.has(era.key) ? 1 : 0;
  return [...eras.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      newestFirst(newest(a), newest(b)) ||
      a.name.localeCompare(b.name, "en", { sensitivity: "base" })
  );
}

/** The folder holding a set, if it has a known era; the folder to open first. */
export function eraKeyOf(entry: CatalogSet | null): string | null {
  return entry ? (entry.series_id ?? OTHER_ERA) : null;
}
