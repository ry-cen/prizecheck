import { useRef, useState } from "react";
import type { InlineUndo } from "./useAddToast";

export const QUEUE_CLEARED = "Queue cleared.";
export type AddNotice = {
  kind: "add";
  message: string;
  undo: InlineUndo | null;
};
export type ClearNotice = { kind: "clear"; restore: () => boolean };
export type RecoveryNotice = (AddNotice | ClearNotice) & { token: number };
export type RecoveryOwner = {
  current(): RecoveryNotice | null;
  /** Retires the earlier notice and returns the new token. */
  claim(notice: AddNotice | ClearNotice): number;
  owns(token: number): boolean;
  /** Updates only the owning Add notice. */
  update(token: number, patch: Partial<Omit<AddNotice, "kind">>): boolean;
  /** A stale token does nothing; no token retires the current notice. */
  retire(token?: number): RecoveryNotice | null;
};

/** One owner for every recovery action, including handlers retained after rendering. */
export function createRecoveryOwner(
  onChange: (n: RecoveryNotice | null) => void
): RecoveryOwner {
  let seq = 0,
    held: RecoveryNotice | null = null;
  return {
    current: () => held,
    claim(notice) {
      held = { ...notice, token: ++seq };
      onChange(held);
      return seq;
    },
    owns: (token) => held?.token === token,
    update(token, patch) {
      if (held?.token !== token || held.kind !== "add") return false;
      held = { ...held, ...patch };
      onChange(held);
      return true;
    },
    retire(token) {
      if (!held || (token !== undefined && held.token !== token)) return null;
      const gone = held;
      held = null;
      onChange(null);
      return gone;
    },
  };
}

/** Stable methods use the current owner; notice mirrors it for rendering only. */
export function useRecoveryNotice(): RecoveryOwner & {
  notice: RecoveryNotice | null;
} {
  const [notice, setNotice] = useState<RecoveryNotice | null>(null);
  const owner = useRef<
    (RecoveryOwner & { notice: RecoveryNotice | null }) | null
  >(null);
  if (!owner.current)
    owner.current = { ...createRecoveryOwner(setNotice), notice };
  owner.current.notice = notice;
  return owner.current;
}
