// @module-tag slow
// slow (process): coordinates two real gateway processes against one disposable PostgreSQL database.
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import {
  walkSignIn,
  cookieHeader,
  type Jar,
} from "../testing/oauth-fake/walk.js";
import {
  startGateway,
  sessionOf,
  type TestGateway,
} from "./support/oauth-gateway.js";
import { sleep } from "./support/servers.js";

let a: TestGateway;
let b: TestGateway;
type Collector = { userId: string; sessionId: string; jar: Jar };
let collector: Collector;
const LAST = { code: "FAILED_TO_UNLINK_LAST_ACCOUNT" };
const UNAVAILABLE = { error: "Service temporarily unavailable" };
beforeAll(async () => {
  a = await startGateway();
  try {
    b = await startGateway({ databaseUrl: a.databaseUrl });
  } catch (error) {
    await a.stop();
    a = undefined!;
    throw error;
  }
}, 60_000);
afterAll(async () => {
  try {
    await b?.stop();
  } finally {
    await a?.stop();
  }
}, 30_000);

async function newCollector(): Promise<Collector> {
  await a.pool.query(
    "DELETE FROM auth_rate_event; DELETE FROM auth_send_event"
  );
  const { jar } = await walkSignIn(a.base, "/auth/sign-in/google", "owner");
  const userId = (await sessionOf(a, jar)).userId!;
  expect(userId).toBeTruthy();
  const { rows } = await a.pool.query(
    'SELECT id FROM session WHERE "userId"=$1',
    [userId]
  );
  await a.pool.query('UPDATE "user" SET email=$2 WHERE id=$1', [
    userId,
    `${randomUUID()}@example.test`,
  ]);
  // Retire the fake provider identity so the next genuine OAuth sign-in creates an independent collector.
  await a.pool.query('UPDATE account SET "accountId"=$2 WHERE "userId"=$1', [
    userId,
    randomUUID(),
  ]);
  await a.pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId","updatedAt") VALUES ($1,$1,'discord',$2,now())`,
    [randomUUID(), userId]
  );
  return { userId, sessionId: rows[0].id, jar };
}
beforeEach(async () => {
  await a.pool.query('DELETE FROM "user"');
  collector = await newCollector();
});
const unlink = (gateway: TestGateway, target: string, who = collector) =>
  fetch(`${gateway.base}/auth/unlink/${target}`, {
    method: "POST",
    headers: { origin: gateway.base, cookie: cookieHeader(who.jar) },
    signal: AbortSignal.timeout(15_000),
  });
const snapshot = async (who = collector) =>
  (
    await a.pool.query('SELECT * FROM account WHERE "userId"=$1 ORDER BY id', [
      who.userId,
    ])
  ).rows;
async function answer(response: Response, status: number, body: object) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual(body);
}

