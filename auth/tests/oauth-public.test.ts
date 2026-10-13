import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkSignIn } from "../testing/oauth-fake/walk.js";
import {
  OWNER,
  PLACEHOLDER_CREDENTIALS,
  accountsOf,
  freePort,
  sessionOf,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

const directory = mkdtempSync(join(tmpdir(), "tcg-oauth-public-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const COMMIT = "c".repeat(40);
function proofFile(version: number): string {
  const path = join(directory, `proof-v${version}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: version,
      releaseCommit: COMMIT,
      authorizedByOwner: true,
      senderVerified: true,
      recipientDeliveryVerified: true,
      ownerWalkthroughVerified: true,
      recoveryVerified: true,
      privacyVerified: true,
      capacityVerified: true,
      providerSignInVerified: ["google", "discord"],
      evidence: "Dated acceptance proofs",
    })
  );
  return path;
}

describe("public signup through providers (local-public)", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ env: { SIGNUP_MODE: "local-public" } });
  }, 60_000);
  afterAll(() => gateway?.stop(), 30_000);

  it("creates a new collector with an Unsorted root on a verified provider sign-in", async () => {
    const walk = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "newcomer"
    );
    expect(walk.location).toBe("/collection");
    const session = await sessionOf(gateway, walk.jar);
    expect(session.signedIn).toBe(true);
    const user = await gateway.pool.query(
      'SELECT email, "emailVerified" FROM "user" WHERE id=$1',
      [session.userId]
    );
    expect(user.rows).toEqual([
      { email: "newcomer@example.test", emailVerified: true },
    ]);
    const unsorted = await gateway.pool.query(
      "SELECT count(*)::int AS n FROM location WHERE owner_id=$1 AND name='Unsorted'",
      [session.userId]
    );
    expect(unsorted.rows[0].n).toBe(1);
  });

  it("links a second provider at the same verified email and keeps returning sign-ins on the same collector", async () => {
    const google = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "newcomer"
    );
    const collector = (await sessionOf(gateway, google.jar)).userId!;
    const discord = await walkSignIn(
      gateway.base,
      "/auth/sign-in/discord",
      "newcomer"
    );
    expect(discord.location).toBe("/collection");
    expect((await sessionOf(gateway, discord.jar)).userId).toBe(collector);
    expect(
      (await accountsOf(gateway, collector)).map((a) => a.providerId)
    ).toEqual(["discord", "google"]);
  });

  it("still refuses an unverified or missing provider email, writing nothing", async () => {
    const before = (
      await gateway.pool.query('SELECT count(*)::int AS n FROM "user"')
    ).rows[0].n;
    const unverified = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "unverified"
    );
    expect(unverified.location).toMatch(/[?&]error=email_not_verified(&|$)/);
    const missing = await walkSignIn(
      gateway.base,
      "/auth/sign-in/discord",
      "no-email"
    );
    expect(missing.location).toMatch(/[?&]error=email_not_found(&|$)/);
    expect(
      (await gateway.pool.query('SELECT count(*)::int AS n FROM "user"'))
        .rows[0].n
    ).toBe(before);
  });

  it("creates a separate collector for a different verified email, and lets the owner sign in", async () => {
    const elsewhere = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "different-email"
    );
    expect(elsewhere.location).toBe("/collection");
    const owner = await walkSignIn(
      gateway.base,
      "/auth/sign-in/discord",
      "owner"
    );
    expect(owner.location).toBe("/collection");
    const emails = (
      await gateway.pool.query(
        'SELECT email FROM "user" ORDER BY email COLLATE "C"'
      )
    ).rows.map((row) => row.email);
    expect(emails).toEqual([
      "newcomer@example.test",
      "owner.elsewhere@example.test",
      OWNER,
    ]);
  });
});

describe("public signup on a readiness proof", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({
      env: {
        SIGNUP_MODE: "public",
        SIGNUP_READINESS_FILE: proofFile(2),
        RELEASE_COMMIT: COMMIT,
        NODE_ENV: "development",
      },
    });
  }, 60_000);
  afterAll(() => gateway?.stop(), 30_000);

  it("opens provider signup on a version 2 proof with email sign-in off", async () => {
    const walk = await walkSignIn(
      gateway.base,
      "/auth/sign-in/discord",
      "newcomer"
    );
    expect(walk.location).toBe("/collection");
    expect((await sessionOf(gateway, walk.jar)).signedIn).toBe(true);
  });
});

it("refuses to start public signup on a version 1 proof", async () => {
  const child = spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
    env: {
      ...process.env,
      ...PLACEHOLDER_CREDENTIALS,
      OWNER_EMAIL: OWNER,
      SIGNUP_MODE: "public",
      SIGNUP_READINESS_FILE: proofFile(1),
      RELEASE_COMMIT: COMMIT,
      MAIL_MODE: "file",
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
  expect(errors).toContain("Signup readiness incomplete");
}, 20_000);
