import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { normalizeIp } from "./caller.js";

// Durable limits on OAuth account creation and on sign-in and link starts (OAuth spec #147, "Account creation limits").
// The pattern is the email-send limiter's (allowedSend in server.ts): one transaction under a global advisory lock, so
// checks serialize across gateway replicas, and the IP is stored only as a sha256 key. A permitted check records one
// auth_rate_event row and prunes rows older than two days; a refusal records nothing and counts too_many_sign_ups.
// Never an in-memory limiter: it would reset per replica.

export const SIGNUPS_PER_IP_PER_DAY = 10;
export const STARTS_PER_IP_PER_HOUR = 60;
export const NATIVE_APPROVES_PER_IP_PER_HOUR = 20;
export const NATIVE_TOKENS_PER_IP_PER_HOUR = 30;
const DEFAULT_DAILY_SIGNUP_CAP = 100;
// Taken: 914701 allowedSend (server.ts), 914702/914703 catalog dispatch/runner, 914705 publications, 914706 public catalog drain,
// 914707 format standing, 914710-914714, 914720 and 914790 in the API; 914708 is the native limiter below.
const RATE_EVENT_LOCK = 914704;
// The native sign-in limits (NATIVE_SIGN_IN only) serialize on their own key, on their own pool, so a flood of native
// requests can never queue behind or in front of the web sign-in limits' lock.
const NATIVE_RATE_EVENT_LOCK = 914708;

/** DAILY_SIGNUP_CAP: app-wide OAuth account creations per rolling day, default 100. Anything else is a startup error. */
export function dailySignupCap(env: NodeJS.ProcessEnv = process.env): number {
  const value = (env.DAILY_SIGNUP_CAP ?? "").trim();
  if (value === "") return DEFAULT_DAILY_SIGNUP_CAP;
  if (!/^\d{1,9}$/.test(value))
    throw new Error("DAILY_SIGNUP_CAP must be a whole number");
  return Number(value);
}

/** The stored key: sha256 of the normalized address, so one IPv6 /64 is one client. */
export function ipKey(ip: string): string {
  return createHash("sha256").update(normalizeIp(ip)).digest("hex");
}

type Db = Pick<Pool, "query" | "connect">;

async function countRefusal(pool: Db): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO operations_counter(name,count) VALUES('too_many_sign_ups',1)
      ON CONFLICT(name) DO UPDATE SET count=operations_counter.count+1,updated_at=now()`
    );
  } catch {
    console.error("Operational counter unavailable");
  }
}

async function admit(
  pool: Db,
  kind: "signup" | "start" | "native_approve" | "native_token",
  ip: string,
  window: "24 hours" | "1 hour",
  within: (fromIp: number, total: number) => boolean,
  lock: number = RATE_EVENT_LOCK
): Promise<boolean> {
  const key = ipKey(ip);
  const client = await pool.connect();
  let permitted = false;
  let failure: Error | undefined;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [lock]);
    const { rows } = await client.query<{ from_ip: string; total: string }>(
      `SELECT
      (SELECT count(*) FROM auth_rate_event WHERE kind=$1 AND ip_key=$2 AND created_at > now()-$3::interval) AS from_ip,
      (CASE WHEN $1='signup' THEN (SELECT count(*) FROM auth_rate_event WHERE kind=$1 AND created_at > now()-$3::interval) ELSE 0 END) AS total`,
      [kind, key, window]
    );
    permitted = within(Number(rows[0].from_ip), Number(rows[0].total));
    if (permitted) {
      await client.query(
        "INSERT INTO auth_rate_event(kind,ip_key) VALUES($1,$2)",
        [kind, key]
      );
      await client.query(
        "DELETE FROM auth_rate_event WHERE created_at < now()-interval '2 days'"
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
  // The native limits are not sign-up refusals: they leave the too_many_sign_ups counter alone.
  if (!permitted && (kind === "signup" || kind === "start"))
    await countRefusal(pool);
  return permitted;
}

export type RateLimits = {
  /** One OAuth account creation from `ip`: at most 10 per IP and `dailyCap` in all, per rolling day. */
  allowSignup: (ip: string) => Promise<boolean>;
  /** One sign-in or link start from `ip`: at most 60 per IP per rolling hour. */
  allowStart: (ip: string) => Promise<boolean>;
};

export function createRateLimits(pool: Pool, dailyCap: number): RateLimits {
  return {
    allowSignup: (ip) =>
      admit(
        pool,
        "signup",
        ip,
        "24 hours",
        (fromIp, total) => fromIp < SIGNUPS_PER_IP_PER_DAY && total < dailyCap
      ),
    allowStart: (ip) =>
      admit(
        pool,
        "start",
        ip,
        "1 hour",
        (fromIp) => fromIp < STARTS_PER_IP_PER_HOUR
      ),
  };
}

export type NativeRateLimits = {
  /** One native consent approval from `ip`: at most 20 per IP per rolling hour. Runs on the db it is given (the native pool). */
  allowNativeApprove: (db: Db, ip: string) => Promise<boolean>;
  /** One native code exchange from `ip`: at most 30 per IP per rolling hour. */
  allowNativeToken: (db: Db, ip: string) => Promise<boolean>;
};

/** The same persisted per-IP limits as before, in the same table, under the native lock key and on the caller's connection. */
export function createNativeRateLimits(): NativeRateLimits {
  return {
    allowNativeApprove: (db, ip) =>
      admit(
        db,
        "native_approve",
        ip,
        "1 hour",
        (fromIp) => fromIp < NATIVE_APPROVES_PER_IP_PER_HOUR,
        NATIVE_RATE_EVENT_LOCK
      ),
    allowNativeToken: (db, ip) =>
      admit(
        db,
        "native_token",
        ip,
        "1 hour",
        (fromIp) => fromIp < NATIVE_TOKENS_PER_IP_PER_HOUR,
        NATIVE_RATE_EVENT_LOCK
      ),
  };
}
