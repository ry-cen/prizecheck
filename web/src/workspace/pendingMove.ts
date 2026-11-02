/** Account-scoped recovery, following the Scan Tray: IDs and quantities only, never names or art.
 * Each operation has its own key so concurrent tabs cannot overwrite another operation's recovery. */
import { RecoveryBlocked, type HeldOperation } from "./moveOperation";

export const pendingMovePrefix = (owner: string) =>
  `prizecheck:mixed-move:v1:${encodeURIComponent(owner)}:`;
type StoragePort = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem" | "key" | "length"
>;
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const optionalTime = (v: unknown) =>
  v === undefined || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const optionalToken = (v: unknown) => v === undefined || string(v);
const count = (v: unknown) => string(v) && /^[1-9][0-9]*$/.test(v);
function validHeld(v: unknown): v is HeldOperation {
  if (!object(v) || !object(v.op) || !object(v.state)) return false;
  const { op, state } = v;
  const stage = (v: unknown) =>
    ["todo", "done", "unknown", "refused"].includes(String(v));
  return (
    string(op.id) &&
    typeof op.createdAt === "number" &&
    Number.isFinite(op.createdAt) &&
    optionalTime(op.serverCreatedAt) &&
    optionalTime(state.lastServerTime) &&
    optionalTime(state.lastServerDate) &&
    (state.revision === undefined ||
      (Number.isSafeInteger(state.revision) && Number(state.revision) >= 0)) &&
    [
      state.borrowedFirstAttempt,
      state.borrowedAttempt,
      state.ownedFirstAttempt,
      state.ownedAttempt,
    ].every(optionalToken) &&
    object(op.target) &&
    op.target.kind === "move" &&
    string(op.target.destinationId) &&
    op.noUndo === true &&
    string(op.borrowedKey) &&
    string(op.ownedKey) &&
    typeof op.stayed === "number" &&
    op.stayed >= 0 &&
    Array.isArray(op.owned) &&
    op.owned.every(
      (v) =>
        object(v) &&
        string(v.source_id) &&
        string(v.edition_id) &&
        count(v.quantity) &&
        Number.isInteger(v.expected_version)
    ) &&
    Array.isArray(op.borrowed) &&
    op.borrowed.every(
      (v) =>
        object(v) &&
        string(v.loan_id) &&
        string(v.edition_id) &&
        string(v.from_location_id) &&
        count(v.quantity)
    ) &&
    (state.manifestId === null || string(state.manifestId)) &&
    (state.manifestAttempted === undefined ||
      typeof state.manifestAttempted === "boolean") &&
    typeof state.staged === "boolean" &&
    typeof state.borrowedAttempted === "boolean" &&
    typeof state.ownedAttempted === "boolean" &&
    stage(state.borrowed) &&
    stage(state.owned) &&
    (state.borrowed !== "done" ||
      op.borrowed.length === 0 ||
      (object(state.borrowedResult) &&
        string(state.borrowedResult.copy_count) &&
        Number.isInteger(state.borrowedResult.owner_revision))) &&
    (state.owned !== "done" ||
      op.owned.length === 0 ||
      (object(state.ownedResult) &&
        string(state.ownedResult.copy_count) &&
        Number.isInteger(state.ownedResult.owner_revision) &&
        (state.ownedResult.undo_id === null ||
          string(state.ownedResult.undo_id)))) &&
    (!state.ownedAttempted || string(state.manifestId)) &&
    (state.refusal === undefined ||
      (object(state.refusal) &&
        ["borrowed", "owned"].includes(String(state.refusal.stage)) &&
        Number.isInteger(state.refusal.status) &&
        string(state.refusal.code) &&
        optionalToken(state.refusal.attemptId)))
  );
}

export const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type Terminal = {
  kind: "done" | "refused" | "reviewed";
  at: number;
  id: string;
};

