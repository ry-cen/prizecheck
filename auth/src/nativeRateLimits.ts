import { ipKey } from "./rateLimits.js";
import type { NativeDb } from "./nativeStore.js";

// The native sign-in limits (NATIVE_SIGN_IN only): consents and code exchanges per trusted IP, persisted as sha256 keys in
// their own table, native_rate_event, and serialized under their own advisory lock, on the native pool. Nothing here shares
// a table, lock or pool with the web sign-in limits (rateLimits.ts, auth_rate_event), so a flood of native requests cannot
// delay a web sign-in start and the other way round. A permitted check records one row and prunes rows older than two days;
// a refusal records nothing.
//
// Advisory lock keys taken: 914701 allowedSend (server.ts), 914702/914703 catalog dispatch/runner, 914704 the web sign-in
// limits (rateLimits.ts), 914705 publications, 914706 public catalog drain, 914707 format standing, 914708 this limiter,
// 914710-914714, 914720 and 914790 in the API.
const NATIVE_RATE_EVENT_LOCK = 914708;

export const NATIVE_APPROVES_PER_IP_PER_HOUR = 20;
export const NATIVE_TOKENS_PER_IP_PER_HOUR = 30;

export type NativeRateLimits = {
  /** One native consent approval from `ip`: at most 20 per IP per rolling hour. Runs on the db it is given (the native pool). */
  allowNativeApprove: (db: NativeDb, ip: string) => Promise<boolean>;
  /** One native code exchange from `ip`: at most 30 per IP per rolling hour. */
  allowNativeToken: (db: NativeDb, ip: string) => Promise<boolean>;
};

async function admit(
  db: NativeDb,
  kind: "approve" | "token",
  ip: string,
  max: number
): Promise<boolean> {
  const key = ipKey(ip);
  const client = await db.connect();
  let permitted = false;
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      NATIVE_RATE_EVENT_LOCK,
    ]);
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM native_rate_event WHERE kind=$1 AND ip_key=$2 AND created_at > now()-interval '1 hour'`,
      [kind, key]
    );
    permitted = rows[0].n < max;
    if (permitted) {
      await client.query(
        "INSERT INTO native_rate_event(kind,ip_key) VALUES($1,$2)",
        [kind, key]
      );
      await client.query(
        "DELETE FROM native_rate_event WHERE created_at < now()-interval '2 days'"
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    failure = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    // A failed connection is destroyed rather than returned to the pool.
    client.release(failure);
  }
  return permitted;
}

export function createNativeRateLimits(): NativeRateLimits {
  return {
    allowNativeApprove: (db, ip) =>
      admit(db, "approve", ip, NATIVE_APPROVES_PER_IP_PER_HOUR),
    allowNativeToken: (db, ip) =>
      admit(db, "token", ip, NATIVE_TOKENS_PER_IP_PER_HOUR),
  };
}
