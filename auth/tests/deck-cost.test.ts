import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOUR,
  keyOf,
  LEASES,
  metric,
  SCHEDULER,
  sleep,
  Stack,
  waitFor,
  type Edition,
} from "./price-runners-harness";

// Ticket 09: complete private Deck costs through the real gateways, two APIs, the shared record store (HTTP relay) and
// real runners fetching from a fake TCGdex. Every elapsed time is measured from outside the gateway with a real clock.
const stack = new Stack();
const source = stack.source;
const ago = (ms: number) =>
  new Date(Math.floor((Date.now() - ms) / 1000) * 1000).toISOString();

beforeAll(async () => {
  await stack.start();
  await stack.signIn([stack.ownerEmail]);
  await stack.pool.query(
    "INSERT INTO inventory_owner(user_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [stack.users[0].id]
  );
}, 120_000);

afterAll(async () => {
  await stack.stop();
}, 60_000);

type Cost = {
  status: string;
  reason: string | null;
  owner_revision: number | null;
  total_copies: string | null;
  priced_copies: string | null;
  stale_copies: string | null;
  unknown_age_copies: string | null;
  fallback_copies: string | null;
  amount: string | null;
  display_amount: string | null;
};

const user = () => stack.users[0];
async function deckWith(quantities: Array<[Edition, number]>) {
  const deck = randomUUID();
  await stack.pool.query(
    "INSERT INTO location(id,owner_id,name,kind) VALUES ($1,$2,$3,'deck')",
    [deck, user().id, `Deck ${deck}`]
  );
  for (const [edition, quantity] of quantities)
    await stack.pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES ($1,$2,$3,$4,1)",
      [user().id, deck, edition.id, quantity]
    );
  await stack.pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user().id]
  );
  return deck;
}
async function gateway(
  replica: number,
  method: string,
  path: string,
  body?: object
) {
  const started = performance.now();
  const response = await fetch(stack.gateways[replica] + path, {
    method,
    headers: {
      origin: stack.origin,
      "content-type": "application/json",
      cookie: user().cookie,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  return {
    status: response.status,
    elapsed: performance.now() - started,
    json,
  };
}
async function cost(replica: number, deck: string) {
  const answer = await gateway(replica, "GET", `/api/decks/${deck}/cost`);
  return { ...answer, cost: answer.json as Cost };
}
const revision = async () =>
  Number(
    (
      await stack.pool.query(
        "SELECT revision FROM inventory_owner WHERE user_id=$1",
        [user().id]
      )
    ).rows[0].revision
  );
/** Teaches the fake source one Edition's answer: a price (or null for a confirmed absence) and the provider's time. */
function answer(edition: Edition, price: string | null, updated: string) {
  source.records.set(edition.card, [
    {
      descriptor: { finish: edition.variant },
      variant: edition.variant,
      productId: edition.productId,
      price,
      updated,
    },
  ]);
}

describe("a complete private Deck through the gateways", () => {
  it("prices the six-copy example as $1.61 and 5/6, with a runner refreshing inside the one budget: check age renews, provider age stays stale, and a confirmed absence replaces an old quote", async () => {
    await stack.quiesce();
    const [[fresh], [stale], [gone]] = await stack.cards(3);
    await stack.seedQuote(fresh, "0.25", 10 * 60_000, ago(HOUR));
    // Both day-old checks are hard rows: the access admits them once, and the runner answers inside the wait window.
    await stack.seedQuote(stale, "0.40", 25 * HOUR, ago(80 * HOUR));
    await stack.seedQuote(gone, "9.99", 25 * HOUR, ago(HOUR));
    answer(stale, "0.43", ago(72 * HOUR));
    answer(gone, null, ago(HOUR)); // a matching block without a price: confirmed absent
    const deck = await deckWith([
      [fresh, 3],
      [stale, 2],
      [gone, 1],
    ]);
    const response = await cost(0, deck);
    expect(response.status).toBe(200);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    expect(response.cost).toMatchObject({
      status: "priced",
      amount: "1.61",
      display_amount: "$1.61",
      priced_copies: "5",
      total_copies: "6",
      stale_copies: "2", // freshly checked, but the provider's own time is 72 h old
      unknown_age_copies: "0",
      fallback_copies: "0",
      owner_revision: await revision(),
    });
    const rows = await stack.read([
      keyOf("result", stale),
      keyOf("result", gone),
      keyOf("quote", gone),
    ]);
    expect(
      Date.parse(rows[keyOf("result", stale)].value.checked_at)
    ).toBeGreaterThan(Date.now() - 60_000);
    expect(rows[keyOf("result", gone)].value.state).toBe("absent");
    expect(rows[keyOf("quote", gone)].value).toBeNull(); // the $9.99 quote never reaches any later subtotal
    metric(
      `deck six-copy refresh: ${response.elapsed.toFixed(0)} ms (bound 3000)`
    );
    await stack.quiesce();
  }, 60_000);

  it("gives a whole Deck of hard rows one three-second budget against a hanging source, keeps checks and inventory writes responsive, and names the captured revision", async () => {
    await stack.quiesce();
    const cards = await stack.cards(17, 2); // 34 Editions: more than one access may admit
    const editions = cards.flat();
    for (const edition of editions) {
      await stack.seedQuote(edition, "0.50", 25 * HOUR, ago(HOUR));
      source.behaviour.set(edition.card, { kind: "hang" });
    }
    const deck = await deckWith(editions.map((edition) => [edition, 2]));
    const captured = await revision();
    const pending = cost(1, deck);
    await waitFor(
      async () =>
        Object.keys((await stack.get(SCHEDULER))?.jobs ?? {}).length > 0,
      "the Deck's admission"
    );
    // While the cost waits for the source, the rest of the Deck page and an inventory write do not.
    const checks = await gateway(0, "GET", `/api/decks/${deck}`);
    // An inventory write serialized on the same owner row the capture locked.
    const added = await gateway(0, "POST", "/api/decks", {
      name: `Another ${randomUUID().slice(0, 8)}`,
      idempotency_key: randomUUID(),
    });
    const response = await pending;
    expect(checks.status).toBe(200);
    expect(checks.json.checks.total).toBe("68");
    expect(checks.elapsed).toBeLessThan(1_000);
    expect(added.status).toBe(201);
    expect(added.elapsed).toBeLessThan(1_000);
    expect(response.status).toBe(200);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    expect(response.elapsed).toBeGreaterThan(1_500); // it did wait, once, for the whole Deck
    expect(response.cost).toMatchObject({
      status: "priced",
      owner_revision: captured,
      priced_copies: "68",
      total_copies: "68",
      amount: "34",
      fallback_copies: "68", // every copy is the labelled cached fallback
    });
    expect(await revision()).toBe(captured + 1); // the browser discards this answer and asks again
    const sched = await stack.get(SCHEDULER);
    expect(sched.stats.admitted).toBe(32);
    metric(
      `deck hard expiry, 34 Editions, hanging source: ${response.elapsed.toFixed(0)} ms (bound 3000); checks ${checks.elapsed.toFixed(0)} ms, inventory write ${added.elapsed.toFixed(0)} ms (bound 1000)`
    );
    for (const edition of editions) source.behaviour.delete(edition.card);
    await stack.quiesce();
  }, 90_000);

  it("keeps cached quotes and numeric coverage through a source outage, and answers a slow store inside the budget", async () => {
    await stack.quiesce();
    const [[down], [cached], [never]] = await stack.cards(3);
    await stack.seedQuote(down, "1.00", 25 * HOUR, ago(HOUR));
    await stack.seedQuote(cached, "2.00", 10 * 60_000, ago(HOUR));
    for (const edition of [down, never])
      source.behaviour.set(edition.card, { kind: "status", code: 503 });
    const deck = await deckWith([
      [down, 1],
      [cached, 2],
      [never, 3],
    ]);
    const outage = await cost(0, deck);
    expect(outage.elapsed).toBeLessThanOrEqual(3_000);
    expect(outage.cost).toMatchObject({
      status: "priced",
      amount: "5",
      priced_copies: "3",
      total_copies: "6",
      fallback_copies: "4", // the failed refreshes: one cached copy, three never cached
    });

    for (const edition of [down, never]) source.behaviour.delete(edition.card);
    await stack.quiesce();

    // A store whose writes stall: a new hard row needs an admission write, which gives up inside its own deadline. The
    // cached rows still count, the stalled row keeps its cached quote with a busy label, and the answer is in time.
    const [[stalled]] = await stack.cards(1);
    await stack.seedQuote(stalled, "3.00", 25 * HOUR, ago(HOUR));
    const second = await deckWith([
      [stalled, 1],
      [cached, 2],
    ]);
    const fault = join(stack.directory, "store", "faults", "delay-transact");
    mkdirSync(join(stack.directory, "store", "faults"), { recursive: true });
    writeFileSync(fault, "2.5");
    let slow;
    try {
      slow = await cost(1, second);
    } finally {
      rmSync(fault, { force: true });
    }
    expect(slow.status).toBe(200);
    expect(slow.elapsed).toBeLessThanOrEqual(3_000);
    expect(slow.cost).toMatchObject({
      status: "priced",
      amount: "7",
      priced_copies: "3",
      total_copies: "3",
      fallback_copies: "1",
    });
    metric(
      `deck outage: ${outage.elapsed.toFixed(0)} ms; stalled store writes: ${slow.elapsed.toFixed(0)} ms (bound 3000)`
    );
    // The stalled write lands late on the relay (a queued job and maybe a reservation nobody spawned into); clear it.
    await sleep(3_000);
    await stack.cas([SCHEDULER, ...LEASES], () => ({
      [SCHEDULER]: null,
      [LEASES[0]]: null,
      [LEASES[1]]: null,
    }));
  }, 90_000);

  it("answers an empty Deck with $0.00 at once and touches no coordination record", async () => {
    await stack.quiesce();
    const before = await stack.read([SCHEDULER]);
    const deck = await deckWith([]);
    const response = await cost(0, deck);
    expect(response.cost).toMatchObject({
      status: "empty",
      amount: "0",
      display_amount: "$0.00",
      total_copies: "0",
    });
    expect(response.elapsed).toBeLessThan(1_000);
    expect(await stack.read([SCHEDULER])).toEqual(before);
  }, 30_000);
});
