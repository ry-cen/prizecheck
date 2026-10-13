import { afterAll, beforeAll, expect, it } from "vitest";
import {
  walkSignIn,
  cookieHeader,
  type Jar,
} from "../testing/oauth-fake/walk.js";
import {
  OWNER,
  accountsOf,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

// The Sign-ins routes (#156) on a fresh owner-only deployment, through the real gateway and the OAuth test fake. The
// owner signs in with Google first; the tests run in order on that account.
let gateway: TestGateway;
let jar: Jar;
let owner = "";
beforeAll(async () => {
  gateway = await startGateway();
  const walk = await walkSignIn(gateway.base, "/auth/sign-in/google", "owner");
  jar = walk.jar;
  owner = (await sessionOf(gateway, jar)).userId!;
}, 60_000);
afterAll(() => gateway?.stop(), 30_000);

const CONSENT = "/auth/__fake-oauth/consent";
const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(gateway.base + path, {
    redirect: "manual",
    headers: { cookie: cookieHeader(jar), ...headers },
  });
const unlink = (provider: string, origin: string | null = gateway.base) =>
  fetch(`${gateway.base}/auth/unlink/${provider}`, {
    method: "POST",
    headers: {
      cookie: cookieHeader(jar),
      ...(origin === null ? {} : { origin }),
    },
  });
const providersOf = async () =>
  (await accountsOf(gateway, owner)).map((account) => account.providerId);
const signInsOf = async () =>
  (await (await get("/auth/sign-ins")).json()).signIns;
const setSessionAge = (age: string) =>
  gateway.pool.query(
    `UPDATE session SET "createdAt"=now()-$2::interval WHERE "userId"=$1`,
    [owner, age]
  );

it("answers 401 without a session, 404 for an unknown provider, and never exposes Better Auth's own endpoints", async () => {
  const anonymous = { redirect: "manual" as const };
  expect((await fetch(`${gateway.base}/auth/sign-ins`, anonymous)).status).toBe(
    401
  );
  const signedOut = await fetch(`${gateway.base}/auth/link/discord`, anonymous);
  expect(signedOut.status).toBe(302);
  expect(signedOut.headers.get("location")).toBe(
    "/sign-in?next=%2Fsettings%2Fsign-ins"
  );
  expect(
    (
      await fetch(`${gateway.base}/auth/unlink/google`, {
        method: "POST",
        headers: { origin: gateway.base },
      })
    ).status
  ).toBe(401);
  for (const path of ["/auth/link/github", "/auth/link/Google", "/auth/link/"])
    expect((await get(path)).status, path).toBe(404);
  expect((await unlink("github")).status).toBe(404);
  for (const [method, path] of [
    ["GET", "/api/auth/list-accounts"],
    ["POST", "/api/auth/link-social"],
    ["POST", "/api/auth/unlink-account"],
  ]) {
    const response = await fetch(gateway.base + path, {
      method,
      headers: {
        cookie: cookieHeader(jar),
        origin: gateway.base,
        "content-type": "application/json",
      },
      body:
        method === "POST" ? JSON.stringify({ provider: "discord" }) : undefined,
    });
    expect(response.status, path).toBe(404);
  }
  expect(gateway.apiPaths).toEqual([]);
});

it("lists the linked providers with the date linked, and no account ids or emails", async () => {
  const response = await get("/auth/sign-ins");
  expect(response.status).toBe(200);
  const text = await response.text();
  const [google] = await gateway.pool
    .query(`SELECT id, "createdAt" FROM account WHERE "userId"=$1`, [owner])
    .then((result) => result.rows);
  expect(JSON.parse(text)).toEqual({
    signIns: [{ provider: "google", linkedAt: google.createdAt.toISOString() }],
  });
  for (const secret of [OWNER, owner, google.id, "100000000000000000001"])
    expect(text).not.toContain(secret);
});

it("links a provider with a different verified email and returns to the Sign-ins page", async () => {
  const walk = await walkSignIn(
    gateway.base,
    "/auth/link/discord",
    "different-email",
    jar
  );
  expect(walk.location).toBe("/settings/sign-ins");
  expect(await providersOf()).toEqual(["discord", "google"]);
  const [discord] = (await accountsOf(gateway, owner)).filter(
    (account) => account.providerId === "discord"
  );
  expect(discord).toMatchObject({
    accountId: "100000000000000006",
    accessToken: null,
    refreshToken: null,
    idToken: null,
  });
  const user = await gateway.pool.query(
    'SELECT email, "emailVerified" FROM "user" WHERE id=$1',
    [owner]
  );
  expect(user.rows).toEqual([{ email: OWNER, emailVerified: true }]);
  expect((await sessionOf(gateway, jar)).userId).toBe(owner);
  expect(
    (await signInsOf()).map((entry: { provider: string }) => entry.provider)
  ).toEqual(["google", "discord"]);
});

it("refuses to link an unverified or missing provider email, linking nothing", async () => {
  // An email the provider doesn't vouch for is dropped before the gate (auth/src/providers.ts), so both are
  // email_not_found.
  const unverified = await walkSignIn(
    gateway.base,
    "/auth/link/google",
    "unverified",
    jar
  );
  expect(unverified.location).toBe(
    "/settings/sign-ins?provider=google&error=email_not_found&error_description=email_not_found"
  );
  const missing = await walkSignIn(
    gateway.base,
    "/auth/link/discord",
    "no-email",
    jar
  );
  expect(missing.location).toBe(
    "/settings/sign-ins?provider=discord&error=email_not_found&error_description=email_not_found"
  );
  expect(await providersOf()).toEqual(["discord", "google"]);
});

it("refuses a provider account another collector holds, without naming them", async () => {
  await gateway.pool.query(
    `INSERT INTO "user"(id, name, email, "emailVerified") VALUES ('other-collector', 'Other', 'other.collector@example.test', true)`
  );
  await gateway.pool.query(
    `INSERT INTO account(id, "accountId", "providerId", "userId", "updatedAt") VALUES ('other-discord', '100000000000000003', 'discord', 'other-collector', now())`
  );
  const walk = await walkSignIn(
    gateway.base,
    "/auth/link/discord",
    "newcomer",
    jar
  );
  const location = new URL(walk.location!, gateway.base);
  expect(location.pathname).toBe("/settings/sign-ins");
  expect(location.searchParams.get("provider")).toBe("discord");
  expect(location.searchParams.get("error")).toBe(
    "account_already_linked_to_different_user"
  );
  for (const secret of [
    "other-collector",
    "other.collector",
    "Other",
    "newcomer",
  ])
    expect(walk.location).not.toContain(secret);
  expect(await providersOf()).toEqual(["discord", "google"]);
  const theirs = await gateway.pool.query(
    `SELECT "userId" FROM account WHERE id='other-discord'`
  );
  expect(theirs.rows).toEqual([{ userId: "other-collector" }]);
});

it("needs a session created within 24 hours to link or unlink", async () => {
  const verifications = async () =>
    (await gateway.pool.query("SELECT count(*)::int AS n FROM verification"))
      .rows[0].n;
  try {
    await setSessionAge("24 hours 1 minute");
    const before = await verifications();
    const link = await get("/auth/link/google");
    expect(link.status).toBe(302);
    expect(link.headers.get("location")).toBe(
      "/settings/sign-ins?provider=google&error=recent_sign_in_required"
    );
    expect(await verifications()).toBe(before);
    const stale = await unlink("discord");
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ code: "recent_sign_in_required" });
    expect(await providersOf()).toEqual(["discord", "google"]);
    await setSessionAge("23 hours 59 minutes");
    const fresh = await get("/auth/link/google");
    expect(new URL(fresh.headers.get("location")!, gateway.base).pathname).toBe(
      CONSENT
    );
  } finally {
    await setSessionAge("0 seconds");
  }
});

