// @module-tag slow
// slow (process): two gateways, two APIs and real price runners; every scenario waits for the runners' real 2 s idle exit
// (IDLE_S in api/app/price_runner.py is a default argument, so it cannot be scaled from a test).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backoffKey,
  HOUR,
  keyOf,
  LEASES,
  SCHEDULER,
  sleep,
  Stack,
  metric,
  waitFor,
  type Edition,
} from "./price-runners-harness";

// Ticket 08-C: real-process boundary scenarios for the detached price runners. Two gateways and two APIs share one
// PostgreSQL database and one record store (the HTTP relay); the APIs launch real runners, which fetch from a fake
// TCGdex server. Every scenario asserts the live runner processes (scoped to this file's lock directory) and the fake
// source's request log, not only leases and records.
const stack = new Stack();
const source = stack.source;
const runners = stack.runners;
const PROVIDER_TIME = "2026-10-01T00:00:00Z";

beforeAll(async () => {
  await stack.start();
  await stack.signIn([
    stack.ownerEmail,
    "runner-b@example.test",
    "runner-c@example.test",
    "runner-d@example.test",
    "runner-e@example.test",
  ]);
}, 120_000);

afterAll(async () => {
  await stack.stop();
}, 60_000);

/** Runs `body` while sampling the live runner processes every 50 ms. */
async function watched<T>(body: () => Promise<T>) {
  const stop = runners.watch();
  try {
    const value = await body();
    await stack.quiesce(); // the runners exit on their own (2 s idle) and free their slots
    return { value, processes: await stop() };
  } catch (error) {
    await stop();
    throw error;
  }
}
const state = async (edition: Edition) => {
  const rows = await stack.read([
    keyOf("result", edition),
    keyOf("quote", edition),
    keyOf("work", edition),
    backoffKey(edition),
  ]);
  return {
    result: rows[keyOf("result", edition)],
    quote: rows[keyOf("quote", edition)],
    work: rows[keyOf("work", edition)].value,
    backoff: rows[backoffKey(edition)].value,
  };
};
/** A scheduler with no work and a bucket holding `milli` milli-tokens as of `at`. */
const emptyScheduler = (milli: number, at = Date.now()) => ({
  v: 1,
  bucket: { milli, at_ms: at },
  interactive: {},
  jobs: {},
  fifo: {},
  ring: [],
  cursor: 0,
  source: {},
  ledger: { interval: 0, count: 0 },
  stats: { admitted: 0, joined: 0, refused: {}, expired: 0, fenced: 0 },
});
const jobsOf = async () =>
  Object.keys((await stack.get(SCHEDULER))?.jobs ?? {}).map(
    (id) => id.split(":")[0]
  );
/** Waits until the scheduler has counted `reason` among its refusals (post-response, so polled). */
const refused = (reason: string) =>
  waitFor(
    async () =>
      ((await stack.get(SCHEDULER))?.stats?.refused?.[reason] ?? 0) >= 1,
    `stats.refused.${reason}`,
    3_000
  );

