import { afterAll, beforeAll, expect, it } from "vitest";
import { walkSignIn, type Jar } from "../testing/oauth-fake/walk.js";
import {
  OWNER,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

// The provider name and picture follow the latest sign-in or link, and only the signed-in collector sees them. The
// tests run in order on one fresh owner-only deployment.
let gateway: TestGateway;
beforeAll(async () => {
  gateway = await startGateway();
}, 60_000);
afterAll(() => gateway?.stop(), 30_000);

type Profile = {
  signedIn: boolean;
  userId: string | null;
  name?: string | null;
  image?: string | null;
  email?: string | null;
};
const profileOf = (jar: Jar) => sessionOf(gateway, jar) as Promise<Profile>;

it("answers a signed-out request with no profile fields", async () => {
  expect(await (await fetch(`${gateway.base}/auth/session`)).json()).toEqual({
    signedIn: false,
    userId: null,
  });
});

it("returns the name, picture and email to the signed-in collector", async () => {
  const walk = await walkSignIn(gateway.base, "/auth/sign-in/google", "owner");
  const profile = await profileOf(walk.jar);
  expect(profile).toEqual({
    signedIn: true,
    userId: profile.userId,
    name: "Owner Collector",
    image: "https://lh3.googleusercontent.com/a/fake-owner",
    email: OWNER,
  });
});

it("follows the latest sign-in, and keeps a field the provider omits", async () => {
  const renamed = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner-renamed"
  );
  expect(await profileOf(renamed.jar)).toMatchObject({
    name: "Owner Renamed",
    image: "https://lh3.googleusercontent.com/a/fake-owner-renamed",
    email: OWNER,
  });
  // Google sends neither a name nor a picture for this identity of the same account.
  const plain = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner-plain"
  );
  expect(await profileOf(plain.jar)).toMatchObject({
    name: "Owner Renamed",
    image: "https://lh3.googleusercontent.com/a/fake-owner-renamed",
    email: OWNER,
  });
});

it("follows a newly linked provider", async () => {
  const discord = await walkSignIn(
    gateway.base,
    "/auth/sign-in/discord",
    "owner"
  );
  expect(await profileOf(discord.jar)).toMatchObject({
    name: "Owner Collector",
    image:
      "https://cdn.discordapp.com/avatars/100000000000000001/0wner0000000000000000000000000001.png",
    email: OWNER,
  });
});

it("fills an empty name and picture on the owner's first link", async () => {
  const owner = (
    await gateway.pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER])
  ).rows[0].id as string;
  await gateway.pool.query('DELETE FROM account WHERE "userId"=$1', [owner]);
  await gateway.pool.query(
    `UPDATE "user" SET name='', image=NULL WHERE id=$1`,
    [owner]
  );
  const linked = await walkSignIn(
    gateway.base,
    "/auth/sign-in/google",
    "owner"
  );
  expect(await profileOf(linked.jar)).toMatchObject({
    name: "Owner Collector",
    image: "https://lh3.googleusercontent.com/a/fake-owner",
  });
});
