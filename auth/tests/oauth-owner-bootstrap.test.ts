import { afterAll, beforeAll, expect, it } from "vitest";
import { walkSignIn } from "../testing/oauth-fake/walk.js";
import {
  OWNER,
  accountsOf,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

// A fresh owner-only deployment: no owner account and no owner binding yet. The tests run in order.
let gateway: TestGateway;
beforeAll(async () => {
  gateway = await startGateway();
}, 60_000);
afterAll(() => gateway?.stop(), 30_000);

const NOT_OPEN =
  "/sign-in?error=sign_in_unavailable&error_description=sign_in_unavailable";
const rows = async () =>
  (
    await gateway.pool.query(
      `SELECT (SELECT count(*)::int FROM "user") AS users,
        (SELECT count(*)::int FROM account) AS accounts,
        (SELECT count(*)::int FROM location) AS locations,
        (SELECT count(*)::int FROM session) AS sessions`
    )
  ).rows[0];
const noTokens = {
  accessToken: null,
  refreshToken: null,
  idToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
};

it("refuses everyone but the owner, and an unverified or missing email, writing nothing", async () => {
  const newcomer = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "newcomer"
  );
  expect(newcomer.location).toBe(NOT_OPEN);
  const viaDiscord = await walkSignIn(
    gateway.base,
    "/auth/sign-in/discord",
    "different-email"
  );
  expect(viaDiscord.location).toBe(NOT_OPEN);
  for (const provider of ["google", "discord"]) {
    const unverified = await walkSignIn(
      gateway.base,
      `/auth/sign-in/${provider}`,
      "unverified"
    );
    expect(unverified.location).toBe(
      "/sign-in?error=email_not_verified&error_description=email_not_verified"
    );
    const missing = await walkSignIn(
      gateway.base,
      `/auth/sign-in/${provider}`,
      "no-email"
    );
    expect(missing.location).toBe("/sign-in?error=email_not_found");
    expect(missing.jar.has("better-auth.session_token")).toBe(false);
  }
  expect(await rows()).toEqual({
    users: 0,
    accounts: 0,
    locations: 0,
    sessions: 0,
  });
});

it("creates the owner account with its Unsorted root on the first Google sign-in at OWNER_EMAIL", async () => {
  // A binding that names no account (as test fixtures leave behind) does not count as an owner.
  await gateway.pool.query(
    "INSERT INTO inventory_owner(user_id) VALUES ('stale-fixture-owner')"
  );
  await gateway.pool.query(
    "INSERT INTO owner_binding(user_id) VALUES ('stale-fixture-owner')"
  );
  const walk = await walkSignIn(gateway.base, "/auth/sign-in/google", "owner");
  expect(walk.location).toBe("/collection");
  const session = await sessionOf(gateway, walk.jar);
  expect(session.signedIn).toBe(true);
  const user = (
    await gateway.pool.query('SELECT id, email, "emailVerified" FROM "user"')
  ).rows;
  expect(user).toEqual([
    { id: session.userId, email: OWNER, emailVerified: true },
  ]);
  const roots = await gateway.pool.query(
    "SELECT name, kind FROM location WHERE owner_id=$1 AND parent_id IS NULL",
    [session.userId]
  );
  expect(roots.rows).toEqual([{ name: "Unsorted", kind: "storage_leaf" }]);
  expect(await accountsOf(gateway, session.userId!)).toEqual([
    expect.objectContaining({
      providerId: "google",
      accountId: "100000000000000000001",
      ...noTokens,
    }),
  ]);
});

it("links Discord at the same verified email to the owner, and keeps every token null on repeat sign-ins", async () => {
  const google = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner"
  );
  const owner = (await sessionOf(gateway, google.jar)).userId!;
  const discord = await walkSignIn(
    gateway.base,
    "/auth/sign-in/discord",
    "owner"
  );
  expect(discord.location).toBe("/collection");
  expect((await sessionOf(gateway, discord.jar)).userId).toBe(owner);
  await walkSignIn(gateway.base, "/auth/sign-in/discord", "owner");
  const accounts = await accountsOf(gateway, owner);
  expect(accounts.map((a) => `${a.providerId}:${a.accountId}`)).toEqual([
    "discord:100000000000000001",
    "google:100000000000000000001",
  ]);
  for (const account of accounts) expect(account).toMatchObject(noTokens);
  expect(accounts.every((account) => typeof account.scope === "string")).toBe(
    true
  );
  expect((await rows()).users).toBe(1);
});

it("recognises a returning sign-in by account id and never rewrites the owner's email", async () => {
  const moved = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner-moved"
  );
  expect(moved.location).toBe("/collection");
  const session = await sessionOf(gateway, moved.jar);
  const user = await gateway.pool.query(
    'SELECT email, "emailVerified" FROM "user" WHERE id=$1',
    [session.userId]
  );
  expect(user.rows).toEqual([{ email: OWNER, emailVerified: true }]);
  expect((await rows()).users).toBe(1);
});

it("once bound, lets only the bound owner sign in or link, with the same refusal whether or not an account exists", async () => {
  const owner = (
    await gateway.pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER])
  ).rows[0].id as string;
  await gateway.pool.query("DELETE FROM owner_binding");
  await gateway.pool.query("INSERT INTO owner_binding(user_id) VALUES ($1)", [
    owner,
  ]);
  const second = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner-second"
  );
  expect(second.location).toBe("/collection");
  expect((await sessionOf(gateway, second.jar)).userId).toBe(owner);
  expect((await accountsOf(gateway, owner)).length).toBe(3);
  const before = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "newcomer"
  );
  // A verified collector row at the newcomer's address, as if left from an earlier public period.
  await gateway.pool.query(
    `INSERT INTO "user"(id, name, email, "emailVerified") VALUES ('kept-collector', 'Kept', 'newcomer@example.test', true)`
  );
  const after = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "newcomer"
  );
  expect(before.location).toBe(NOT_OPEN);
  expect(after.location).toBe(before.location);
  expect(
    (
      await gateway.pool.query(
        `SELECT count(*)::int AS n FROM account WHERE "userId"='kept-collector'`
      )
    ).rows[0].n
  ).toBe(0);
});