// ================================================================ AC8: source failures, each through a gateway
describe("source boundary scenarios through the gateways", () => {
  it("failure (5xx): two attempts, a per-Edition backoff, and the cached quote untouched", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    await stack.seedQuote(edition, "0.40", 25 * HOUR, PROVIDER_TIME);
    const before = await state(edition);
    source.behaviour.set(edition.card, { kind: "status", code: 500 });
    const { value: response, processes } = await watched(async () => {
      const response = await stack.prices(0, [edition.id]);
      await waitFor(
        async () => (await state(edition)).backoff,
        "the failure backoff"
      );
      return response;
    });
    expect(response.status).toBe(200);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    expect(["failed", "timeout"]).toContain(response.rows[edition.id].refresh);
    expect(response.rows[edition.id].amount).toBe("0.40"); // cached data stays on screen
    const after = await state(edition);
    expect(after.backoff).toMatchObject({ failures: 1, reason: "http_status" });
    expect(after.result.version).toBe(before.result.version);
    expect(after.quote.version).toBe(before.quote.version);
    const requests = source.requests(edition.card);
    expect(requests).toHaveLength(2); // one transient retry, 0.5-1 s later, inside the 2 s deadline
    const gap = requests[1].at - requests[0].at;
    expect(gap).toBeGreaterThanOrEqual(450);
    expect(gap).toBeLessThan(1_600);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    // The backoff now answers at once, with the cached quote, and launches nothing.
    const again = await stack.prices(1, [edition.id]);
    expect(again.rows[edition.id].refresh).toBe("backoff");
    expect(again.rows[edition.id].amount).toBe("0.40");
    expect(again.elapsed).toBeLessThan(1_500);
    expect(source.requests(edition.card)).toHaveLength(2);
    expect((await runners.counts()).live).toEqual([]);
    metric(
      `5xx: ${response.rows[edition.id].refresh} after ${response.elapsed.toFixed(0)} ms (bound 3000), retry gap ${gap} ms [450, 1600), backoff answer ${again.elapsed.toFixed(0)} ms (bound 1500)`
    );
  }, 30_000);

  it("malformed reply: one request, a malformed backoff, nothing written", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    await stack.seedQuote(edition, "0.41", 25 * HOUR, PROVIDER_TIME);
    const before = await state(edition);
    source.behaviour.set(edition.card, { kind: "malformed" });
    const { value: response, processes } = await watched(async () => {
      const response = await stack.prices(1, [edition.id]);
      await waitFor(async () => (await state(edition)).backoff, "the backoff");
      return response;
    });
    expect(response.rows[edition.id].refresh).toBe("failed");
    expect(response.rows[edition.id].amount).toBe("0.41");
    const after = await state(edition);
    expect(after.backoff).toMatchObject({ failures: 1, reason: "malformed" });
    expect(after.result.version).toBe(before.result.version);
    expect(after.quote.version).toBe(before.quote.version);
    expect(source.requests(edition.card)).toHaveLength(1); // a 200 that does not parse is never retried
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `malformed: failed after ${response.elapsed.toFixed(0)} ms (must beat the ~2500 ms wait)`
    );
  }, 30_000);

  it("partial success: one Edition written, its sibling on the same card unchanged and backed off", async () => {
    await stack.quiesce();
    const [[normal, reverse]] = await stack.cards(1, 2);
    // The reverse entry now names another product: lookup drift for that Edition only.
    source.records.set(normal.card, [
      {
        descriptor: { finish: "normal" },
        variant: "normal",
        productId: normal.productId,
        price: "1.11",
        updated: PROVIDER_TIME,
      },
      {
        descriptor: { finish: "reverse-holofoil" },
        variant: "reverse-holofoil",
        productId: reverse.productId + 1,
        price: "2.22",
        updated: PROVIDER_TIME,
      },
    ]);
    const before = await state(reverse);
    const { value: response, processes } = await watched(async () => {
      const response = await stack.prices(0, [normal.id, reverse.id]);
      await waitFor(async () => (await state(reverse)).backoff, "the backoff");
      return response;
    });
    expect(response.rows[normal.id]).toMatchObject({
      refresh: "refreshed",
      status: "quote",
      amount: "1.11",
    });
    expect(response.rows[reverse.id].refresh).toBe("failed");
    expect(response.rows[reverse.id].amount).toBeNull();
    const written = await state(normal);
    expect(written.result.value).toMatchObject({ state: "quote", attempt: 1 });
    expect(written.quote.value).toMatchObject({
      amount: "1.11",
      provider_updated_at: PROVIDER_TIME,
    });
    const sibling = await state(reverse);
    expect(sibling.result.version).toBe(before.result.version);
    expect(sibling.quote.version).toBe(before.quote.version);
    expect(sibling.backoff).toMatchObject({ reason: "lookup_drift" });
    expect(source.requests(normal.card)).toHaveLength(1); // both Editions were claimed together for one fetch
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `partial: answered after ${response.elapsed.toFixed(0)} ms (must beat the ~2500 ms wait)`
    );
  }, 30_000);

  it("unchanged provider time: the check advances, the provider time stays the source's own", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1, 1, "2.50");
    await stack.seedQuote(edition, "2.50", 25 * HOUR, PROVIDER_TIME);
    const { value: response, processes } = await watched(() =>
      stack.prices(1, [edition.id])
    );
    expect(response.rows[edition.id]).toMatchObject({
      refresh: "refreshed",
      amount: "2.50",
      provider_updated_at: PROVIDER_TIME,
    });
    const after = await state(edition);
    expect(after.result.value.attempt).toBe(2);
    expect(Date.parse(after.result.value.checked_at)).toBeGreaterThan(
      Date.now() - 60_000
    );
    expect(after.quote.value).toMatchObject({
      attempt: 2,
      amount: "2.50",
      provider_updated_at: PROVIDER_TIME,
    });
    expect(source.requests(edition.card)).toHaveLength(1);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
  }, 30_000);

  it("timeout (AC9): a hanging source answers a labelled fallback within three seconds, then is backed off", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    await stack.seedQuote(edition, "0.42", 25 * HOUR, PROVIDER_TIME);
    const before = await state(edition);
    source.behaviour.set(edition.card, { kind: "hang" });
    const { value: response, processes } = await watched(async () => {
      const response = await stack.prices(0, [edition.id]);
      await waitFor(async () => (await state(edition)).backoff, "the backoff");
      return response;
    });
    // The runner's own 2 s source deadline usually ends inside the 2.5 s wait window when the runner starts quickly, so
    // the row is then labelled failed rather than timeout; either way it is a labelled fallback with the cached quote.
    expect(["timeout", "failed"]).toContain(response.rows[edition.id].refresh);
    expect(response.rows[edition.id].amount).toBe("0.42");
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    const after = await state(edition);
    expect(after.backoff).toMatchObject({ reason: "timeout" });
    expect(after.result.version).toBe(before.result.version);
    expect(after.quote.version).toBe(before.quote.version);
    expect(source.requests(edition.card)).toHaveLength(1); // the 2 s deadline left no room for a retry
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `hanging source: ${response.rows[edition.id].refresh} after ${response.elapsed.toFixed(0)} ms (bound 3000)`
    );
  }, 30_000);

  it("timeout (AC9): when the hung fetch outlasts the wait window the row is labelled timeout within three seconds", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    await stack.seedQuote(edition, "0.44", 25 * HOUR, PROVIDER_TIME);
    source.behaviour.set(edition.card, { kind: "hang" });
    // A dry bucket delays the claim by a second, so the runner's 2 s source deadline ends after the request's wait.
    await stack.cas([SCHEDULER], () => ({ [SCHEDULER]: emptyScheduler(0) }));
    const { value: response, processes } = await watched(async () => {
      const response = await stack.prices(1, [edition.id]);
      await waitFor(async () => (await state(edition)).backoff, "the backoff");
      return response;
    });
    expect(response.rows[edition.id].refresh).toBe("timeout");
    expect(response.rows[edition.id].amount).toBe("0.44");
    expect(Date.parse(response.rows[edition.id].checked_at!)).toBeLessThan(
      Date.now() - 24 * HOUR
    );
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    expect((await state(edition)).backoff).toMatchObject({ reason: "timeout" });
    expect(source.requests(edition.card)).toHaveLength(1);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `timeout label after ${response.elapsed.toFixed(0)} ms (bound 3000)`
    );
  }, 30_000);
});

