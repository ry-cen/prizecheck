import { Pool } from "pg";

// The native credential operations that need no web session (a bearer lookup, a sign-out) run on their own small pool, not
// the shared web-auth pool, and behind a cap on the operations in flight or waiting. A request over the cap is refused
// before any SQL is queued, and a slow database ends a query after about two seconds, so an unauthenticated flood of
// well-formed bearers can hold at most NATIVE_POOL_MAX connections for that long and never touches the pool that sign-in and
// every other route use. Only created while NATIVE_SIGN_IN=on. It adds NATIVE_POOL_MAX to the gateway's PostgreSQL
// connections (the other pools add up to 4 + 4 + 4 + the shared pool's default 10); the repository states no
// max_connections budget, so nothing else changes.
export const NATIVE_POOL_MAX = 2;
export const NATIVE_QUERY_TIMEOUT_MS = 2_000;
// Two running, four waiting. Anything more is refused at once.
export const NATIVE_IN_FLIGHT_LIMIT = 6;

/** The credential database is busy or slow: the gateway answers 503 and never falls back to the cookie. */
export class NativeUnavailable extends Error {
  constructor() {
    super("native credential store unavailable");
    this.name = "NativeUnavailable";
  }
}

export type NativeStore = {
  rows: <T>(text: string, values: unknown[]) => Promise<T[]>;
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
  });
}

/**
 * Runs queries on `pool` with at most `limit` in flight or waiting. The slot is taken before the query is issued and given
 * back on every path (result, error, timeout), so the count cannot leak. A query that has not answered after
 * `timeoutMs` is abandoned here and left to the pool's own timeouts.
 */
export function createNativeStore(
  pool: Pick<Pool, "query">,
  limit = NATIVE_IN_FLIGHT_LIMIT,
  timeoutMs = NATIVE_QUERY_TIMEOUT_MS + 500
): NativeStore {
  let held = 0;
  return {
    async rows<T>(text: string, values: unknown[]) {
      if (held >= limit) throw new NativeUnavailable();
      held += 1;
      let timer: NodeJS.Timeout | undefined;
      try {
        const query = Promise.resolve(pool.query(text, values));
        // An abandoned query that fails later must not become an unhandled rejection.
        query.catch(() => {});
        const result = await Promise.race([
          query,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new NativeUnavailable()),
              timeoutMs
            );
          }),
        ]);
        return (result as { rows: T[] }).rows;
      } catch (error) {
        if (error instanceof NativeUnavailable) throw error;
        throw new NativeUnavailable();
      } finally {
        if (timer) clearTimeout(timer);
        held -= 1;
      }
    },
  };
}
