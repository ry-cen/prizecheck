/** Account-scoped recovery, following the Scan Tray: IDs and quantities only, never names or art.
 * Each operation has its own key so concurrent tabs cannot overwrite another operation's recovery. */
import {
  PENDING_MOVE_MAX_AGE_MS,
  RecoveryBlocked,
  type HeldOperation,
} from "./moveOperation";

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
        string(state.refusal.code)))
  );
}

export function pendingMoves(
  owner: string,
  storage: StoragePort = localStorage,
  witness: StoragePort = sessionStorage
) {
  const prefix = pendingMovePrefix(owner);
  const key = (held: HeldOperation) => prefix + held.op.id;
  let established = false;
  const witnessKey = prefix + "witness";
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
  const load = (): HeldOperation | null => {
    const found: HeldOperation[] = [];
    for (let i = 0; i < storage.length; i++) {
      const name = storage.key(i);
      if (!name?.startsWith(prefix)) continue;
      const parsed: unknown = JSON.parse(storage.getItem(name) ?? "null");
      if (
        !object(parsed) ||
        parsed.owner !== owner ||
        parsed.v !== 1 ||
        !validHeld(parsed.held) ||
        name !== key(parsed.held)
      )
        throw new RecoveryBlocked();
      found.push(parsed.held);
    }
    if (witnesses().some((id) => !found.some((v) => v.op.id === id)))
      throw new RecoveryBlocked();
    for (const held of found) {
      remember(held.op.id);
      if (
        !held.state.refusal &&
        (held.state.borrowed !== "done" || held.state.owned !== "done") &&
        (Date.now() < held.op.createdAt ||
          Date.now() - held.op.createdAt >= PENDING_MOVE_MAX_AGE_MS)
      )
        held.state.blocked = true;
    }
    return found.sort((a, b) => a.op.createdAt - b.op.createdAt)[0] ?? null;
  };
  return {
    load,
    save(held: HeldOperation) {
      // Losing an established record must never become permission to start afresh.
      if (established && storage.getItem(key(held)) === null)
        throw new RecoveryBlocked();
      const value = JSON.stringify({
        v: 1,
        owner,
        held,
        updatedAt: Date.now(),
      });
      remember(held.op.id);
      storage.setItem(key(held), value);
      if (storage.getItem(key(held)) !== value) throw new RecoveryBlocked();
      established = true;
    },
    adopt() {
      established = true;
    },
    remove(held: HeldOperation) {
      forget(held.op.id);
      storage.removeItem(key(held));
      if (storage.getItem(key(held)) !== null) throw new RecoveryBlocked();
      established = false;
    },
    dismissUnreadable() {
      witness.removeItem(witnessKey);
      const keys = Array.from({ length: storage.length }, (_, i) =>
        storage.key(i)
      );
      for (const name of keys)
        if (name?.startsWith(prefix)) storage.removeItem(name);
    },
  };
}

export function recoveryText(
  held: HeldOperation | null,
  place: string,
  blocked: boolean
): string {
  const n = held?.state.borrowedResult?.copy_count;
  const own = held?.state.ownedResult?.copy_count;
  const lead = own
    ? `Moved ${Number(n ?? 0) + Number(own)} copies to ${place}. `
    : n
      ? `Moved ${n} borrowed ${n === "1" ? "copy" : "copies"} to ${place}. `
      : "";
  if (!blocked && held?.state.refusal)
    return (
      lead +
      "This Move was refused before that step changed any copies. Check Move to close this notice."
    );
  if (!blocked && (own || (n && held?.op.owned.length === 0)))
    return lead + "This Move finished. Check Move to close this notice.";
  if (!blocked && n && !held?.state.ownedAttempted)
    return lead + "Your own copies haven't moved. Check Move to continue.";
  return (
    lead +
    (blocked
      ? "This Move needs review. Check the source and destination Location contents before dismissing. This Move will not be repeated."
      : "A Move still needs checking. Some copies may have moved. Check this Move before starting another.")
  );
}
