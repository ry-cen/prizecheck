import { Pool } from "pg";

// Every database operation of native sign-in runs here, on its own small pool and behind admission, so an unauthenticated
// flood of native requests can neither queue SQL on the web sign-in pool (auth.ts), nor wait on the web limiter's global
// advisory lock (rateLimits.ts), nor starve the other native operations. The pool is created only while NATIVE_SIGN_IN=on.
// It adds NATIVE_POOL_MAX connections to the gateway's PostgreSQL total (the other pools add 4 + 4 + 4 and the shared pool's
// default 10); the repository states no max_connections budget, so nothing else changes.
//
// Admission, per class, counts operations in flight plus waiting. Over the cap an operation is refused before any SQL is
// queued (NativeUnavailable, a 503). A slot is held until the database work SETTLES, never merely until the HTTP answer's
// deadline: a caller that gives up at RESPONSE_DEADLINE_MS still occupies its slot while its query runs, so abandoned work
// cannot pile up beyond the cap. The pool's own timeouts (2 s connect, statement, query and lock) bound that work.
//
// Numbers, for a pool of two connections:
//   read     (bearer lookup, unauthenticated, high volume)  4 held, 1 running: one connection at most, three wait in memory
//   revoke   (sign-out)                                      2 held, 2 running
//   exchange (limiter, then the one-transaction code swap)  2 held, 2 running; the two steps run one after the other and
//                                                            never hold two connections, so there is no checkout deadlock
//   approve  (limiter, then the grant write)                 2 held, 2 running; the same
// Reads can therefore never hold the second connection, which stays free for revocation, exchange and consent.
export const NATIVE_POOL_MAX = 2;
export const NATIVE_QUERY_TIMEOUT_MS = 2_000;
export const RESPONSE_DEADLINE_MS = 2_500;

export type NativeClass = "read" | "revoke" | "exchange" | "approve";
export type NativeLimits = Record<
  NativeClass,
  { held: number; running: number }
>;
export const NATIVE_LIMITS: NativeLimits = {
  read: { held: 4, running: 1 },
  revoke: { held: 2, running: 2 },
  exchange: { held: 2, running: 2 },
  approve: { held: 2, running: 2 },
};

/** The native database is busy or slow: the gateway answers 503, never a cookie fallback, and says nothing more. */
export class NativeUnavailable extends Error {
  constructor() {
    super("native database unavailable");
    this.name = "NativeUnavailable";
  }
}

export type NativeDb = Pick<Pool, "query" | "connect">;

export type NativeStore = {
  /** Runs `work` on the native pool in `kind`'s admission class. `work` takes and releases its own client. */
  run: <T>(kind: NativeClass, work: (db: NativeDb) => Promise<T>) => Promise<T>;
  /** One query in `kind`'s class. */
  rows: <T>(kind: NativeClass, text: string, values: unknown[]) => Promise<T[]>;
};

export function createNativePool(connectionString: string | undefined): Pool {
  return new Pool({
    connectionString,
    max: NATIVE_POOL_MAX,
    connectionTimeoutMillis: NATIVE_QUERY_TIMEOUT_MS,
    statement_timeout: NATIVE_QUERY_TIMEOUT_MS,
    query_timeout: NATIVE_QUERY_TIMEOUT_MS,
    lock_timeout: NATIVE_QUERY_TIMEOUT_MS,
    idle_in_transaction_session_timeout: 5_000,
    application_name: "prizecheck-native",
  });
}

class Gate {
  held = 0;
  running = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(
    private readonly heldMax: number,
    private readonly runningMax: number
  ) {}

  /** Takes a slot and a place to run, or throws before anything is queued. `cancel` gives a queued place back. */
  enter(): { ready: Promise<void>; cancel: () => void } {
    if (this.held >= this.heldMax) throw new NativeUnavailable();
    this.held += 1;
    if (this.running < this.runningMax) {
      this.running += 1;
      return { ready: Promise.resolve(), cancel: () => {} };
    }
    let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => (release = resolve));
    this.waiting.push(release);
    return {
      ready,
      cancel: () => {
        const at = this.waiting.indexOf(release);
        if (at >= 0) {
          this.waiting.splice(at, 1);
          this.held -= 1;
        }
      },
    };
  }

  leave() {
    this.held -= 1;
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

export function createNativeStore(
  db: NativeDb,
  options: { limits?: NativeLimits; deadlineMs?: number } = {}
): NativeStore {
  const limits = options.limits ?? NATIVE_LIMITS;
  const deadlineMs = options.deadlineMs ?? RESPONSE_DEADLINE_MS;
  const gates = Object.fromEntries(
    (Object.keys(limits) as NativeClass[]).map((kind) => [
      kind,
      new Gate(limits[kind].held, limits[kind].running),
    ])
  ) as Record<NativeClass, Gate>;

  async function run<T>(
    kind: NativeClass,
    work: (db: NativeDb) => Promise<T>
  ): Promise<T> {
    const gate = gates[kind];
    const place = gate.enter();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NativeUnavailable()), deadlineMs);
    });
    // The work, once it has a place to run. Its slot goes back when it settles, however long that takes.
    const started = place.ready.then(() => work(db));
    started.then(
      () => gate.leave(),
      () => gate.leave()
    );
    // A place still queued when the deadline passes is given back and its work never starts.
    let queued = true;
    place.ready.then(() => (queued = false));
    try {
      return await Promise.race([started, deadline]);
    } catch (error) {
      if (queued) {
        place.cancel();
        // The work chain above would start `work` if the place were ever granted; it is not, as cancel removed it.
      }
      throw error instanceof NativeUnavailable
        ? error
        : new NativeUnavailable();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    run,
    rows: <T>(kind: NativeClass, text: string, values: unknown[]) =>
      run(kind, async (pool) => (await pool.query(text, values)).rows as T[]),
  };
}
