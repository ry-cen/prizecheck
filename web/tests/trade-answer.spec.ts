// Ticket #271: accept, decline or cancel a Trade (Trading spec "Answering a proposal" and "Cancelling a Trade",
// prototype verdict variant A; owner, 2026-10-20: withdraw, decline and cancel ask first, accept doesn't). Misty sends
// Ash four Trade Proposals through the API. Ash declines one and keeps it at the question, then accepts it whole, and
// both sides' cards leave their Trade Lists; an accept of a proposal that asks for more than he has left is refused with
// the card and the count; he declines another and Misty's cards come back. Misty withdraws a third, after keeping it
// once at the question, while Ash has it open, so his accept finds it changed and the screen reads it again. One side
// cancels the accepted Trade, after keeping it once at the question, and both lists are whole again: Misty, the
// proposer, at desktop width; Ash, the recipient, at 375 px. The catalog is the Swap catalog
// (api/tests/want_list_swap_fixtures.py). Ash signs in first, so the test's own page signs in afterwards as the owner.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

type Editions = Record<
  | "PAL 185"
  | "PAL 254"
  | "PAF 80"
  | "SVI 166"
  | "SVI 166 Reverse Holo"
  | "PAL 172",
  string
>;

/** The Swap catalog through the real catalog import (it replaces the catalog); returns the Edition ids by key. */
function seedCatalog(): Editions {
  const out = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from want_list_swap_fixtures import print_swap_catalog\nprint_swap_catalog()",
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }
  ).toString();
  return JSON.parse(out.slice(out.lastIndexOf("SWAP") + 4)) as Editions;
}

async function api(
  page: Page,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(
    true
  );
  return response.json();
}

/** Gives the signed-in collector this Display Name and a new Handle, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  await api(page, "PUT", "/api/profile/display-name", {
    display_name: name,
    idempotency_key: randomUUID(),
  });
  await api(page, "PUT", "/api/profile/handle", {
    handle,
    idempotency_key: randomUUID(),
  });
  return handle;
}

async function accountId(page: Page): Promise<string> {
  return (await api(page, "GET", "/auth/session")).userId as string;
}

/** A Friend Request from `from`, accepted by `to`, through the API. */
async function befriend(from: Page, to: Page) {
  await api(from, "POST", "/api/social/friend-requests", {
    collector_id: await accountId(to),
    idempotency_key: randomUUID(),
  });
  await api(
    to,
    "POST",
    `/api/social/friend-requests/${await accountId(from)}/accept`,
    { idempotency_key: randomUUID() }
  );
}

const hold = (
  page: Page,
  location: string,
  edition: string,
  quantity: number
) =>
  api(page, "POST", "/api/holdings", {
    location_id: location,
    edition_id: edition,
    quantity: String(quantity),
    idempotency_key: randomUUID(),
  });

/** A top-level binder, marked For trade; returns its id. */
async function forTradeBinder(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
    for_trade: true,
    version: location.version,
    idempotency_key: randomUUID(),
  });
  return location.id;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const more = (page: Page) =>
  page.getByRole("button", { name: "More for this Trade" });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

/** Misty sends Ash a Trade Proposal through the API; returns its id. */
async function propose(
  page: Page,
  to: string,
  give: [string, number][],
  get: [string, number][]
): Promise<string> {
  const line = ([edition_id, n]: [string, number]) => ({
    edition_id,
    quantity: String(n),
  });
  const trade = await api(page, "POST", "/api/trades", {
    recipient_id: to,
    you_give: give.map(line),
    you_get: get.map(line),
    idempotency_key: randomUUID(),
  });
  return trade.id as string;
}

/** The Trade as `page`'s collector reads it, through the API. */
const tradeState = async (page: Page, id: string) => {
  const trade = await api(page, "GET", `/api/social/trades/${id}`);
  return {
    state: trade.state as string,
    revision: trade.revision as number,
    actions: trade.actions as string[],
  };
};