// ================================================================ AC1 + AC8: launches that fail, and recovery
describe("failed launch, cancellation and restart", () => {
  it("failed launch: nothing starts and the jobs stay queued; the next access launches and completes them (AC1)", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    stack.breakLaunches();
    let first;
    try {
      first = await stack.prices(0, [edition.id]);
    } finally {
      stack.repairLaunches();
    }
    expect(first.rows[edition.id].refresh).toBe("busy");
    expect(first.elapsed).toBeLessThan(1_500); // refused at once instead of sitting out the wait
    await refused("launch_failed"); // the reason, recorded by the post-response release
    expect(await jobsOf()).toEqual([edition.ref]);
    expect(source.requests(edition.card)).toHaveLength(0);
    expect((await runners.counts()).live).toEqual([]);
    expect(await stack.read(LEASES)).toMatchObject({
      [LEASES[0]]: { value: null },
      [LEASES[1]]: { value: null },
    });
    const { value: second, processes } = await watched(() =>
      stack.prices(1, [edition.id])
    );
    expect(second.rows[edition.id]).toMatchObject({
      refresh: "refreshed",
      status: "quote",
      amount: "1.25",
    });
    expect(source.requests(edition.card)).toHaveLength(1);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `failed launch: busy after ${first.elapsed.toFixed(0)} ms (bound 1500); recovery refreshed after ${second.elapsed.toFixed(0)} ms`
    );
  }, 30_000);

  it("cancellation: a job that expires before it is claimed is never fetched", async () => {
    await stack.quiesce();
    const [[stale], [live]] = await stack.cards(2);
    stack.breakLaunches();
    try {
      expect((await stack.prices(0, [stale.id])).rows[stale.id].refresh).toBe(
        "busy"
      );
    } finally {
      stack.repairLaunches();
    }
    // Age the queued job: admitted 58.5 s ago, so its fixed 60 s lifetime ends in 1.5 s (its work: record agrees).
    const jobId = `${stale.ref}:${stale.revision}`;
    const expires = Date.now() + 1_500;
    const aged = { admitted_ms: expires - 60_000, expires_ms: expires };
    await stack.cas([SCHEDULER, keyOf("work", stale)], (rows) => {
      const sched = rows[SCHEDULER].value;
      Object.assign(sched.jobs[jobId], aged);
      return {
        [SCHEDULER]: sched,
        [keyOf("work", stale)]: {
          ...rows[keyOf("work", stale)].value,
          ...aged,
        },
      };
    });
    source.delayMs = 1_500; // the live fetch keeps the runner busy past the stale job's expiry
    const { value: expired, processes } = await watched(async () => {
      await stack.prices(1, [live.id]);
      await waitFor(
        async () => (await jobsOf()).length === 0,
        "the queue to drain"
      );
      return (await stack.get(SCHEDULER)).stats.expired;
    });
    expect(source.requests(stale.card)).toHaveLength(0);
    expect(source.requests(live.card)).toHaveLength(1);
    const dropped = await state(stale);
    expect(dropped.result.value).toBeNull();
    expect(dropped.backoff).toBeNull(); // cancelled: no backoff and no check age
    expect(dropped.work).toBeNull();
    expect(expired).toBe(1); // dropped as expired, by admission or by the runner, never claimed
    expect((await state(live)).result.value).toMatchObject({ state: "quote" });
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
  }, 30_000);

  it("restart: a worker killed mid-fetch is cleaned up by its supervisor and a new runner picks up the requeued job", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    source.behaviour.set(edition.card, { kind: "hold" });
    let killed: number | null = null;
    source.onArrive = (request) => {
      if (request.card === edition.card && killed === null) {
        if (!runners.isWorker(request.pid)) throw new Error("not our worker");
        killed = request.pid;
        process.kill(request.pid!, "SIGKILL");
      }
    };
    const stop = runners.watch();
    const first = await stack.prices(0, [edition.id]);
    expect(killed).not.toBeNull();
    // The supervisor saw a crashed worker: the job is requeued, the slot freed, and nothing hands off.
    await waitFor(
      async () => (await runners.live()).length === 0,
      "the runner to exit"
    );
    await waitFor(
      async () =>
        (await stack.read(LEASES))[LEASES[0]].value === null &&
        (await stack.read(LEASES))[LEASES[1]].value === null,
      "the slot to be freed"
    );
    const sched = await stack.get(SCHEDULER);
    expect(Object.values<any>(sched.jobs).map((job) => job.state)).toEqual([
      "queued",
    ]);
    expect(sched.source).toEqual({});
    expect(["timeout", "busy", "failed"]).toContain(
      first.rows[edition.id].refresh
    );
    source.behaviour.set(edition.card, { kind: "ok" });
    const second = await stack.prices(1, [edition.id]);
    await stack.quiesce();
    const processes = await stop();
    expect(second.rows[edition.id]).toMatchObject({
      refresh: "refreshed",
      amount: "1.25",
    });
    const requests = source.requests(edition.card);
    expect(requests).toHaveLength(2);
    expect(requests[1].pid).not.toBe(killed); // a different runner
    expect((await state(edition)).result.value.attempt).toBe(2);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `restart: first ${first.rows[edition.id].refresh}, new runner refreshed after ${second.elapsed.toFixed(0)} ms`
    );
  }, 40_000);
});

