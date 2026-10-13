import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { walkSignIn } from "../testing/oauth-fake/walk.js";
import {
  OWNER,
  PLACEHOLDER_CREDENTIALS,
  freePort,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

// The creation and start limits (#155) on a local-public deployment, through the real gateway and the OAuth test fake.
// The tests run in order on one database and share its few creatable identities, so each one resets auth_rate_event.
let gateway: TestGateway;
let ipKey = "";
beforeAll(async () => {
  gateway = await startGateway({ env: { SIGNUP_MODE: "local-public" } });
}, 60_000);
afterAll(() => gateway?.stop(), 30_000);
beforeEach(async () => {
  await gateway.pool.query("DELETE FROM auth_rate_event");
});

const count = async (sql: string, values: unknown[] = []) =>
  (await gateway.pool.query(sql, values)).rows[0].n as number;
const users = (email: string) =>
  count('SELECT count(*)::int AS n FROM "user" WHERE email=$1', [email]);
const signups = () =>
  count("SELECT count(*)::int AS n FROM auth_rate_event WHERE kind='signup'");
/** Adds `n` recent rows of `kind` for `key` ('' gives each row its own key). */
const seed = (kind: string, key: string, n: number, age = "0 seconds") =>
  gateway.pool.query(
    `INSERT INTO auth_rate_event(kind,ip_key,created_at)
     SELECT $1, CASE WHEN $2='' THEN 'other-'||g ELSE $2 END, now()-$4::interval FROM generate_series(1,$3) g`,
    [kind, key, n, age]
  );
const TOO_MANY =
  "/sign-in?provider=google&error=too_many_sign_ups&error_description=too_many_sign_ups";

it("allows 10 account creations per trusted IP per day and refuses the 11th, writing nothing", async () => {
  const first = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "newcomer"
  );
  expect(first.location).toBe("/collection");
  // The gateway hashes the IP itself; read its key instead of hashing here.
  ipKey = (
    await gateway.pool.query(
      "SELECT ip_key FROM auth_rate_event WHERE kind='signup'"
    )
  ).rows[0].ip_key;
  expect(ipKey).toMatch(/^[0-9a-f]{64}$/);
  await seed("signup", ipKey, 9);
  const refused = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "different-email"
  );
  expect(refused.location).toBe(TOO_MANY);
  expect(refused.jar.has("better-auth.session_token")).toBe(false);
  expect(await users("owner.elsewhere@example.test")).toBe(0);
  expect(await signups()).toBe(10);
  // Day-old rows don't count: with one of them aged out, the tenth creation in the day is allowed.
  await gateway.pool.query(
    `UPDATE auth_rate_event SET created_at=now()-interval '25 hours'
     WHERE id=(SELECT min(id) FROM auth_rate_event WHERE kind='signup')`
  );
  const allowed = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "different-email"
  );
  expect(allowed.location).toBe("/collection");
  expect(await users("owner.elsewhere@example.test")).toBe(1);
});

it("never throttles a returning sign-in or a link by email, even over the creation limits", async () => {
  await seed("signup", ipKey, 10);
  await seed("signup", "", 100);
  const google = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "newcomer"
  );
  expect(google.location).toBe("/collection");
  const collector = (await sessionOf(gateway, google.jar)).userId;
  expect(collector).toBeTruthy();
  const discord = await walkSignIn(
    gateway.base,
    "/auth/sign-in/discord",
    "newcomer"
  );
  expect(discord.location).toBe("/collection");
  expect((await sessionOf(gateway, discord.jar)).userId).toBe(collector);
  expect(await signups()).toBe(110);
});

it("caps creations app-wide at DAILY_SIGNUP_CAP (default 100) and counts each refusal", async () => {
  const counter = () =>
    count(
      "SELECT coalesce(max(count),0)::int AS n FROM operations_counter WHERE name='too_many_sign_ups'"
    );
  const before = await counter();
  await seed("signup", "", 100);
  const refused = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner"
  );
  expect(refused.location).toBe(TOO_MANY);
  expect(await users(OWNER)).toBe(0);
  expect(await counter()).toBe(before + 1);
  await gateway.pool.query(
    "DELETE FROM auth_rate_event WHERE id=(SELECT min(id) FROM auth_rate_event WHERE kind='signup')"
  );
  const allowed = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner"
  );
  expect(allowed.location).toBe("/collection");
  expect(await users(OWNER)).toBe(1);
  expect(await signups()).toBe(100);
});

it("allows 60 sign-in starts per trusted IP per hour, then redirects with too_many_sign_ups", async () => {
  const verifications = () =>
    count("SELECT count(*)::int AS n FROM verification");
  await seed("start", ipKey, 59);
  const sixtieth = await fetch(`${gateway.base}/auth/sign-in/google`, {
    redirect: "manual",
  });
  expect(sixtieth.status).toBe(302);
  expect(
    new URL(sixtieth.headers.get("location")!, gateway.base).pathname
  ).toBe("/auth/__fake-oauth/consent");
  const before = await verifications();
  const over = await fetch(`${gateway.base}/auth/sign-in/discord?next=/decks`, {
    redirect: "manual",
  });
  expect(over.status).toBe(302);
  expect(over.headers.get("location")).toBe(
    "/sign-in?provider=discord&error=too_many_sign_ups"
  );
  expect(over.headers.getSetCookie()).toEqual([]);
  expect(await verifications()).toBe(before);
  // Starts older than an hour no longer count.
  await gateway.pool.query(
    "UPDATE auth_rate_event SET created_at=now()-interval '61 minutes' WHERE kind='start'"
  );
  const later = await fetch(`${gateway.base}/auth/sign-in/discord`, {
    redirect: "manual",
  });
  expect(new URL(later.headers.get("location")!, gateway.base).pathname).toBe(
    "/auth/__fake-oauth/consent"
  );
});

it("prunes rows older than two days whenever it writes one", async () => {
  await seed("signup", "old", 3, "49 hours");
  await seed("start", "old", 3, "3 days");
  await seed("signup", "recent", 2, "47 hours");
  await fetch(`${gateway.base}/auth/sign-in/google`, { redirect: "manual" });
  const left = await gateway.pool.query(
    "SELECT kind, ip_key FROM auth_rate_event ORDER BY kind, ip_key"
  );
  expect(left.rows).toEqual([
    { kind: "signup", ip_key: "recent" },
    { kind: "signup", ip_key: "recent" },
    { kind: "start", ip_key: ipKey },
  ]);
});

it("refuses to start with an invalid DAILY_SIGNUP_CAP", async () => {
  const child = spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
    env: {
      ...process.env,
      ...PLACEHOLDER_CREDENTIALS,
      OWNER_EMAIL: OWNER,
      SIGNUP_MODE: "owner-only",
      MAIL_MODE: "file",
      DAILY_SIGNUP_CAP: "lots",
      AUTH_PORT: String(await freePort()),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  child.stderr?.on("data", (chunk) => (errors += chunk));
  const status = await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(() => resolve("running"), 10_000)),
  ]);
  if (status === "running") child.kill();
  expect(status).toBe(1);
  expect(errors).toContain("DAILY_SIGNUP_CAP must be a whole number");
}, 20_000);
