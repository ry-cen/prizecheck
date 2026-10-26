// The Scan Tray's data layer (D8, D10, D11, D12): a per-account tray in localStorage that survives reloads, enforces
// its caps on every edit, marks stale rows and confirms through the save route with a retry-safe key. There is no
// screen here. The tray holds Printing ids, Edition ids and counts only: never photos, names, images, prices or scores.
import {
  ScannerError,
  resolveScannerPrintings,
  saveScannerTray,
  type ScanSave,
  type ScanSaveChangedEdition,
  type ScanSaveResult,
  type ScannerPrinting,
} from "../../scanner_generated";
import type { OutcomeReason } from "../worker/messages";

// ---------------------------------------------------------------------------------------------------------------
// Schema and limits

export type TrayRow = {
  id: string; // row identity for the UI
  printing_id: string;
  edition_id: string; // never null; a stale row keeps its old id
  count: number; // 1..999
  candidates: string[]; // up to 3 printing ids, printing_id first
  needs_pick: boolean;
};

export type PendingSave = {
  key: string;
  location_id: string;
  items: [edition_id: string, quantity: string][]; // exactly what was sent
  started_at: string;
};

export type TrayV1 = {
  v: 1;
  location_id: string | null; // null = Unsorted, resolved by the screen through the locations API
  rows: TrayRow[]; // newest first
  pending_save: PendingSave | null;
  updated_at: string;
};

export const MAX_DISTINCT_EDITIONS = 200;
export const MAX_ROWS = 400;
export const MAX_ROW_COUNT = 999;
export const MAX_EDITION_COUNT = 9999;
export const MAX_CANDIDATES = 3;
export const PRINTINGS_TIMEOUT_MS = 5000;
export const PRINTINGS_CHUNK = 100;
/** A pending save older than this is not retried: the server's 30-day receipt may be about to expire. */
export const PENDING_SAVE_MAX_AGE_MS = 29 * 24 * 60 * 60 * 1000;

export const trayKey = (userId: string) =>
  `prizecheck:scanner:tray:v1:${userId}`;
export const trayLockName = (userId: string) =>
  `prizecheck:scanner:tray:${userId}`;

export const emptyTray = (now = new Date(0).toISOString()): TrayV1 => ({
  v: 1,
  location_id: null,
  rows: [],
  pending_save: null,
  updated_at: now,
});

// ---------------------------------------------------------------------------------------------------------------
// Reading storage

const isString = (x: unknown): x is string => typeof x === "string";

function validRow(x: unknown): x is TrayRow {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    isString(r.id) &&
    isString(r.printing_id) &&
    isString(r.edition_id) &&
    Number.isInteger(r.count) &&
    (r.count as number) >= 1 &&
    (r.count as number) <= MAX_ROW_COUNT &&
    Array.isArray(r.candidates) &&
    r.candidates.every(isString) &&
    typeof r.needs_pick === "boolean"
  );
}

function validPending(x: unknown): x is PendingSave {
  if (typeof x !== "object" || x === null) return false;
  const p = x as Record<string, unknown>;
  return (
    isString(p.key) &&
    isString(p.location_id) &&
    isString(p.started_at) &&
    Array.isArray(p.items) &&
    p.items.every(
      (i) =>
        Array.isArray(i) && i.length === 2 && isString(i[0]) && isString(i[1])
    )
  );
}

/** A tray over its caps, or a row with more than 3 candidates, is not one this code wrote: unparseable. */
function withinCaps(rows: TrayRow[]): boolean {
  if (rows.length > MAX_ROWS) return false;
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (r.candidates.length > MAX_CANDIDATES) return false;
    totals.set(r.edition_id, (totals.get(r.edition_id) ?? 0) + r.count);
  }
  if (totals.size > MAX_DISTINCT_EDITIONS) return false;
  return [...totals.values()].every((n) => n <= MAX_EDITION_COUNT);
}