/** Called only by the account's Web Lock holder; still reject stale or regressive snapshots. */
export function mergePending(
  previous: HeldOperation,
  incoming: HeldOperation
): HeldOperation {
  if (JSON.stringify(previous.op) !== JSON.stringify(incoming.op))
    throw new RecoveryBlocked();
  const a = previous.state,
    b = incoming.state;
  if (a.manifestId && b.manifestId && a.manifestId !== b.manifestId)
    throw new RecoveryBlocked();
  const state = {
    ...b,
    revision: Math.max(a.revision ?? 0, b.revision ?? 0),
    manifestId: a.manifestId ?? b.manifestId,
    manifestAttempted: !!a.manifestAttempted || !!b.manifestAttempted,
    staged: a.staged || b.staged,
    borrowedAttempted: a.borrowedAttempted || b.borrowedAttempted,
    ownedAttempted: a.ownedAttempted || b.ownedAttempted,
    blocked: !!a.blocked || !!b.blocked,
    lastServerDate:
      Math.max(a.lastServerDate ?? 0, b.lastServerDate ?? 0) || undefined,
    lastServerTime:
      Math.max(a.lastServerTime ?? 0, b.lastServerTime ?? 0) || undefined,
  };
  for (const stage of ["borrowed", "owned"] as const) {
    const result = stage === "borrowed" ? "borrowedResult" : "ownedResult";
    const first =
      stage === "borrowed" ? "borrowedFirstAttempt" : "ownedFirstAttempt";
    if (a[first] && b[first] && a[first] !== b[first])
      throw new RecoveryBlocked();
    state[first] = a[first] ?? b[first];
    const current = stage === "borrowed" ? "borrowedAttempt" : "ownedAttempt";
    state[current] =
      (b.revision ?? 0) < (a.revision ?? 0)
        ? a[current]
        : (b[current] ?? a[current]);
    if (
      a[result] &&
      b[result] &&
      JSON.stringify(a[result]) !== JSON.stringify(b[result])
    )
      throw new RecoveryBlocked();
    // Avoid union-index assignment: each receipt retains its own generated response type.
    if (stage === "borrowed")
      state.borrowedResult = a.borrowedResult ?? b.borrowedResult;
    else state.ownedResult = a.ownedResult ?? b.ownedResult;
    if (a[stage] === "refused" && b[result]) throw new RecoveryBlocked();
    const attempted =
      stage === "borrowed" ? state.borrowedAttempted : state.ownedAttempted;
    state[stage] =
      a[stage] === "done" || a[stage] === "refused"
        ? a[stage]
        : b[stage] === "done"
          ? "done"
          : a[stage] === "unknown" || attempted
            ? "unknown"
            : b[stage] === "refused"
              ? a[stage]
              : b[stage];
  }
  state.refusal = a.refusal;
  if (!state.refusal && b.refusal) {
    const stage = b.refusal.stage;
    const first =
      stage === "borrowed"
        ? state.borrowedFirstAttempt
        : state.ownedFirstAttempt;
    const latest =
      stage === "borrowed" ? state.borrowedAttempt : state.ownedAttempt;
    const attempted =
      stage === "borrowed" ? state.borrowedAttempted : state.ownedAttempted;
    if (
      attempted &&
      (!first || b.refusal.attemptId !== first || latest !== first)
    )
      throw new RecoveryBlocked();
    if (state[stage] !== "done") {
      state.refusal = b.refusal;
      state[stage] = "refused";
    }
  }
  return { op: previous.op, state };
}

function knownTerminal(held: HeldOperation): boolean {
  const s = held.state;
  if (!s.refusal) return s.borrowed === "done" && s.owned === "done";
  return (
    (!s.borrowedAttempted ||
      s.borrowed === "done" ||
      s.borrowed === "refused") &&
    (!s.ownedAttempted || s.owned === "done" || s.owned === "refused")
  );
}