// ================================================================ AC8: pause and crash with real signals
describe("pause and crash", () => {
  it("pause (SIGSTOP): the slot is not replaced, the row answers busy at once, and after SIGCONT the work completes", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    source.behaviour.set(edition.card, { kind: "hold" });
    let group: number | null = null;
    let stoppedAt = 0;
    source.onArrive = (request) => {
      if (request.card === edition.card && group === null) {
        group = request.pgid;
        runners.signalGroup(group, "SIGSTOP"); // stopped while its fetch is in flight
        stoppedAt = performance.now();
      }
    };
    const stop = runners.watch();
    let window = 0;
    let busyAfter = 0;
    try {
      const pending = stack.prices(0, [edition.id]);
      await waitFor(() => group !== null, "the fetch to arrive");
      const slot = Number(source.requests(edition.card)[0].slot);
      const owner = (await stack.get(LEASES[slot])).owner;
      await stack.expireLease(slot); // what 10 s of a frozen runner looks like
      const before = await runners.counts();
      const uncertain = await stack.prices(1, [edition.id]);
      busyAfter = uncertain.elapsed;
      expect(uncertain.rows[edition.id].refresh).toBe("busy");
      expect(uncertain.elapsed).toBeLessThan(1_500);
      expect((await stack.get(LEASES[slot])).owner).toBe(owner); // never replaced
      expect(await runners.counts()).toEqual(before); // nothing new launched
      expect(before).toMatchObject({ supervisors: 1, workers: 1 });
      source.release(edition.card); // the answer waits in the socket while the runner is stopped
      runners.signalGroup(group, "SIGCONT");
      window = performance.now() - stoppedAt;
      await pending;
      await refused("runner_uncertain"); // busy because the slot is uncertain, not launch_failed/no_runner
    } finally {
      try {
        if (group !== null) runners.signalGroup(group, "SIGCONT");
      } catch {
        /* already exited */
      }
    }
    metric(
      `pause: busy/runner_uncertain after ${busyAfter.toFixed(0)} ms (bound 1500); SIGSTOP held ${window.toFixed(0)} ms (the fetch deadline is 2000 ms)`
    );
    await waitFor(
      async () => (await state(edition)).result.value?.state === "quote",
      "the resumed runner's write"
    );
    await stack.quiesce();
    const processes = await stop();
    expect((await state(edition)).result.value.attempt).toBe(1);
    expect(source.requests(edition.card)).toHaveLength(1);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
  }, 40_000);

  it("crash (SIGKILL): the next access reclaims the slot through the lock and costs exactly one extra fetch", async () => {
    await stack.quiesce();
    const [[edition]] = await stack.cards(1);
    source.behaviour.set(edition.card, { kind: "hold" });
    let group: number | null = null;
    source.onArrive = (request) => {
      if (request.card === edition.card && group === null) {
        group = request.pgid;
        runners.signalGroup(group, "SIGKILL");
      }
    };
    const stop = runners.watch();
    await stack.prices(0, [edition.id]);
    expect(group).not.toBeNull();
    await waitFor(
      async () => (await runners.live()).length === 0,
      "the killed runner to be gone"
    );
    const slot = Number(source.requests(edition.card)[0].slot);
    const dead = await stack.get(LEASES[slot]);
    expect(dead.state).toBe("running"); // nobody cleaned up: both processes died at once
    await stack.expireLease(slot);
    source.behaviour.set(edition.card, { kind: "ok" });
    source.onArrive = null;
    const after = await stack.prices(1, [edition.id]);
    await stack.quiesce();
    const processes = await stop();
    expect(after.rows[edition.id]).toMatchObject({
      refresh: "refreshed",
      amount: "1.25",
    });
    expect(source.requests(edition.card)).toHaveLength(2);
    expect((await state(edition)).result.value.attempt).toBe(2);
    expect(processes).toMatchObject({ supervisors: 1, workers: 1 });
    metric(
      `crash: reclaimed and refreshed after ${after.elapsed.toFixed(0)} ms`
    );
  }, 40_000);
});