/** Parses a stored value. Anything unparseable or of an unknown version is "no tray" (null). */
export function parseTray(raw: string | null): TrayV1 | null {
  if (raw === null) return null;
  try {
    const t = JSON.parse(raw) as Record<string, unknown> | null;
    if (typeof t !== "object" || t === null || t.v !== 1) return null;
    if (!Array.isArray(t.rows) || !t.rows.every(validRow)) return null;
    if (t.location_id !== null && !isString(t.location_id)) return null;
    if (t.pending_save !== null && !validPending(t.pending_save)) return null;
    if (!withinCaps(t.rows as TrayRow[])) return null;
    return {
      v: 1,
      location_id: t.location_id as string | null,
      rows: t.rows as TrayRow[],
      pending_save: t.pending_save as PendingSave | null,
      updated_at: isString(t.updated_at)
        ? t.updated_at
        : emptyTray().updated_at,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The cap check

export type TrayEdit =
  /** A lock, suggestion pick or search pick that starts a row. */
  | { type: "add_row"; edition_id: string; count?: number }
  /** A repeat lock, count increase or decrease. `count` is the new count. */
  | { type: "set_count"; row_id: string; count: number }
  /** A chip change, a needs-pick resolution, or a search pick that replaces a row's Edition. */
  | { type: "set_edition"; row_id: string; edition_id: string };

export type TrayEditVerdict = "ok" | "full" | "row_limit" | "edition_limit";

/**
 * Whether an edit may be written. Pure; the store calls it inside the lock before every write.
 * `full`: it would make a 201st distinct Edition. `row_limit`: it would make a 401st row.
 * `full` also covers a row over 999 copies (spec story 39 groups it with the full-tray message). `edition_limit`: one Edition over 9999 copies in total.
 * An edit that does not raise anything (lowering a count, a chip change to an Edition already present) is "ok".
 */
export function trayEditAllowed(tray: TrayV1, edit: TrayEdit): TrayEditVerdict {
  let rows = tray.rows;
  let addsRow = false;
  if (edit.type === "add_row") {
    rows = [
      ...rows,
      {
        id: "",
        printing_id: "",
        edition_id: edit.edition_id,
        count: edit.count ?? 1,
        candidates: [],
        needs_pick: false,
      },
    ];
    addsRow = true;
  } else if (edit.type === "set_count") {
    rows = rows.map((r) =>
      r.id === edit.row_id ? { ...r, count: edit.count } : r
    );
  } else {
    rows = rows.map((r) =>
      r.id === edit.row_id ? { ...r, edition_id: edit.edition_id } : r
    );
  }
  const totals = new Map<string, number>();
  for (const r of rows)
    totals.set(r.edition_id, (totals.get(r.edition_id) ?? 0) + r.count);
  if (
    totals.size > MAX_DISTINCT_EDITIONS &&
    totals.size > distinctEditions(tray.rows)
  )
    return "full";
  if (addsRow && rows.length > MAX_ROWS) return "row_limit";
  const touched = new Set<string>();
  if (edit.type === "add_row" || edit.type === "set_edition")
    touched.add(edit.edition_id);
  if (edit.type === "set_count") {
    const row = tray.rows.find((r) => r.id === edit.row_id);
    if (row && edit.count > row.count) touched.add(row.edition_id);
    if (row && edit.count > MAX_ROW_COUNT && edit.count > row.count)
      return "full";
  }
  if (edit.type === "add_row" && (edit.count ?? 1) > MAX_ROW_COUNT)
    return "full";
  for (const id of touched)
    if ((totals.get(id) ?? 0) > MAX_EDITION_COUNT) return "edition_limit";
  return "ok";
}

const distinctEditions = (rows: TrayRow[]) =>
  new Set(rows.map((r) => r.edition_id)).size;

/** True while a save's outcome is unknown: the tray is read-only. */
export const isFrozen = (tray: TrayV1) => tray.pending_save !== null;

/** Rows that resolve to one Edition become one save item, counts summed, in first-seen order. */
export function mergeItems(rows: TrayRow[]): [string, string][] {
  const totals = new Map<string, number>();
  for (const r of rows)
    totals.set(r.edition_id, (totals.get(r.edition_id) ?? 0) + r.count);
  return [...totals].map(([id, n]) => [id, String(n)]);
}

// ---------------------------------------------------------------------------------------------------------------
// The store

/** What an edit method answers. "frozen": a save is pending. "no_row": the row is gone. "invalid": a bad count. */
export type EditResult = TrayEditVerdict | "frozen" | "no_row" | "invalid";

export type LockResult = {
  added: boolean;
  /** Matches the worker's `lockOutcome`: send `{ t: "lockOutcome", lockId, added, reason }`. */
  reason?: OutcomeReason;
  /** Why a "full" outcome was refused, for choosing the message; "frozen" while a save is pending. */
  verdict?: Exclude<EditResult, "ok">;
  row?: TrayRow;
};

export type ConfirmResult =
  | { kind: "saved"; result: ScanSaveResult }
  | { kind: "blocked"; reason: "empty" | "needs_pick" }
  /** The key was reused with other items; unfrozen, a new key is made on the next Confirm. */
  | { kind: "key_reused" }
  /** Saved-unknown: unfrozen, rows kept; show the stale-save note. */
  | { kind: "stale_save" }
  /** Rows kept, the destination is cleared (Unsorted): reopen the picker. */
  | { kind: "destination_changed" }
  /** Exactly these rows are now needs_pick; `searchRowIds` are those whose Edition the catalog never had. */
  | { kind: "editions_changed"; rowIds: string[]; searchRowIds: string[] }
  /** A definite refusal below 500 that has no special handling (a bug or QUANTITY_OVERFLOW): unfrozen. */
  | { kind: "failed"; code: string }
  /** A network error or 5xx: still frozen; Retry calls confirm again with the same key and items. */
  | { kind: "pending"; code: string | null };

export type RefreshResult = "ok" | "offline" | "empty";

export type TrayState = {
  tray: TrayV1;
  /** Display data fetched this session, by Printing id; never stored. */
  printings: ReadonlyMap<string, ScannerPrinting>;
  /** The last printings call failed: render from the cached card table, disable chips and Confirm. */
  offline: boolean;
  /** A save older than 29 days (or one the server cannot replay) was dropped; show the stale-save note. */
  staleSaveNote: boolean;
};

export type TrayDeps = {
  storage?: Pick<Storage, "getItem" | "setItem">;
  locks?: { request<T>(name: string, cb: () => Promise<T>): Promise<T> } | null;
  /** Gets "storage" events (default: window). */
  events?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
  now?: () => number;
  randomUUID?: () => string;
  resolvePrintings?: typeof resolveScannerPrintings;
  save?: typeof saveScannerTray;
  /** Called after a write takes the tray from no rows to some: #317 calls `requestPersistOnce()` here. */
  onFirstRowAdded?: () => void;
};

export type TrayStore = {
  readonly userId: string;
  getState(): TrayState;
  /** useSyncExternalStore-compatible: `getState` is referentially stable between changes. */
  subscribe(listener: () => void): () => void;
  /** Re-reads storage (also done on the `storage` event) and drops a 29-day-old pending save. */
  reload(): Promise<void>;
  dispose(): void;

  /** A recognizer lock or Scan Suggestion yes: up to 3 printing ids, best first. */
  applyLock(printingIds: string[]): Promise<LockResult>;
  /** A Scan Suggestion pick: `printingId` must itself resolve; `others` fill the row's candidates. */
  applyPick(printingId: string, others?: string[]): Promise<LockResult>;
  /** A catalog search pick: the explicit Edition the collector chose. With `replaceRowId` it replaces that row's
   * Printing and Edition and clears needs_pick, keeping its count. */
  applySearchPick(pick: {
    printingId: string;
    editionId: string;
    replaceRowId?: string;
  }): Promise<EditResult>;
  /** Chip change; also resolves a needs_pick row. */
  setEdition(rowId: string, editionId: string): Promise<EditResult>;
  /** Sets a row's count (1..999). A count of 0 is "invalid": call removeRow. */
  setCount(rowId: string, count: number): Promise<EditResult>;
  removeRow(rowId: string): Promise<EditResult>;
  /** Clear tray. */
  clear(): Promise<EditResult>;
  /** The destination chosen in the picker; null = Unsorted. */
  setLocation(locationId: string | null): Promise<EditResult>;
  /** On tray open, and on `online`: calls the printings route for every row, marking stale rows. */
  refreshStale(): Promise<RefreshResult>;
  /** Confirm into a Storage Leaf, or retry a pending save with its own key (the argument is then ignored). */
  confirm(locationId: string): Promise<ConfirmResult>;
  dismissStaleSaveNote(): void;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

const refuse = (verdict: Exclude<EditResult, "ok">): LockResult => ({
  added: false,
  reason: "full",
  verdict,
});

/** Opens one account's tray: reads it, drops a stale pending save and starts listening for other tabs. */
export async function openTray(
  userId: string,
  deps: TrayDeps = {}
): Promise<TrayStore> {
  const storage = deps.storage ?? localStorage;
  const now = deps.now ?? Date.now;
  const uuid = deps.randomUUID ?? (() => crypto.randomUUID());
  const resolvePrintings = deps.resolvePrintings ?? resolveScannerPrintings;
  const save = deps.save ?? saveScannerTray;
  const key = trayKey(userId);
  const lockName = trayLockName(userId);

  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(cb: () => Promise<T>): Promise<T> => {
    const locks =
      deps.locks !== undefined
        ? deps.locks
        : typeof navigator !== "undefined"
          ? ((navigator as { locks?: TrayDeps["locks"] }).locks ?? null)
          : null;
    if (locks) return locks.request(lockName, cb);
    // No Web Locks: at least serialise this tab's writers.
    const next = chain.then(cb, cb);
    chain = next.catch(() => undefined);
    return next;
  };

  let state: TrayState = {
    tray: parseTray(storage.getItem(key)) ?? emptyTray(),
    printings: new Map<string, ScannerPrinting>(),
    offline: false,
    staleSaveNote: false,
  };
  const listeners = new Set<() => void>();
  const setState = (patch: Partial<TrayState>) => {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  };
  /** Display data is swapped, never mutated, so a snapshot a screen holds stays valid. */
  const addPrintings = (list: Iterable<ScannerPrinting>) => {
    const next = new Map(state.printings);
    for (const p of list) next.set(p.id, p);
    setState({ printings: next });
  };
  const readTray = () => parseTray(storage.getItem(key)) ?? emptyTray();

  /** One read-modify-write under the Web Lock. `fn` returns the next tray (null = leave it) and a value. */
  const mutate = <T>(
    fn: (tray: TrayV1) => { tray: TrayV1 | null; value: T }
  ): Promise<T> =>
    withLock(async () => {
      const before = readTray();
      const out = fn(before);
      if (out.tray) {
        const next = { ...out.tray, updated_at: new Date(now()).toISOString() };
        storage.setItem(key, JSON.stringify(next));
        setState({ tray: next });
        if (before.rows.length === 0 && next.rows.length > 0)
          deps.onFirstRowAdded?.();
      } else if (
        before !== state.tray &&
        JSON.stringify(before) !== JSON.stringify(state.tray)
      ) {
        setState({ tray: before });
      }
      return out.value;
    });

  const dropStalePending = (tray: TrayV1): TrayV1 | null => {
    const p = tray.pending_save;
    if (!p) return null;
    const started = Date.parse(p.started_at);
    // A start time that does not parse counts as expired.
    if (!Number.isFinite(started) || now() - started > PENDING_SAVE_MAX_AGE_MS)
      return { ...tray, pending_save: null };
    return null;
  };

  const editRow = (
    rowId: string,
    edit: (row: TrayRow, tray: TrayV1) => TrayRow | null,
    verdictFor?: (tray: TrayV1) => TrayEditVerdict
  ): Promise<EditResult> =>
    mutate((tray) => {
      if (isFrozen(tray)) return { tray: null, value: "frozen" as EditResult };
      const row = tray.rows.find((r) => r.id === rowId);
      if (!row) return { tray: null, value: "no_row" as EditResult };
      const verdict = verdictFor?.(tray) ?? "ok";
      if (verdict !== "ok") return { tray: null, value: verdict };
      const changed = edit(row, tray);
      const rows = tray.rows.flatMap((r) =>
        r.id === rowId ? (changed ? [changed] : []) : [r]
      );
      return { tray: { ...tray, rows }, value: "ok" as EditResult };
    });

  const lookup = async (ids: string[]) => {
    try {
      const answer = await withTimeout(
        resolvePrintings(ids),
        PRINTINGS_TIMEOUT_MS
      );
      addPrintings(answer.printings);
      setState({ offline: false });
      return answer.printings;
    } catch {
      setState({ offline: true });
      return null;
    }
  };

  async function lock(
    ids: string[],
    strictFirst: boolean
  ): Promise<LockResult> {
    const wanted = [...new Set(ids)].slice(0, MAX_CANDIDATES);
    if (wanted.length === 0) return { added: false, reason: "unresolved" };
    const current = state.tray;
    if (isFrozen(current)) return refuse("frozen");
    // A copy to an existing row is checked before the network wait. This guesses that the first candidate is the
    // Printing that will resolve; if it does not, the check inside the lock after the answer is the real one, so a
    // wrong guess only costs an early "full" for a card that would have gone to a different, resolvable Printing.
    const existing = current.rows.find((r) => r.printing_id === wanted[0]);
    if (existing) {
      const v = trayEditAllowed(current, {
        type: "set_count",
        row_id: existing.id,
        count: existing.count + 1,
      });
      if (v !== "ok") return refuse(v);
    }
    const found = await lookup(wanted);
    if (found === null) return { added: false, reason: "offline" };
    const byId = new Map(found.map((p) => [p.id, p]));
    const resolvable = wanted.filter((id) => byId.get(id)?.default_edition_id);
    const chosenId = strictFirst
      ? resolvable[0] === wanted[0]
        ? wanted[0]
        : undefined
      : resolvable[0];
    if (chosenId === undefined) return { added: false, reason: "unresolved" };
    const editionId = byId.get(chosenId)!.default_edition_id!;
    const candidates = [
      chosenId,
      ...resolvable.filter((id) => id !== chosenId),
    ].slice(0, MAX_CANDIDATES);
    return mutate<LockResult>((tray) => {
      if (isFrozen(tray)) return { tray: null, value: refuse("frozen") };
      const newest = tray.rows.find((r) => r.printing_id === chosenId);
      if (newest) {
        const v = trayEditAllowed(tray, {
          type: "set_count",
          row_id: newest.id,
          count: newest.count + 1,
        });
        if (v !== "ok") return { tray: null, value: refuse(v) };
        const row = { ...newest, count: newest.count + 1 };
        return {
          tray: {
            ...tray,
            rows: tray.rows.map((r) => (r.id === row.id ? row : r)),
          },
          value: { added: true, row },
        };
      }
      const v = trayEditAllowed(tray, {
        type: "add_row",
        edition_id: editionId,
      });
      if (v !== "ok") return { tray: null, value: refuse(v) };
      const row: TrayRow = {
        id: uuid(),
        printing_id: chosenId,
        edition_id: editionId,
        count: 1,
        candidates,
        needs_pick: false,
      };
      return {
        tray: { ...tray, rows: [row, ...tray.rows] },
        value: { added: true, row },
      };
    });
  }

  const onStorage = (event: Event) => {
    const k = (event as StorageEvent).key;
    if (k !== null && k !== undefined && k !== key) return;
    setState({ tray: readTray() });
  };
  const events =
    deps.events !== undefined
      ? deps.events
      : typeof window !== "undefined"
        ? window
        : null;
  events?.addEventListener("storage", onStorage);

  const store: TrayStore = {
    userId,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async reload() {
      const dropped = await mutate((tray) => {
        const next = dropStalePending(tray);
        return { tray: next, value: next !== null };
      });
      if (dropped) setState({ staleSaveNote: true });
      else setState({ tray: readTray() });
    },
    dispose() {
      events?.removeEventListener("storage", onStorage);
      listeners.clear();
    },

    applyLock: (ids) => lock(ids, false),
    applyPick: (printingId, others = []) => lock([printingId, ...others], true),

    async applySearchPick({ printingId, editionId, replaceRowId }) {
      return mutate<EditResult>((tray) => {
        if (isFrozen(tray)) return { tray: null, value: "frozen" };
        if (replaceRowId === undefined) {
          const v = trayEditAllowed(tray, {
            type: "add_row",
            edition_id: editionId,
          });
          if (v !== "ok") return { tray: null, value: v };
          const row: TrayRow = {
            id: uuid(),
            printing_id: printingId,
            edition_id: editionId,
            count: 1,
            candidates: [printingId],
            needs_pick: false,
          };
          return { tray: { ...tray, rows: [row, ...tray.rows] }, value: "ok" };
        }
        const target = tray.rows.find((r) => r.id === replaceRowId);
        if (!target) return { tray: null, value: "no_row" };
        const v = trayEditAllowed(tray, {
          type: "set_edition",
          row_id: replaceRowId,
          edition_id: editionId,
        });
        if (v !== "ok") return { tray: null, value: v };
        const row: TrayRow = {
          ...target,
          printing_id: printingId,
          edition_id: editionId,
          candidates: [printingId],
          needs_pick: false,
        };
        return {
          tray: {
            ...tray,
            rows: tray.rows.map((r) => (r.id === row.id ? row : r)),
          },
          value: "ok",
        };
      });
    },

    setEdition: (rowId, editionId) =>
      editRow(
        rowId,
        (row) => ({ ...row, edition_id: editionId, needs_pick: false }),
        (tray) =>
          trayEditAllowed(tray, {
            type: "set_edition",
            row_id: rowId,
            edition_id: editionId,
          })
      ),

    async setCount(rowId, count) {
      if (!Number.isInteger(count) || count < 1) return "invalid";
      return editRow(
        rowId,
        (row) => ({ ...row, count }),
        (tray) =>
          trayEditAllowed(tray, { type: "set_count", row_id: rowId, count })
      );
    },

    removeRow: (rowId) => editRow(rowId, () => null),

    clear: () =>
      mutate<EditResult>((tray) =>
        isFrozen(tray)
          ? { tray: null, value: "frozen" }
          : { tray: { ...tray, rows: [] }, value: "ok" }
      ),

    setLocation: (locationId) =>
      mutate<EditResult>((tray) =>
        isFrozen(tray)
          ? { tray: null, value: "frozen" }
          : { tray: { ...tray, location_id: locationId }, value: "ok" }
      ),

    async refreshStale() {
      const ids = [...new Set(state.tray.rows.map((r) => r.printing_id))];
      if (ids.length === 0) return "empty";
      // Only rows for these Printings were asked about; a row added while the call was out is not judged.
      const queried = new Set(ids);
      const found = new Map<string, ScannerPrinting>();
      try {
        for (let i = 0; i < ids.length; i += PRINTINGS_CHUNK) {
          const answer = await withTimeout(
            resolvePrintings(ids.slice(i, i + PRINTINGS_CHUNK)),
            PRINTINGS_TIMEOUT_MS
          );
          for (const p of answer.printings) found.set(p.id, p);
        }
      } catch {
        // An outage marks no row.
        setState({ offline: true });
        return "offline";
      }
      addPrintings(found.values());
      setState({ offline: false });
      await mutate((tray) => {
        let changed = false;
        const rows = tray.rows.map((r) => {
          if (!queried.has(r.printing_id)) return r;
          const p = found.get(r.printing_id);
          const stale =
            !p || !p.editions.some((e) => e.id === r.edition_id && e.active);
          if (stale && !r.needs_pick) {
            changed = true;
            return { ...r, needs_pick: true };
          }
          return r;
        });
        // A save in flight keeps the tray read-only; marking rows would not change what was sent.
        return {
          tray: changed && !isFrozen(tray) ? { ...tray, rows } : null,
          value: undefined,
        };
      });
      return "ok";
    },

    async confirm(locationId) {
      type Prepared =
        | { ok: true; pending: PendingSave }
        | { ok: false; result: ConfirmResult };
      const prepared = await mutate<Prepared>((tray) => {
        const dropped = dropStalePending(tray);
        if (dropped) {
          setState({ staleSaveNote: true });
          return {
            tray: dropped,
            value: { ok: false, result: { kind: "stale_save" } },
          };
        }
        if (tray.pending_save)
          return {
            tray: null,
            value: { ok: true, pending: tray.pending_save },
          };
        if (tray.rows.length === 0)
          return {
            tray: null,
            value: { ok: false, result: { kind: "blocked", reason: "empty" } },
          };
        if (tray.rows.some((r) => r.needs_pick))
          return {
            tray: null,
            value: {
              ok: false,
              result: { kind: "blocked", reason: "needs_pick" },
            },
          };
        const pending: PendingSave = {
          key: uuid(),
          location_id: locationId,
          items: mergeItems(tray.rows),
          started_at: new Date(now()).toISOString(),
        };
        return {
          tray: { ...tray, location_id: locationId, pending_save: pending },
          value: { ok: true, pending },
        };
      });
      if (!prepared.ok) return prepared.result;
      const { pending } = prepared;
      const body: ScanSave = {
        location_id: pending.location_id,
        idempotency_key: pending.key,
        items: pending.items.map(([edition_id, quantity]) => ({
          edition_id,
          quantity,
        })),
      };
      const settle = (
        fn: (tray: TrayV1) => TrayV1,
        result: ConfirmResult | ((tray: TrayV1) => ConfirmResult)
      ): Promise<ConfirmResult> =>
        mutate((tray) => {
          // Only settle our own save; another tab may already have.
          const next = tray.pending_save?.key === pending.key ? fn(tray) : null;
          // A computed result reads the same tray that is marked.
          return {
            tray: next,
            value: typeof result === "function" ? result(next ?? tray) : result,
          };
        });
      const unfreeze = (tray: TrayV1): TrayV1 => ({
        ...tray,
        pending_save: null,
      });
      try {
        const result = await save(body);
        return await settle(
          (tray) => ({ ...tray, rows: [], pending_save: null }),
          { kind: "saved", result }
        );
      } catch (error) {
        if (!(error instanceof ScannerError) || error.status >= 500)
          return {
            kind: "pending",
            code: error instanceof ScannerError ? error.code : null,
          };
        switch (error.code) {
          case "IDEMPOTENCY_KEY_REUSED":
            return settle(unfreeze, { kind: "key_reused" });
          case "REPLAY_OUTCOME_UNAVAILABLE":
            setState({ staleSaveNote: true });
            return settle(unfreeze, { kind: "stale_save" });
          case "DESTINATION_CHANGED":
            return settle((t) => ({ ...unfreeze(t), location_id: null }), {
              kind: "destination_changed",
            });
          case "EDITIONS_CHANGED": {
            const listed = Array.isArray(error.detail.editions)
              ? (error.detail.editions as ScanSaveChangedEdition[])
              : [];
            const ids = new Set(listed.map((e) => e.edition_id));
            const never = new Set(
              listed
                .filter((e) => e.printing_id === null)
                .map((e) => e.edition_id)
            );
            return settle(
              (tray) => ({
                ...unfreeze(tray),
                rows: tray.rows.map((r) =>
                  ids.has(r.edition_id) ? { ...r, needs_pick: true } : r
                ),
              }),
              (tray) => ({
                kind: "editions_changed",
                rowIds: tray.rows
                  .filter((r) => ids.has(r.edition_id))
                  .map((r) => r.id),
                searchRowIds: tray.rows
                  .filter((r) => never.has(r.edition_id))
                  .map((r) => r.id),
              })
            );
          }
          default:
            return settle(unfreeze, { kind: "failed", code: error.code });
        }
      }
    },

    dismissStaleSaveNote: () => setState({ staleSaveNote: false }),
  };

  await store.reload();
  return store;
}
