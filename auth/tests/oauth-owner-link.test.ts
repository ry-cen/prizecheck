import { afterAll, beforeAll, expect, it } from "vitest";
import { walkSignIn } from "../testing/oauth-fake/walk.js";
import {
  OWNER,
  accountsOf,
  emailCodeSignIn,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

// The owner already has an email-code account and data, and is bound. The tests run in order.
let gateway: TestGateway;
let owner = "";
beforeAll(async () => {
  gateway = await startGateway();
  const jar = await emailCodeSignIn(gateway, OWNER);
  owner = (await sessionOf(gateway, jar)).userId!;
  await gateway.pool.query("INSERT INTO owner_binding(user_id) VALUES ($1)", [
    owner,
  ]);
}, 60_000);
afterAll(() => gateway?.stop(), 30_000);

it("refuses to link a provider while the owner's own email is unverified", async () => {
  await gateway.pool.query(
    'UPDATE "user" SET "emailVerified"=false WHERE id=$1',
    [owner]
  );
  try {
    const walk = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "owner"
    );
    expect(walk.location).toBe("/sign-in?error=account_not_linked");
    expect(await accountsOf(gateway, owner)).toEqual([]);
  } finally {
    await gateway.pool.query(
      'UPDATE "user" SET "emailVerified"=true WHERE id=$1',
      [owner]
    );
  }
});

it("reaches the owner's existing account on the first Google sign-in at OWNER_EMAIL", async () => {
  const walk = await walkSignIn(gateway.base, "/auth/sign-in/google", "owner");
  expect(walk.location).toBe("/collection");
  expect((await sessionOf(gateway, walk.jar)).userId).toBe(owner);
  const unsorted = await gateway.pool.query(
    "SELECT count(*)::int AS n FROM location WHERE owner_id=$1 AND name='Unsorted'",
    [owner]
  );
  expect(unsorted.rows[0].n).toBe(1);
  expect(
    (await gateway.pool.query('SELECT count(*)::int AS n FROM "user"')).rows[0]
      .n
  ).toBe(1);
});

it("links Discord to the same account and stores no provider tokens", async () => {
  const walk = await walkSignIn(gateway.base, "/auth/sign-in/discord", "owner");
  expect(walk.location).toBe("/collection");
  expect((await sessionOf(gateway, walk.jar)).userId).toBe(owner);
  const accounts = await accountsOf(gateway, owner);
  expect(accounts.map((a) => a.providerId)).toEqual(["discord", "google"]);
  for (const account of accounts)
    expect(account).toMatchObject({
      accessToken: null,
      refreshToken: null,
      idToken: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
    });
  const user = await gateway.pool.query(
    'SELECT email, "emailVerified" FROM "user" WHERE id=$1',
    [owner]
  );
  expect(user.rows).toEqual([{ email: OWNER, emailVerified: true }]);
});

it("keeps email-code sign-in working for the owner", async () => {
  const jar = await emailCodeSignIn(gateway, OWNER);
  expect((await sessionOf(gateway, jar)).userId).toBe(owner);
});