// Observe actual PostgreSQL blocking relationships, rather than assuming overlap after a delay.
async function waitForBlocked(blocker: number, query: string): Promise<number> {
  const deadline = performance.now() + 2_500;
  for (;;) {
    const { rows } = await a.pool.query(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND state='active'
       AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE $2`,
      [blocker, `%${query}%`]
    );
    if (rows.length) return rows[0].pid;
    if (performance.now() >= deadline)
      throw new Error(
        `Expected a blocked ${query} statement behind backend ${blocker}`
      );
    await sleep(20);
  }
}
async function deleteBarrier(
  run: (controller: PoolClient, pid: number) => Promise<void>
) {
  const controller = await a.pool.connect();
  const {
    rows: [{ pid }],
  } = await controller.query("SELECT pg_backend_pid() AS pid");
  try {
    await controller.query("SELECT pg_advisory_lock(71924681)");
    await a.pool
      .query(`CREATE FUNCTION removal_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD."userId"=TG_ARGV[0] THEN PERFORM pg_advisory_xact_lock(71924681); END IF; RETURN OLD; END $$`);
    await a.pool.query(
      `CREATE TRIGGER removal_barrier BEFORE DELETE ON account FOR EACH ROW EXECUTE FUNCTION removal_barrier('${collector.userId}')`
    );
    await run(controller, pid);
  } finally {
    await controller.query("SELECT pg_advisory_unlock_all()");
    controller.release();
    await a.pool.query(
      "DROP TRIGGER IF EXISTS removal_barrier ON account; DROP FUNCTION IF EXISTS removal_barrier()"
    );
  }
}

it.each([
  ["google", "discord"],
  ["discord", "google"],
])(
  "serializes different-provider removals across gateway processes (%s first)",
  async (first, second) => {
    await deleteBarrier(async (controller, pid) => {
      const winner = unlink(a, first);
      const deleting = await waitForBlocked(pid, "DELETE FROM");
      const contender = unlink(b, second);
      try {
        await waitForBlocked(deleting, "FOR NO KEY UPDATE");
      } finally {
        await controller.query("SELECT pg_advisory_unlock_all()");
        await Promise.all([winner, contender]);
      }
      await answer(await winner, 200, { unlinked: first });
      await answer(await contender, 400, LAST);
      expect((await snapshot()).map((row) => row.providerId)).toEqual([second]);
    });
  }
);
it("serializes repeated removal of the same provider", async () => {
  await deleteBarrier(async (controller, pid) => {
    const winner = unlink(a, "google");
    const deleting = await waitForBlocked(pid, "DELETE FROM");
    const contender = unlink(b, "google");
    try {
      await waitForBlocked(deleting, "FOR NO KEY UPDATE");
    } finally {
      await controller.query("SELECT pg_advisory_unlock_all()");
      await Promise.all([winner, contender]);
    }
    await answer(await winner, 200, { unlinked: "google" });
    await answer(await contender, 404, { error: "Not found" });
    expect((await snapshot()).map((row) => row.providerId)).toEqual([
      "discord",
    ]);
  });
});
it("does not serialize unrelated collectors", async () => {
  const other = await newCollector();
  const otherBefore = await snapshot(other);
  await deleteBarrier(async (controller, pid) => {
    const waiting = unlink(a, "google");
    try {
      await waitForBlocked(pid, "DELETE FROM");
      await answer(await unlink(b, "google", other), 200, {
        unlinked: "google",
      });
      expect(await snapshot(other)).toEqual(
        otherBefore.filter((row) => row.providerId === "discord")
      );
    } finally {
      await controller.query("SELECT pg_advisory_unlock_all()");
      await waiting;
    }
    await answer(await waiting, 200, { unlinked: "google" });
  });
});
it("rolls back all provider accounts when a later deletion fails", async () => {
  await a.pool.query(
    `INSERT INTO account(id,"accountId","providerId","userId","updatedAt") VALUES ($1,$1,'google',$2,now())`,
    [randomUUID(), collector.userId]
  );
  const before = await snapshot();
  try {
    await a.pool.query(`CREATE SEQUENCE removal_visits;
      CREATE FUNCTION removal_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD."userId"=TG_ARGV[0] AND OLD."providerId"='google' AND nextval('removal_visits')=2
      THEN RAISE EXCEPTION 'test deletion failure'; END IF; RETURN OLD; END $$`);
    await a.pool.query(
      `CREATE TRIGGER removal_failure AFTER DELETE ON account FOR EACH ROW EXECUTE FUNCTION removal_failure('${collector.userId}')`
    );
    await answer(await unlink(a, "google"), 503, UNAVAILABLE);
    expect(
      (await a.pool.query("SELECT last_value FROM removal_visits")).rows[0]
        .last_value
    ).toBe("2");
    expect(await snapshot()).toEqual(before);
  } finally {
    await a.pool.query(
      "DROP TRIGGER IF EXISTS removal_failure ON account; DROP FUNCTION IF EXISTS removal_failure(); DROP SEQUENCE IF EXISTS removal_visits"
    );
  }
  await answer(await unlink(a, "google"), 200, { unlinked: "google" });
  expect((await snapshot()).map((row) => row.providerId)).toEqual(["discord"]);
});

it.each(["revoked", "expired", "stale"])(
  "rechecks a %s session after the lock wait",
  async (change) => {
    const before = await snapshot();
    const controller = await a.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await controller.query("BEGIN");
      await controller.query(
        'SELECT id FROM "user" WHERE id=$1 FOR NO KEY UPDATE',
        [collector.userId]
      );
      const {
        rows: [{ pid }],
      } = await controller.query("SELECT pg_backend_pid() AS pid");
      pending = unlink(a, "google");
      await waitForBlocked(pid, "FOR NO KEY UPDATE");
      if (change === "revoked")
        await a.pool.query("DELETE FROM session WHERE id=$1", [
          collector.sessionId,
        ]);
      else if (change === "expired")
        await a.pool.query(
          `UPDATE session SET "expiresAt"=now()-interval '1 minute' WHERE id=$1`,
          [collector.sessionId]
        );
      else
        await a.pool.query(
          `UPDATE session SET "createdAt"=now()-interval '25 hours' WHERE id=$1`,
          [collector.sessionId]
        );
      await controller.query("COMMIT");
      await answer(
        await pending,
        change === "stale" ? 403 : 503,
        change === "stale" ? { code: "recent_sign_in_required" } : UNAVAILABLE
      );
      expect(await snapshot()).toEqual(before);
    } finally {
      await controller.query("ROLLBACK");
      controller.release();
      await pending;
      // Each case owns its collector and session; deleting the user also cleans a revoked/modified session.
      await a.pool.query('DELETE FROM "user" WHERE id=$1', [collector.userId]);
    }
  }
);

// slow (wall-clock): waits for the production five-second database lock timeout.
it("bounds lock contention and recovers", async () => {
  const before = await snapshot();
  const controller = await a.pool.connect();
  try {
    await controller.query("BEGIN");
    await controller.query(
      'SELECT id FROM "user" WHERE id=$1 FOR NO KEY UPDATE',
      [collector.userId]
    );
    await answer(await unlink(a, "google"), 503, UNAVAILABLE);
    expect(await snapshot()).toEqual(before);
  } finally {
    await controller.query("ROLLBACK");
    controller.release();
  }
  await answer(await unlink(a, "google"), 200, { unlinked: "google" });
});

// slow (wall-clock): waits for the production five-second pool acquisition timeout.
it("bounds pool acquisition and recovers", async () => {
  const { createSignInRemoval } = await import("../src/signInRemoval.js");
  const pool = new Pool({
    connectionString: a.databaseUrl,
    max: 4,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  const held: PoolClient[] = [];
  const remove = createSignInRemoval(pool, [
    { id: "google" },
    { id: "discord" },
  ]);
  const request = {
    userId: collector.userId,
    sessionId: collector.sessionId,
    providerId: "google",
  };
  const before = await snapshot();
  try {
    try {
      for (let i = 0; i < 4; i++) held.push(await pool.connect());
      await expect(remove(request)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      for (const client of held) client.release();
    }
    expect(await remove(request)).toEqual({ kind: "unlinked" });
  } finally {
    await pool.end();
  }
});

it("keeps configured-provider rules and collector isolation", async () => {
  const other = await newCollector();
  const otherBefore = await snapshot(other);
  const before = await snapshot();
  const disabled = await startGateway({
    databaseUrl: a.databaseUrl,
    env: {
      DISCORD_CLIENT_ID: undefined,
      DISCORD_CLIENT_SECRET: undefined,
      EMAIL_SIGN_IN: "on",
    },
  });
  try {
    await answer(await unlink(disabled, "google"), 400, LAST);
    await answer(await unlink(disabled, "discord"), 404, {
      error: "Not found",
    });
    expect(await snapshot()).toEqual(before);
    const { createSignInRemoval } = await import("../src/signInRemoval.js");
    const configured = [{ id: "google" }];
    const remove = createSignInRemoval(a.pool, configured);
    configured.push({ id: "discord" });
    expect(await remove({ ...collector, providerId: "discord" })).toEqual({
      kind: "not-linked",
    });
    expect(await remove({ ...collector, providerId: "google" })).toEqual({
      kind: "last",
    });
    await a.pool.query(
      'DELETE FROM account WHERE "userId"=$1 AND "providerId"=$2',
      [collector.userId, "discord"]
    );
    // Another collector's Discord and email-code availability cannot make Google's removal eligible.
    await answer(await unlink(disabled, "google"), 400, LAST);
    await answer(await unlink(a, "google"), 400, LAST);
    expect(await snapshot(other)).toEqual(otherBefore);
  } finally {
    await disabled.stop();
  }
});

it("preserves session and user after successful removal", async () => {
  const before = (
    await a.pool.query("SELECT * FROM session WHERE id=$1", [
      collector.sessionId,
    ])
  ).rows;
  const user = (
    await a.pool.query('SELECT * FROM "user" WHERE id=$1', [collector.userId])
  ).rows;
  const removed = await unlink(a, "google");
  expect(removed.headers.getSetCookie()).toEqual([]);
  await answer(removed, 200, { unlinked: "google" });
  expect(await sessionOf(b, collector.jar)).toMatchObject({
    signedIn: true,
    userId: collector.userId,
  });
  expect(
    (
      await a.pool.query("SELECT * FROM session WHERE id=$1", [
        collector.sessionId,
      ])
    ).rows
  ).toEqual(before);
  expect(
    (await a.pool.query('SELECT * FROM "user" WHERE id=$1', [collector.userId]))
      .rows
  ).toEqual(user);
});
