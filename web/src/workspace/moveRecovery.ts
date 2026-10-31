/** One writer across this account's workspace tabs. No fallback mutex for mixed Moves. */
import {
  PENDING_MOVE_MAX_AGE_MS,
  RecoveryBlocked,
  type HeldOperation,
} from "./moveOperation";
export class MoveInAnotherTab extends Error {}
export class MoveLocksUnavailable extends Error {}
export const moveLockName = (owner: string) =>
  `prizecheck:mixed-move:${encodeURIComponent(owner)}`;
export const moveActivityKey = (owner: string) =>
  `${moveLockName(owner)}:activity`;
export type MoveLocks = Pick<LockManager, "request" | "query">;
function browserLocks(): MoveLocks | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.locks;
}
export async function withMoveWriter<T>(
  owner: string,
  work: () => Promise<T>,
  locks = browserLocks()
): Promise<T> {
  if (!locks) throw new MoveLocksUnavailable();
  const announce = () => {
    try {
      localStorage.setItem(moveActivityKey(owner), crypto.randomUUID());
    } catch {
      /* The operation's own persistence check is authoritative. */
    }
  };
  let acquired = false;
  try {
    return await locks.request(
      moveLockName(owner),
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) throw new MoveInAnotherTab();
        acquired = true;
        announce();
        return work();
      }
    );
  } finally {
    // This notification runs after the browser has released the lock.
    if (acquired) announce();
  }
}
export async function moveWriterBusy(
  owner: string,
  locks = browserLocks()
): Promise<boolean> {
  if (!locks) return false;
  return !!(await locks.query()).held?.some(
    (lock) => lock.name === moveLockName(owner)
  );
}

/** Node's same-origin gateway emits Date; /auth/session is no-store. Missing/unreadable Date is not a clock.
 * HTTP Date has one-second resolution. The monotonic anchor and persisted high-water mark never go backwards. */
export class MoveServerClock {
  private anchor: { server: number; mono: number; observed: number } | null =
    null;
  constructor(private monotonic = () => performance.now()) {}
  observe(response: Response, requestStarted = this.monotonic()): number {
    const date = response.headers.get("date");
    const server = date ? Date.parse(date) : NaN;
    const mono = this.monotonic();
    const roundTrip = mono - requestStarted;
    if (
      !Number.isFinite(server) ||
      !Number.isFinite(mono) ||
      !Number.isFinite(roundTrip) ||
      roundTrip < 0
    )
      throw new RecoveryBlocked();
    const previous = this.anchor ? this.now() : server;
    if (this.anchor && server + 2000 < this.anchor.observed)
      throw new RecoveryBlocked();
    const value = Math.max(server + roundTrip, previous);
    this.anchor = {
      server: value,
      mono,
      observed: Math.max(server, this.anchor?.observed ?? server),
    };
    return value;
  }
  serverDate(): number {
    if (!this.anchor) throw new RecoveryBlocked();
    return this.anchor.observed;
  }
  now(): number {
    if (!this.anchor) throw new RecoveryBlocked();
    const elapsed = this.monotonic() - this.anchor.mono;
    if (!Number.isFinite(elapsed) || elapsed < 0) throw new RecoveryBlocked();
    return this.anchor.server + elapsed;
  }
  check(
    held: HeldOperation,
    response: Response,
    requestStarted = this.monotonic()
  ): number {
    const server = this.observe(response, requestStarted);
    const created = held.op.serverCreatedAt;
    const previous = held.state.lastServerTime;
    const previousDate = held.state.lastServerDate;
    if (
      created === undefined ||
      this.serverDate() + 2000 < created ||
      (previousDate !== undefined && this.serverDate() + 2000 < previousDate)
    )
      throw new RecoveryBlocked();
    const now = Math.max(server, previous ?? created);
    held.state.lastServerTime = now;
    held.state.lastServerDate = Math.max(
      this.serverDate(),
      previousDate ?? this.serverDate()
    );
    if (now < created || now - created >= PENDING_MOVE_MAX_AGE_MS)
      throw new RecoveryBlocked();
    return now;
  }
}