export function pendingMoves(
  owner: string,
  storage: StoragePort = localStorage,
  witness: StoragePort = sessionStorage
) {
  const prefix = pendingMovePrefix(owner);
  const key = (held: HeldOperation) => prefix + held.op.id;
  const witnessKey = prefix + "witness";
  const established = new Set<string>();
  const witnesses = (): string[] => {
    const value: unknown = JSON.parse(witness.getItem(witnessKey) ?? "[]");
    if (!Array.isArray(value) || !value.every(string))
      throw new RecoveryBlocked();
    return value;
  };
  const remember = (id: string) => {
    const value = JSON.stringify([...new Set([...witnesses(), id])]);
    witness.setItem(witnessKey, value);
    if (witness.getItem(witnessKey) !== value) throw new RecoveryBlocked();
  };
  const forget = (id: string) =>
    witness.setItem(
      witnessKey,
      JSON.stringify(witnesses().filter((v) => v !== id))
    );
  const read = (name: string) => {
    const value: unknown = JSON.parse(storage.getItem(name) ?? "null");
    if (!object(value) || value.owner !== owner || value.v !== 1)
      throw new RecoveryBlocked();
    if (value.terminal !== undefined) {
      const t = value.terminal;
      if (
        !object(t) ||
        !["done", "refused", "reviewed"].includes(String(t.kind)) ||
        !string(t.id) ||
        name !== prefix + t.id ||
        typeof t.at !== "number" ||
        !Number.isFinite(t.at) ||
        !(
          validHeld(value.held) ||
          (t.kind === "reviewed" && value.held === null)
        )
      )
        throw new RecoveryBlocked();
      if (
        t.kind !== "reviewed" &&
        (!validHeld(value.held) || !knownTerminal(value.held))
      )
        throw new RecoveryBlocked();
      return {
        held: value.held as HeldOperation | null,
        terminal: t as Terminal,
      };
    }
    if (!validHeld(value.held) || name !== key(value.held))
      throw new RecoveryBlocked();
    return { held: value.held, terminal: null };
  };
  const names = () =>
    Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(
      (v): v is string => !!v?.startsWith(prefix)
    );
  const load = (): HeldOperation | null => {
    const found: HeldOperation[] = [],
      seen = new Set<string>();
    for (const name of names()) {
      const record = read(name);
      const id = name.slice(prefix.length);
      seen.add(id);
      if (record.terminal) {
        forget(id);
        established.delete(id);
        continue;
      }
      const held = record.held!;
      remember(id);
      established.add(id);
      // Client timestamps from the earlier format cannot establish a safe age after reload.
      if (held.op.serverCreatedAt === undefined) held.state.blocked = true;
      if (held.state.refusal) {
        const r = held.state.refusal,
          s = held.state;
        const attempted =
          r.stage === "owned" ? s.ownedAttempted : s.borrowedAttempted;
        const first =
          r.stage === "owned" ? s.ownedFirstAttempt : s.borrowedFirstAttempt;
        const latest = r.stage === "owned" ? s.ownedAttempt : s.borrowedAttempt;
        if (attempted && (!first || r.attemptId !== first || latest !== first))
          s.blocked = true;
      }
      found.push(held);
    }
    if (witnesses().some((id) => !seen.has(id))) throw new RecoveryBlocked();
    return found.sort((a, b) => a.op.createdAt - b.op.createdAt)[0] ?? null;
  };
  const write = (
    name: string,
    held: HeldOperation | null,
    terminal?: Terminal
  ) => {
    const value = JSON.stringify({
      v: 1,
      owner,
      held,
      ...(terminal ? { terminal } : {}),
    });
    storage.setItem(name, value);
    if (storage.getItem(name) !== value) throw new RecoveryBlocked();
  };
  return {
    load,
    save(held: HeldOperation) {
      const existing = storage.getItem(key(held));
      if (existing === null && established.has(held.op.id))
        throw new RecoveryBlocked();
      if (existing !== null) {
        const record = read(key(held));
        if (record.terminal || !record.held) throw new RecoveryBlocked();
        Object.assign(held.state, mergePending(record.held, held).state);
      }
      held.state.revision = (held.state.revision ?? 0) + 1;
      remember(held.op.id);
      write(key(held), held);
      established.add(held.op.id);
    },
    adopt() {
      /* load already establishes each read record. */
    },
    remove(
      held: HeldOperation,
      kind: Terminal["kind"] = held.state.refusal ? "refused" : "done",
      serverNow = held.state.lastServerDate ?? held.op.serverCreatedAt
    ) {
      if (serverNow === undefined || !Number.isFinite(serverNow))
        throw new RecoveryBlocked();
      const existing = storage.getItem(key(held));
      if (existing === null) throw new RecoveryBlocked();
      const record = read(key(held));
      if (record.terminal) {
        forget(held.op.id);
        return;
      }
      const merged = mergePending(record.held!, held);
      if (kind !== "reviewed" && !knownTerminal(merged))
        throw new RecoveryBlocked();
      write(key(held), merged, { kind, at: serverNow, id: held.op.id });
      forget(held.op.id);
      established.delete(held.op.id);
    },
    dismissUnreadable(serverNow: number) {
      if (!Number.isFinite(serverNow)) throw new RecoveryBlocked();
      const ids = new Set([
        ...witnesses(),
        ...names().map((name) => name.slice(prefix.length)),
      ]);
      for (const id of ids) {
        try {
          const record = read(prefix + id);
          if (record.terminal) forget(id);
          // Readable pending operations and their receipts are not part of an unreadable-data dismissal.
          continue;
        } catch {
          write(prefix + id, null, { kind: "reviewed", at: serverNow, id });
          forget(id);
        }
      }
    },
    prune(serverNow: number) {
      // Only the writer calls this, after a fresh trusted response. Late witnesses fail closed after retention.
      for (const name of names()) {
        const record = read(name);
        if (
          record.terminal &&
          serverNow - record.terminal.at >= TERMINAL_RETENTION_MS
        ) {
          forget(record.terminal.id);
          storage.removeItem(name);
        }
      }
    },
  };
}

export function recoveryText(
  held: HeldOperation | null,
  place: string,
  blocked: boolean,
  otherTab = false
): string {
  const n = held?.state.borrowedResult?.copy_count;
  const own = held?.state.ownedResult?.copy_count;
  const lead = own
    ? `Moved ${Number(n ?? 0) + Number(own)} copies to ${place}. `
    : n
      ? `Moved ${n} borrowed ${n === "1" ? "copy" : "copies"} to ${place}. `
      : "";
  if (otherTab)
    return (
      lead +
      "A Move is in progress in another tab. Check availability before continuing."
    );
  if (!blocked && held?.state.refusal)
    return (
      lead +
      "This Move was refused before that step changed any copies. Check Move to close this notice."
    );
  if (!blocked && (own || (n && held?.op.owned.length === 0)))
    return lead + "This Move finished. Check Move to close this notice.";
  return (
    lead +
    (blocked
      ? "This Move needs review. Check the source and destination Location contents before dismissing. This Move will not be repeated."
      : "A Move still needs checking. Some copies may have moved. Check this Move before starting another.")
  );
}
