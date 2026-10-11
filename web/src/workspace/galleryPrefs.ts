import { useEffect, useState } from "react";
import type { CardCategory, ElementalType } from "../collection_generated";
import {
  CATEGORY_OPTIONS,
  DEFAULT_DISPLAY,
  DEFAULT_SORT,
  ELEMENTAL_TYPES,
  NO_FILTERS,
  SORT_OPTIONS,
  type DisplayPrefs,
  type GalleryFilters,
  type GallerySort,
} from "./galleryModel";

/** What the workspace remembers in this browser for each signed-in user: sort, filter values and
 * display choices. Search text and selection are never stored. */
export type GalleryPrefs = {
  sort: GallerySort;
  filters: GalleryFilters;
  display: DisplayPrefs;
};

export const DEFAULT_PREFS: GalleryPrefs = {
  sort: DEFAULT_SORT,
  filters: NO_FILTERS,
  display: DEFAULT_DISPLAY,
};

/** The longest set id the listing accepts. */
const MAX_SET_ID = 80;

export const prefsStorageKey = (userId: string) =>
  `prizecheck:workspace:preferences:v1:${userId}`;

const fields = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Stored preferences, field by field: anything missing, unknown or malformed takes its default,
 * and unknown keys are ignored (ticket 111 adds `display.prices`). */
export function parsePrefs(raw: string | null): GalleryPrefs {
  let stored: Record<string, unknown> = {};
  try {
    stored = fields(JSON.parse(raw ?? "null"));
  } catch {
    stored = {};
  }
  const filters = fields(stored.filters);
  const display = fields(stored.display);
  const set =
    typeof filters.set === "string" && filters.set.length <= MAX_SET_ID
      ? filters.set.trim()
      : "";
  return {
    sort: SORT_OPTIONS.some((option) => option.value === stored.sort)
      ? (stored.sort as GallerySort)
      : DEFAULT_SORT,
    filters: {
      set,
      category: CATEGORY_OPTIONS.some(
        (option) => option.value === filters.category
      )
        ? (filters.category as CardCategory)
        : "",
      type: ELEMENTAL_TYPES.some((type) => type === filters.type)
        ? (filters.type as ElementalType)
        : "",
    },
    display: {
      size: display.size === "medium" ? "medium" : "small",
      names: display.names === true,
    },
  };
}

/** The text to store: the known preferences written over whatever is stored now, so keys a newer
 * release added (at the top level, in `filters` or in `display`) survive this release's write. */
export function mergePrefs(raw: string | null, prefs: GalleryPrefs): string {
  let stored: Record<string, unknown> = {};
  try {
    stored = fields(JSON.parse(raw ?? "null"));
  } catch {
    stored = {};
  }
  return JSON.stringify({
    ...stored,
    ...prefs,
    filters: { ...fields(stored.filters), ...prefs.filters },
    display: { ...fields(stored.display), ...prefs.display },
  });
}

function readPrefs(userId: string): GalleryPrefs {
  try {
    return parsePrefs(window.localStorage.getItem(prefsStorageKey(userId)));
  } catch {
    return DEFAULT_PREFS;
  }
}

/** The signed-in user's gallery preferences. They are read before the first render, so the first
 * listing request already uses them, and every change is written back. When storage is unavailable
 * (private mode, quota) they last only for this visit. */
export function useGalleryPrefs(userId: string) {
  const [prefs, setPrefs] = useState<GalleryPrefs>(() => readPrefs(userId));
  useEffect(() => {
    try {
      const key = prefsStorageKey(userId);
      window.localStorage.setItem(
        key,
        mergePrefs(window.localStorage.getItem(key), prefs)
      );
    } catch {
      /* Preferences stay in memory for this visit. */
    }
  }, [userId, prefs]);
  return [prefs, setPrefs] as const;
}
