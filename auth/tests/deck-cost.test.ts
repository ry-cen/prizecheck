// @module-tag slow
// slow (process): the price stack (two gateways, two APIs, the record-store relay) and the real 3 s price budget.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  metric,
  SCHEDULER,
  Stack,
  type Edition,
} from "./price-runners-harness";

// Ticket 09 through ADR 0019: complete private Deck costs through the real gateways read the imported TCGCSV prices from
// PostgreSQL only. Nothing admits a refresh, fetches a source or touches the record store; every elapsed time is measured
// from outside the gateway with a real clock. (The API suite covers the arithmetic; this proves the routing and the
// budget end to end.)
const stack = new Stack();
const source = stack.source;
const HOUR = 3_600_000;
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

const SUB_TYPES: Record<string, string> = {
  normal: "Normal",
  "reverse-holofoil": "Reverse Holofoil",
};
const user = () => stack.users[0];

/** What the daily import and `rebind` store for one Edition: the market price (null for none) and the binding to it. */
async function price(edition: Edition, market: string | null, updated: string) {
  const subType = SUB_TYPES[edition.variant];
  await stack.pool.query(
    `INSERT INTO tcgplayer_price(product_id,sub_type_name,market_price,seen_at,source_updated_at)
     VALUES ($1,$2,$3::numeric,now(),$4) ON CONFLICT (product_id,sub_type_name)
     DO UPDATE SET market_price=EXCLUDED.market_price,source_updated_at=EXCLUDED.source_updated_at`,
    [edition.productId, subType, market, updated]
  );
  await stack.pool.query(
    `INSERT INTO edition_price_binding(edition_id,product_id,mapping_revision,sub_type_name) VALUES ($1,$2,$3,$4)
     ON CONFLICT (edition_id) DO UPDATE SET product_id=EXCLUDED.product_id,
     mapping_revision=EXCLUDED.mapping_revision,sub_type_name=EXCLUDED.sub_type_name,reason=NULL`,
    [edition.id, edition.productId, edition.revision, subType]
  );
}

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

describe("a complete private Deck through the gateways", () => {
  it("prices the six-copy example as $1.61 and 5/6 from PostgreSQL alone: provider age stays stale, a row with no market price stays unpriced, and nothing is fetched or admitted", async () => {
    await stack.quiesce();
    const [[fresh], [stale], [gone]] = await stack.cards(3);
    await price(fresh, "0.25", ago(HOUR));
    await price(stale, "0.43", ago(72 * HOUR));
    await price(gone, null, ago(HOUR)); // a matching block without a market price
    const deck = await deckWith([
      [fresh, 3],
      [stale, 2],
      [gone, 1],
    ]);
    const before = await stack.read([SCHEDULER]);
    const response = await cost(0, deck);
    expect(response.status).toBe(200);
    expect(response.elapsed).toBeLessThanOrEqual(3_000);
    expect(response.cost).toMatchObject({
      status: "priced",
      amount: "1.61",
      display_amount: "$1.61",
      priced_copies: "5",
      total_copies: "6",
      stale_copies: "2", // the provider's own time is 72 h old
      unknown_age_copies: "0",
      fallback_copies: "0", // there is no refresh label any more
      owner_revision: await revision(),
    });
    for (const edition of [fresh, stale, gone])
      expect(source.requests(edition.card)).toEqual([]);
    expect(await stack.read([SCHEDULER])).toEqual(before);
    metric(
      `deck six-copy cost: ${response.elapsed.toFixed(0)} ms (bound 3000)`
    );
  }, 60_000);

  it("answers a whole Deck of 34 Editions at once, keeps checks and inventory writes responsive, and names the captured revision", async () => {
    await stack.quiesce();
    const cards = await stack.cards(17, 2);
    const editions = cards.flat();
    for (const edition of editions) await price(edition, "0.50", ago(HOUR));
    const deck = await deckWith(editions.map((edition) => [edition, 2]));
    const captured = await revision();
    const before = await stack.read([SCHEDULER]);
    const response = await cost(1, deck);
    const checks = await gateway(0, "GET", `/api/decks/${deck}`);
    // An inventory write serialized on the same owner row the capture locked.
    const added = await gateway(0, "POST", "/api/decks", {
      name: `Another ${randomUUID().slice(0, 8)}`,
      idempotency_key: randomUUID(),
    });
    expect(checks.status).toBe(200);
    expect(checks.json.checks.total).toBe("68");
    expect(checks.elapsed).toBeLessThan(1_000);
    expect(added.status).toBe(201);
    expect(added.elapsed).toBeLessThan(1_000);
    expect(response.status).toBe(200);
    expect(response.elapsed).toBeLessThan(1_500); // no wait for any source
    expect(response.cost).toMatchObject({
      status: "priced",
      owner_revision: captured,
      priced_copies: "68",
      total_copies: "68",
      amount: "34",
      fallback_copies: "0",
    });
    expect(await revision()).toBe(captured + 1); // the write moved it: the browser would ask again
    expect(await stack.read([SCHEDULER])).toEqual(before);
    metric(
      `deck of 34 Editions: ${response.elapsed.toFixed(0)} ms (bound 1500); checks ${checks.elapsed.toFixed(0)} ms, inventory write ${added.elapsed.toFixed(0)} ms`
    );
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