/** How many copies of `card` the collector's own Trade List shows ("" when it isn't there). */
async function expectOwnCopies(page: Page, card: string, copies: string) {
  await page.goto(`${ORIGIN}/trades/list`);
  const main = page.getByRole("main");
  if (copies === "")
    await expect(main).toContainText("Your Trade List is empty.");
  else
    await expect(
      main.getByRole("listitem").filter({ hasText: card })
    ).toContainText(`×${copies}`);
}

/** How many copies of `card` the Friend's Trade List shows to `page`'s collector. */
async function expectFriendCopies(
  page: Page,
  handle: string,
  card: string,
  copies: string
) {
  await page.goto(`${ORIGIN}/friends/${handle}/trade-list`);
  await expect(
    page.getByRole("main").getByRole("list", { name: card, exact: true })
  ).toContainText(`×${copies}`);
}

/** The whole story. `canceller` is the side that cancels the accepted Trade. */
async function story(
  page: Page,
  collectors: {
    signIn: (options?: {
      next?: string;
      contextOptions?: BrowserContextOptions;
    }) => Promise<{ page: Page }>;
  },
  contextOptions: BrowserContextOptions,
  width: string,
  canceller: "proposer" | "recipient"
) {
  const ids = seedCatalog();
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  const ash = await collectors.signIn({ contextOptions });
  const ashHandle = await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, `${secret} Shelf`);
  await hold(ash.page, shelf, ids["SVI 166"], 2);

  await noArtwork(page);
  await noArtwork(ash.page);
  await signInAsOwner(page, "/collection");
  const mistyHandle = await nameCollector(page, "Misty W");
  const binder = await forTradeBinder(page, `${secret} Binder`);
  await hold(page, binder, ids["PAL 185"], 3);
  await befriend(page, ash.page);
  // Everything about Trades that reaches either browser, to check it never names the other side's Location.
  const answers: { body: Promise<string>; secretOf: string[] }[] = [];
  for (const [who, theirs] of [
    [ash.page, [`${secret} Binder`, binder]],
    [page, [`${secret} Shelf`, shelf]],
  ] as const)
    who.on("response", (response) => {
      if (/\/api\/(social\/)?trade/.test(response.url()))
        answers.push({ body: response.text(), secretOf: [...theirs] });
    });

  const ashId = await accountId(ash.page);
  const iono = ids["PAL 185"];
  const arven = ids["SVI 166"];
  // A swap, an ask for both of Ash's Arven, and two gifts of one Iono each: all three of Misty's Iono are promised.
  const swap = await propose(page, ashId, [[iono, 1]], [[arven, 1]]);
  const askBoth = await propose(page, ashId, [], [[arven, 2]]);
  const declined = await propose(page, ashId, [[iono, 1]], []);
  const withdrawn = await propose(page, ashId, [[iono, 1]], []);

  // A: Ash opens the swap. Decline asks first, and Keep it leaves the proposal as it was.
  await ash.page.goto(`${ORIGIN}/trades/${swap}`);
  await expect(heading(ash.page)).toHaveText(
    "Misty W sent you a Trade Proposal"
  );
  const ashMain = ash.page.getByRole("main");
  await expect(ashMain.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(more(ash.page)).toHaveCount(0);
  await expectPageChecks(ash.page, `a received Trade Proposal at ${width}`);
  await ashMain.getByRole("button", { name: "Decline" }).click();
  const declining = ashMain.getByRole("group", { name: "Decline" });
  await expect(declining).toContainText("Decline Misty W's Trade Proposal?");
  await expect(
    declining.getByRole("button", { name: "Decline" })
  ).toBeFocused();
  await expect(ashMain.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expectPageChecks(ash.page, `the Decline question at ${width}`);
  await declining.getByRole("button", { name: "Keep it" }).click();
  await expect(declining).toHaveCount(0);
  await expect(ashMain.getByRole("button", { name: "Decline" })).toBeFocused();
  await expect(heading(ash.page)).toHaveText(
    "Misty W sent you a Trade Proposal"
  );
  expect(await tradeState(ash.page, swap)).toMatchObject({
    state: "proposed",
    revision: 1,
  });

  // Accepting asks nothing: the proposal becomes a Trade, and Ash's Arven leaves both reads of his Trade List.
  await ashMain.getByRole("button", { name: "Accept" }).click();
  await expect(heading(ash.page)).toHaveText("Ready to swap with Misty W");
  await expect(heading(ash.page)).toBeFocused();
  await expect(toast(ash.page)).toContainText(
    "Accepted. Swap the cards in person, then confirm."
  );
  await expect(ashMain.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(ashMain.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expect(more(ash.page)).toHaveCount(1);
  await expectPageChecks(ash.page, `an accepted Trade at ${width}`);
  await expectOwnCopies(ash.page, "Arven", "1");
  await expectFriendCopies(page, ashHandle, "Arven", "1");
  await expectOwnCopies(page, "Iono", "");

  // B: the ask for both Arven can't be accepted now: one is promised to the swap.
  await ash.page.goto(`${ORIGIN}/trades/${askBoth}`);
  await ashMain.getByRole("button", { name: "Accept" }).click();
  await expect(ashMain.getByRole("alert")).toHaveText(
    "You can trade only 1 Arven (SVI 166) now, so you can't accept this. Send a Counter or decline it instead."
  );
  await expect(heading(ash.page)).toHaveText(
    "Misty W sent you a Trade Proposal"
  );
  expect((await tradeState(ash.page, askBoth)).state).toBe("proposed");

  // Ash declines one of the gifts, and Misty's Iono comes back to her Trade List and to his read of it.
  await ash.page.goto(`${ORIGIN}/trades/${declined}`);
  await ashMain.getByRole("button", { name: "Decline" }).click();
  await ashMain
    .getByRole("group", { name: "Decline" })
    .getByRole("button", { name: "Decline" })
    .click();
  await expect(heading(ash.page)).toHaveText("You declined");
  await expect(toast(ash.page)).toContainText("Declined");
  expect((await tradeState(ash.page, declined)).actions).toEqual([]);
  await expect(ashMain.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect(ashMain.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expect(more(ash.page)).toHaveCount(0);
  await expectOwnCopies(page, "Iono", "1");
  await expectFriendCopies(ash.page, mistyHandle, "Iono", "1");
  await page.goto(`${ORIGIN}/trades/${declined}`);
  await expect(heading(page)).toHaveText("Ash K declined");
  await expect(more(page)).toHaveCount(0);

  // C: Ash has the other gift open while Misty withdraws it. Withdraw asks first, and Keep it leaves it waiting.
  await ash.page.goto(`${ORIGIN}/trades/${withdrawn}`);
  await expect(heading(ash.page)).toHaveText(
    "Misty W wants to give you 1 card"
  );
  await page.goto(`${ORIGIN}/trades/${withdrawn}`);
  const mistyMain = page.getByRole("main");
  await more(page).click();
  await page.getByRole("menuitem", { name: "Withdraw" }).click();
  const withdrawing = mistyMain.getByRole("group", { name: "Withdraw" });
  await expect(withdrawing).toContainText(
    "Withdraw your Trade Proposal to Ash K?"
  );
  await expect(
    withdrawing.getByRole("button", { name: "Withdraw" })
  ).toBeFocused();
  await expectPageChecks(page, `the Withdraw question at ${width}`);
  await withdrawing.getByRole("button", { name: "Keep it" }).click();
  await expect(withdrawing).toHaveCount(0);
  await expect(more(page)).toBeFocused();
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
  expect(await tradeState(page, withdrawn)).toMatchObject({
    state: "proposed",
    revision: 1,
  });
  await more(page).click();
  await page.getByRole("menuitem", { name: "Withdraw" }).click();
  await withdrawing.getByRole("button", { name: "Withdraw" }).click();
  await expect(heading(page)).toHaveText("You withdrew this Trade Proposal");
  await expect(toast(page)).toContainText("Withdrawn");
  // Ash's screen still shows the proposal he opened: his accept finds it changed, and the screen reads it again.
  await ashMain.getByRole("button", { name: "Accept" }).click();
  await expect(ashMain.getByRole("alert")).toHaveText(
    "This Trade has changed. Check it and try again."
  );
  await expect(heading(ash.page)).toHaveText(
    "Misty W withdrew this Trade Proposal"
  );
  await expect(heading(ash.page)).toBeFocused();
  await expect(ashMain.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expectOwnCopies(page, "Iono", "2");

  // D: one side cancels the accepted Trade. Cancel Trade asks first, and Keep it leaves the Trade as it was.
  const [mine, other, otherName, mineName] =
    canceller === "proposer"
      ? [page, ash.page, "Ash K", "Misty W"]
      : [ash.page, page, "Misty W", "Ash K"];
  await mine.goto(`${ORIGIN}/trades/${swap}`);
  await expect(heading(mine)).toHaveText(`Ready to swap with ${otherName}`);
  const mineMain = mine.getByRole("main");
  // The other side keeps the accepted Trade open, so its Cancel Trade goes stale once this side cancels.
  await other.goto(`${ORIGIN}/trades/${swap}`);
  await expect(heading(other)).toHaveText(`Ready to swap with ${mineName}`);
  await more(mine).click();
  await mine.getByRole("menuitem", { name: "Cancel Trade" }).click();
  const cancelling = mineMain.getByRole("group", { name: "Cancel Trade" });
  await expect(cancelling).toContainText(
    `Cancel this Trade with ${otherName}? None of these cards stay promised.`
  );
  await expect(
    cancelling.getByRole("button", { name: "Cancel Trade" })
  ).toBeFocused();
  await expectPageChecks(mine, `the Cancel Trade question at ${width}`);
  await cancelling.getByRole("button", { name: "Keep it" }).click();
  await expect(cancelling).toHaveCount(0);
  await expect(more(mine)).toBeFocused();
  await expect(heading(mine)).toHaveText(`Ready to swap with ${otherName}`);
  expect(await tradeState(mine, swap)).toMatchObject({
    state: "accepted",
    revision: 2,
  });
  await more(mine).click();
  await mine.getByRole("menuitem", { name: "Cancel Trade" }).click();
  await cancelling.getByRole("button", { name: "Cancel Trade" }).click();
  await expect(heading(mine)).toHaveText("You cancelled this Trade");
  await expect(toast(mine)).toContainText("Trade cancelled");
  await expect(more(mine)).toHaveCount(0);
  // The other side cancels from the screen it already had open: the Trade has changed, and the screen reads it again.
  const otherMain = other.getByRole("main");
  await more(other).click();
  await other.getByRole("menuitem", { name: "Cancel Trade" }).click();
  await otherMain
    .getByRole("group", { name: "Cancel Trade" })
    .getByRole("button", { name: "Cancel Trade" })
    .click();
  await expect(otherMain.getByRole("alert")).toHaveText(
    "This Trade has changed. Check it and try again."
  );
  await expect(heading(other)).toHaveText(`${mineName} cancelled this Trade`);
  await expect(heading(other)).toBeFocused();
  await expect(more(other)).toHaveCount(0);
  expect((await tradeState(other, swap)).state).toBe("closed");

  // Both Trade Lists are whole again, on both sides.
  await expectOwnCopies(page, "Iono", "3");
  await expectOwnCopies(ash.page, "Arven", "2");
  await expectFriendCopies(page, ashHandle, "Arven", "2");
  await expectFriendCopies(ash.page, mistyHandle, "Iono", "3");

  // Nothing about these Trades that reached either side names the other side's Location, by name or by id.
  expect(answers.length).toBeGreaterThan(0);
  for (const { body, secretOf } of answers) {
    const text = await body;
    for (const item of secretOf) expect(text).not.toContain(item);
  }
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("a Friend accepts a Trade Proposal whole, declines another, finds a withdrawn one changed, and the proposer cancels the Trade, each step that ends one asking first, with both Trade Lists following", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, many page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "desktop width", "proposer");
  });
});

test.describe("phone", () => {
  const size = {
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  };
  test.use(size);

  test("the same at 375 px, with the recipient cancelling, no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed, many page loads and page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "375 px", "recipient");
  });
});