it("refuses a link start from another site, writing nothing and counting no start", async () => {
  const rows = async (sql: string) =>
    (await gateway.pool.query(sql)).rows[0].n as number;
  const verifications = "SELECT count(*)::int AS n FROM verification";
  const starts =
    "SELECT count(*)::int AS n FROM auth_rate_event WHERE kind='start'";
  const before = [await rows(verifications), await rows(starts)];
  for (const site of ["cross-site", "same-site"]) {
    const response = await get("/auth/link/google", { "sec-fetch-site": site });
    expect(response.status, site).toBe(302);
    expect(response.headers.get("location"), site).toBe(
      "/settings/sign-ins?provider=google&error=cross_site_request"
    );
  }
  expect([await rows(verifications), await rows(starts)]).toEqual(before);
  for (const site of ["same-origin", "none"]) {
    const response = await get("/auth/link/google", { "sec-fetch-site": site });
    expect(
      new URL(response.headers.get("location")!, gateway.base).pathname,
      site
    ).toBe(CONSENT);
  }
});

it("limits link starts with sign-in starts, at 60 per trusted IP per hour", async () => {
  const { rows } = await gateway.pool.query(
    "SELECT ip_key FROM auth_rate_event WHERE kind='start' LIMIT 1"
  );
  try {
    await gateway.pool.query(
      "INSERT INTO auth_rate_event(kind,ip_key) SELECT 'start',$1 FROM generate_series(1,60)",
      [rows[0].ip_key]
    );
    const response = await get("/auth/link/google");
    expect(response.headers.get("location")).toBe(
      "/settings/sign-ins?provider=google&error=too_many_sign_ups"
    );
  } finally {
    await gateway.pool.query("DELETE FROM auth_rate_event");
  }
});

it("unlinks on a same-origin request, but never the last sign-in", async () => {
  expect((await unlink("discord", null)).status).toBe(403);
  expect((await unlink("discord", "https://evil.example")).status).toBe(403);
  const removed = await unlink("discord");
  expect(removed.status).toBe(200);
  expect(await removed.json()).toEqual({ unlinked: "discord" });
  expect(await providersOf()).toEqual(["google"]);
  expect((await signInsOf()).length).toBe(1);
  const last = await unlink("google");
  expect(last.status).toBe(400);
  expect(await last.json()).toEqual({ code: "FAILED_TO_UNLINK_LAST_ACCOUNT" });
  expect(await providersOf()).toEqual(["google"]);
  expect((await unlink("discord")).status).toBe(404);
});

it("removes every account of a provider at once, keeping the other provider", async () => {
  // A second Google account at the owner's verified email links to the same collector.
  const second = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner-second"
  );
  expect((await sessionOf(gateway, second.jar)).userId).toBe(owner);
  expect(await providersOf()).toEqual(["google", "google"]);
  expect((await signInsOf()).length).toBe(1);
  expect((await unlink("google")).status).toBe(400);
  const relinked = await walkSignIn(
    gateway.base,
    "/auth/link/discord",
    "different-email",
    jar
  );
  expect(relinked.location).toBe("/settings/sign-ins");
  expect((await unlink("google")).status).toBe(200);
  expect(await providersOf()).toEqual(["discord"]);
});