// ================================================================ AC2: caps across processes, through admission
describe("caps across two APIs, two runners and five callers", () => {
  it("40 jobs from five users never exceed two runners, eight fetches, four per slot or two per caller", async () => {
    await stack.quiesce();
    const groups = await stack.cards(20, 2); // 20 cards x 2 Editions = 40 jobs, 4 cards per user
    groups.forEach((group, index) =>
      source.callers.set(group[0].card, stack.users[index % 5].caller)
    );
    source.resetPeaks();
    const logged = source.log.length;
    source.delayMs = 900;
    const stop = runners.watch();
    // Phase 1: all five users ask at once, alternating replicas, while launches fail, so the whole load is queued before
    // any runner claims (otherwise the 1/s bucket, not the permits, would bound concurrency). Concurrent admissions contend
    // on one scheduler record (two CAS tries each), so a user whose rows are not queued yet asks again, as the next page
    // view would.
    const mine = (user: number) =>
      groups.filter((_, index) => index % 5 === user).flat();
    const responses: Array<Awaited<ReturnType<typeof stack.prices>>> = [];
    let rounds = 0;
    let busy = 0;
    stack.breakLaunches();
    try {
      for (
        let pending = [0, 1, 2, 3, 4];
        pending.length && rounds < 10;
        rounds++
      ) {
        const answers = await Promise.all(
          pending.map((user) =>
            stack.prices(
              (user + rounds) % 2,
              mine(user).map((e) => e.id),
              user
            )
          )
        );
        responses.push(...answers);
        const jobs = (await stack.get(SCHEDULER))?.jobs ?? {};
        busy += answers.filter((answer) =>
          Object.values(answer.rows).some((row) => row.refresh === "busy")
        ).length;
        pending = pending.filter(
          (user) => !mine(user).every((e) => `${e.ref}:${e.revision}` in jobs)
        );
      }
    } finally {
      stack.repairLaunches();
    }
    expect(Object.keys((await stack.get(SCHEDULER)).jobs)).toHaveLength(40);
    expect(source.log.length).toBe(logged); // nothing ran yet
    // Phase 2: the next access finds 40 queued jobs and no runner, and reserves both slots.
    responses.push(
      await stack.prices(
        1,
        mine(0).map((e) => e.id),
        0
      )
    );
    await waitFor(
      async () => {
        const rows = await stack.read(
          groups.flat().map((e) => keyOf("result", e))
        );
        return Object.values(rows).every((row) => row.value?.state === "quote");
      },
      "all 40 quotes",
      45_000,
      200
    );
    await stack.quiesce();
    const processes = await stop();
    for (const response of responses) expect(response.status).toBe(200);
    expect(processes.supervisors).toBeLessThanOrEqual(2);
    expect(processes.workers).toBeLessThanOrEqual(2);
    expect(processes.workers).toBe(2); // the queue really called for both slots
    expect(source.peak.all).toBeLessThanOrEqual(8);
    expect(source.peak.all).toBeGreaterThan(4); // more than one runner's worth at once
    expect([...source.peak.slot.keys()].sort()).toEqual(["0", "1"]);
    for (const [, peak] of source.peak.slot)
      expect(peak).toBeLessThanOrEqual(4);
    for (const user of stack.users)
      expect(source.peak.caller.get(user.caller) ?? 0).toBeLessThanOrEqual(2);
    for (const group of groups)
      expect(source.requests(group[0].card)).toHaveLength(1);
    metric(
      `caps: admission rounds=${rounds} busy answers=${busy} processes ${JSON.stringify({ s: processes.supervisors, w: processes.workers, samples: processes.samples.length })} ` +
        `fetches all=${source.peak.all} slot=${JSON.stringify([...source.peak.slot])} caller=${JSON.stringify([...source.peak.caller.values()])}`
    );
  }, 90_000);

  it("with an empty bucket, fetches are about one second apart", async () => {
    await stack.quiesce();
    const cards = (await stack.cards(4)).map((group) => group[0]);
    const emptied = Date.now();
    await stack.cas([SCHEDULER], () => ({
      [SCHEDULER]: emptyScheduler(0, emptied),
    }));
    const { processes } = await watched(async () => {
      await stack.prices(
        0,
        cards.map((e) => e.id)
      );
      await waitFor(
        () => cards.every((e) => source.requests(e.card).length === 1),
        "four fetches",
        15_000
      );
    });
    const arrivals = cards
      .map((e) => source.requests(e.card)[0].at)
      .sort((a, b) => a - b);
    // Token k is available k+1 seconds after the bucket was emptied; a fetch can be later, never earlier.
    arrivals.forEach((at, k) =>
      expect(at - emptied).toBeGreaterThanOrEqual((k + 1) * 1_000 - 150)
    );
    const gaps = arrivals.slice(1).map((at, k) => at - arrivals[k]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(mean).toBeGreaterThanOrEqual(800);
    expect(mean).toBeLessThanOrEqual(1_600);
    expect(processes.workers).toBeGreaterThanOrEqual(1);
    metric(
      `empty-bucket gaps ms: ${gaps.join(", ")} (first after ${arrivals[0] - emptied})`
    );
  }, 40_000);
});

// ================================================================ AC1: no runner ever reached PostgreSQL
describe("runners and PostgreSQL", () => {
  it("no launched runner connected to the fake PostgreSQL port, or to anything but the record store and the source", async () => {
    await stack.quiesce();
    const supervisors = runners
      .registered()
      .filter((r) => r.role === "supervisor");
    expect(supervisors.length).toBeGreaterThanOrEqual(10); // every scenario above launched real runners
    expect(stack.fakePgConnections).toBe(0);
    const relayPort = Number(new URL(stack.relayUrl).port);
    const destinations = new Set(
      runners.connects().map((entry) => JSON.stringify(entry.address))
    );
    expect(destinations.size).toBeGreaterThan(0);
    for (const destination of destinations) {
      const address = JSON.parse(destination);
      expect(Array.isArray(address), destination).toBe(true); // no unix socket (libpq's default) either
      expect(["127.0.0.1", "::1", "localhost"]).toContain(address[0]);
      expect([relayPort, source.port]).toContain(address[1]);
    }
    await sleep(0);
  });
});
