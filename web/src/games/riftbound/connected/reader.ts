import {
  CatalogReadError,
  type CatalogReader,
  type CatalogSet,
  type Edition,
  type Page,
  type Query,
} from "../catalog";
import {
  getRiftboundCatalogSets,
  getRiftboundEdition,
  listRiftboundEditions,
  RiftboundCatalogError,
  type CatalogEdition,
} from "../catalog_generated";
import { UNSPECIFIED_VARIANT } from "../../../ui/variantLabel";

export const MAX_SEARCH = 120;
export const MAX_SET = 80;
export const MAX_PAGE = 100000;

/** The collector-facing name of a finish key; an unknown key is made readable, never shown raw. */
export function finishLabel(key: string): string {
  if (key === "normal") return "Normal";
  if (key === "foil") return "Foil";
  if (key === "unspecified") return UNSPECIFIED_VARIANT;
  const words = key.split(/[_\-\s]+/).filter(Boolean);
  return words.length
    ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")
    : UNSPECIFIED_VARIANT;
}

/** The API serves no domain, type or orientation yet, so none is invented. */
export function toEdition(api: CatalogEdition): Edition {
  return {
    id: api.id,
    printingId: api.printing_id,
    name: api.name,
    set: { id: api.set.id, name: api.set.name, code: api.set.code },
    number: api.number,
    finish: finishLabel(api.finish),
    art: api.art ?? null,
    domain: null,
    type: null,
    orientation: null,
  };
}

function failure(error: unknown, signal: AbortSignal): unknown {
  if (
    signal.aborted ||
    (error as { name?: string } | null)?.name === "AbortError"
  )
    return error;
  if (error instanceof CatalogReadError) return error;
  if (error instanceof RiftboundCatalogError) {
    if (error.status === 401 || error.status === 403)
      return new CatalogReadError("denied");
    if (error.status === 422) return new CatalogReadError("invalid");
  }
  return new CatalogReadError("unavailable");
}

async function guarded<T>(run: () => Promise<T>, signal: AbortSignal) {
  try {
    return await run();
  } catch (error) {
    throw failure(error, signal);
  }
}

const hasNul = (value: string) => value.includes("\u0000");
// The API counts Unicode code points (Pydantic max_length), not UTF-16 code units, so an astral character is one.
const length = (value: string) => {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
};

export function connectedReader(): CatalogReader {
  return {
    scope: "riftbound",
    facets: false,
    sets: (signal) =>
      guarded(async () => {
        const sets = await getRiftboundCatalogSets(signal);
        return sets.map((s): CatalogSet => ({
          id: s.id,
          name: s.name,
          code: s.code,
        }));
      }, signal),
    list: (query: Query, signal): Promise<Page> =>
      guarded(async () => {
        const search = query.search.replaceAll("\u0000", "").trim();
        if (length(search) > MAX_SEARCH) throw new CatalogReadError("invalid");
        const set =
          query.set.length > 0 &&
          length(query.set) <= MAX_SET &&
          !hasNul(query.set)
            ? query.set
            : undefined;
        let page = Math.min(Math.max(1, query.page), MAX_PAGE);
        const read = (p: number) =>
          listRiftboundEditions({ q: search, set, page: p }, signal);
        let result = await read(page);
        if (result.total > 0 && page > result.pages) {
          page = result.pages;
          result = await read(page);
        }
        return {
          editions: result.editions.map(toEdition),
          total: result.total,
          pages: result.pages,
          catalogEmpty: result.catalog_empty,
          page,
        };
      }, signal),
    detail: async (id, signal) => {
      if (!id) return null;
      try {
        return toEdition(await getRiftboundEdition(id, signal));
      } catch (error) {
        if (error instanceof RiftboundCatalogError && error.status === 404)
          return null;
        throw failure(error, signal);
      }
    },
  };
}
