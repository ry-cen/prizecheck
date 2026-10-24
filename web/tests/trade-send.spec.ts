// Ticket #270, on the proposal builder of #284: send a Friend a Trade Proposal and withdraw it (Trading spec "Trade
// Proposals and the state model"). Misty opens the proposal builder from Ash's Trade List page and adds his Arven from
// his Trade List, raises it with the stepper, and adds her own Iono from My Trade List. She sends the swap after a
// refusal that names the card and the count and a send whose outcome was unknown, then sends Ash a gift from an empty
// builder. Her Iono leaves both Trade Lists at once and a removal is refused because a Trade promised it. Ash sees both
// proposals from his side, never one of her Locations. Misty withdraws both, answering the question each withdraw asks
// first (#271), and the cards come back. Brock's builder opens empty, and his Iono, held in two For trade binders, has
// one tile. At desktop width and at 375 px. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py). The
// other collectors sign in first, so the test's own page signs in afterwards as a new account.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  openConversation,
  timeline,
  timelineTrades,
} from "./support/conversations";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { bodyOf } from "./support/trades";

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

const tradesTab = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Trades/ });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;

/** On a phone, selects the builder's pane (the other one is hidden, so out of the accessibility tree). */
async function show(page: Page, pane: "Proposal" | "Cards") {
  if (!isPhone(page)) return;
  await page
    .getByRole("tablist", { name: "Proposal builder" })
    .getByRole("tab", {
      name: pane === "Cards" ? "Cards" : /^Proposal/,
      exact: pane === "Cards",
    })
    .click();
}

/** The library tile that adds `card` (a regex fragment such as "Arven, SVI 166, .+?, Normal") to You get or You give. */
const tile = (scope: Locator, side: "get" | "give", card: string) =>
  scope.getByRole("button", {
    name: new RegExp(`^Add to You ${side}, ${card}, `),
  });
const group = (page: Page, name: string | RegExp) =>
  page.getByRole("group", { name });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

/** The whole story, with every collector at `contextOptions`' size (the test's own page is set by its describe). */
async function story(
  page: Page,
  collectors: {
    signIn: (options?: {
      next?: string;
      contextOptions?: BrowserContextOptions;
    }) => Promise<{ page: Page }>;
  },
  contextOptions: BrowserContextOptions,
  width: string
) {
  const ids = seedCatalog();
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  const ash = await collectors.signIn({ contextOptions });
  const ashHandle = await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, `${secret} Shelf`);
  await hold(ash.page, shelf, ids["SVI 166"], 2);
  // A second finish of the same card: its Add must not share a name with the Normal one's.
  await hold(ash.page, shelf, ids["SVI 166 Reverse Holo"], 1);
  const brock = await collectors.signIn({ contextOptions });
  const brockHandle = await nameCollector(brock.page, "Brock T");
  // Brock holds one card in two For trade binders, to check My Trade List shows one tile for it.
  for (const name of [`${secret} Left`, `${secret} Right`])
    await hold(
      brock.page,
      await forTradeBinder(brock.page, name),
      ids["PAL 254"],
      1
    );

  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  const mistyHandle = await nameCollector(page, "Misty W");
  const binder = await forTradeBinder(page, `${secret} Binder`);
  await hold(page, binder, ids["PAL 185"], 3);
  await befriend(page, ash.page);
  await befriend(page, brock.page);
  // Everything about Trades that reaches Ash's browser, to check it never names one of Misty's Locations.
  const answers: Promise<string | null>[] = [];
  ash.page.on("response", (response) => {
    if (/\/api\/(social\/)?trade/.test(response.url()))
      answers.push(bodyOf(response));
  });

  // A: Misty opens the builder from Ash's Trade List (no Add there), adds his Arven from his list and her Iono from hers.
  await page.goto(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  const friendMain = page.getByRole("main");
  await expect(friendMain).toContainText("Arven");
  await expect(friendMain.getByRole("button", { name: /^Add / })).toHaveCount(
    0
  );
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${ashHandle}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  const proposal = page.getByRole("main");
  const theirList = page.getByRole("list", { name: "Ash K's Trade List" });
  const myList = page.getByRole("list", { name: "Your Trade List" });
  await show(page, "Cards");
  // The two finishes of Arven are two tiles with different names.
  await expect(
    tile(theirList, "get", "Arven, SVI 166, .+?, Reverse Holo")
  ).toHaveCount(1);
  await expect(
    tile(theirList, "get", "Arven, SVI 166, .+?, Normal")
  ).toHaveCount(1);
  await tile(theirList, "get", "Arven, SVI 166, .+?, Normal").click();
  await show(page, "Proposal");
  await page
    .getByRole("button", { name: "Increase Arven (SVI 166) you get" })
    .click();
  await expect(group(page, "Arven (SVI 166) you get")).toContainText("2");
  await show(page, "Cards");
  await page.getByRole("radio", { name: "My Trade List" }).click();
  await tile(myList, "give", "Iono, PAL 185, .+?, Normal").click();
  await show(page, "Proposal");
  await expect(proposal.getByRole("list", { name: "You give" })).toContainText(
    "Iono"
  );
  await expect(proposal.getByRole("list", { name: "You give" })).toContainText(
    "Up to 3"
  );
  await expect(proposal.getByRole("list", { name: "You get" })).toContainText(
    "Arven"
  );
  await expectPageChecks(page, `the proposal builder at ${width}`);
  if (isPhone(page)) {
    await show(page, "Cards");
    await expectPageChecks(page, `the proposal builder's cards at ${width}`);
    await show(page, "Proposal");
  }

  // Ash gives one of his Arven to Misty meanwhile, so only one is left on his Trade List: the send is
  // refused with the card and the count, and the cards stay.
  await api(ash.page, "POST", "/api/trades", {
    recipient_id: await accountId(page),
    you_give: [{ edition_id: ids["SVI 166"], quantity: "1" }],
    you_get: [],
    idempotency_key: randomUUID(),
  });
  await proposal.getByRole("button", { name: "Send Trade Proposal" }).click();
  await expect(proposal.getByRole("alert")).toHaveText(
    "Ash K can trade only 1 Arven (SVI 166) now. Lower it to 1, then send again."
  );
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  await proposal
    .getByRole("button", { name: "Decrease Arven (SVI 166) you get" })
    .click();
  // A send whose answer never comes keeps the cards too, and is sent again safely.
  await page.route(`${ORIGIN}/api/trades`, (route) => route.abort(), {
    times: 1,
  });
  await proposal.getByRole("button", { name: "Send Trade Proposal" }).click();
  await expect(proposal.getByRole("alert")).toHaveText(
    "The Trade Proposal may not have been sent. Check your connection and try again."
  );
  await proposal.getByRole("button", { name: "Send Trade Proposal" }).click();
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`));
  const swap = page.url();
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
  await expect(toast(page)).toContainText("Trade Proposal sent to Ash K");
  await expect(page.getByRole("list", { name: "You give" })).toContainText(
    "×1"
  );
  await expectPageChecks(page, `the Trade screen at ${width}`);

  // B: a gift, from an empty builder: Send waits for a card.
  await page.goto(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${ashHandle}`);
  await show(page, "Proposal");
  await expect(
    page.getByRole("button", { name: "Send Trade Proposal" })
  ).toBeDisabled();
  await expect(page.getByRole("main")).toContainText(
    "Add at least one card to either side."
  );
  await show(page, "Cards");
  await page.getByRole("radio", { name: "My Trade List" }).click();
  // One of her three Iono is promised to the swap: two are left on her list.
  const iono = tile(
    page.getByRole("list", { name: "Your Trade List" }),
    "give",
    "Iono, PAL 185, .+?, Normal"
  );
  await expect(iono).toHaveAccessibleName(/2 available/);
  await iono.click();
  await iono.click();
  await show(page, "Proposal");
  await expect(group(page, "Iono (PAL 185) you give")).toContainText("2");
  await page.getByRole("button", { name: "Send Trade Proposal" }).click();
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
  const gift = page.url();

  // Her Iono left both Trade Lists at once.
  await page.goto(`${ORIGIN}/trades/list`);
  await expect(page.getByRole("main")).toContainText(
    "Your Trade List is empty."
  );
  await noArtwork(ash.page);
  await ash.page.goto(`${ORIGIN}/friends/${mistyHandle}/trade-list`);
  await expect(ash.page.getByRole("status")).toHaveText(
    "Misty W has nothing on their Trade List."
  );

  // A removal of one copy is refused: Trades promised all three. Collection's selection strip is checked at desktop
  // width, as the Loans spec does.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${ORIGIN}/collection`);
  await page
    .getByRole("region", { name: "Cards" })
    .getByRole("button", {
      name: `Iono, Paldea Evolved 185, Normal, copy 1, ${secret} Binder`,
    })
    .click();
  await page
    .getByRole("region", { name: "Selection" })
    .getByRole("button", { name: "Actions" })
    .click();
  await page
    .getByRole("region", { name: "Selection" })
    .getByRole("button", { name: "Inventory Removal…" })
    .click();
  const removal = page.getByRole("dialog", {
    name: "Remove 1 copy from your Collection",
  });
  await removal.getByRole("button", { name: "Remove 1 copy" }).click();
  await expect(removal).toContainText(
    "to a Trade, so they can't all be removed. Nothing was removed."
  );
  await page.keyboard.press("Escape");
  await expect(removal).toHaveCount(0);
  await page.setViewportSize(size);

  // An address that names no Trade is a missing Trade, not a failed load.
  await page.goto(`${ORIGIN}/trades/not-a-trade`);
  await expect(heading(page)).toHaveText("Trade not found");
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // An empty builder asks nothing when left, and a card held in two For trade Locations has one tile.
  await noArtwork(brock.page);
  await befriend(brock.page, ash.page);
  await brock.page.goto(`${ORIGIN}/friends/${mistyHandle}/trade-list`);
  await brock.page
    .getByRole("button", { name: "Propose trade to Misty W" })
    .click();
  await expect(brock.page).toHaveURL(`${ORIGIN}/trades/new/${mistyHandle}`);
  await brock.page.goto(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  await brock.page
    .getByRole("button", { name: "Propose trade to Ash K" })
    .click();
  await expect(brock.page).toHaveURL(`${ORIGIN}/trades/new/${ashHandle}`);
  await expect(heading(brock.page)).toHaveText("Trade Proposal to Ash K");
  await expect(brock.page.getByRole("dialog")).toHaveCount(0);
  await show(brock.page, "Cards");
  await brock.page.getByRole("radio", { name: "My Trade List" }).click();
  const brockIono = tile(
    brock.page.getByRole("list", { name: "Your Trade List" }),
    "give",
    "Iono, PAL 254, .+?, Normal"
  );
  await expect(brockIono).toHaveCount(1);
  await expect(brockIono).toHaveAccessibleName(/2 available/);
  await brockIono.click();
  await show(brock.page, "Proposal");
  await expect(group(brock.page, /^Iono .* you give$/)).toHaveCount(1);

  // C: Ash sees both proposals from his side.
  await openConversation(ash.page, "Misty W");
  const cards = timeline(ash.page);
  // The two proposals that wait on Ash are in the Trades tab's name; no one has messaged him.
  await expect(tradesTab(ash.page)).toHaveAccessibleName("Trades, 2 need you");
  await expect(timelineTrades(ash.page)).toHaveCount(3);
  await expect(cards).toContainText("Misty W sent you a Trade Proposal");
  await expect(cards).toContainText("Misty W wants to give you 2 cards");
  await expect(cards).toContainText("You give 1 card · You get 1 card");
  await expect(cards).toContainText("Waiting for Misty W to answer");
  await expectPageChecks(ash.page, `the conversation at ${width}`);
  await timelineTrades(ash.page)
    .filter({ hasText: /Misty W sent you a Trade Proposal/ })
    .first()
    .click();
  await expect(heading(ash.page)).toHaveText(
    "Misty W sent you a Trade Proposal"
  );
  const ashMain = ash.page.getByRole("main");
  await expect(ashMain).toContainText(`Trade with Misty W @${mistyHandle}`);
  await expect(ashMain.getByRole("list", { name: "You give" })).toContainText(
    "Arven"
  );
  await expect(ashMain.getByRole("list", { name: "You get" })).toContainText(
    "Iono"
  );
  await expect(
    ashMain.getByRole("button", { name: "More for this Trade" })
  ).toHaveCount(0);
  await expect(ashMain).not.toContainText(secret);
  await expectPageChecks(ash.page, `a received Trade Proposal at ${width}`);

  // D: Misty withdraws both, and her Iono comes back to both lists.
  for (const trade of [swap, gift]) {
    await page.goto(trade);
    await page.getByRole("button", { name: "More for this Trade" }).click();
    await page.getByRole("menuitem", { name: "Withdraw" }).click();
    // Withdrawing asks first (#271); the question names the Friend.
    const asking = page.getByRole("group", { name: "Withdraw" });
    await expect(asking).toContainText(
      "Withdraw your Trade Proposal to Ash K?"
    );
    await asking.getByRole("button", { name: "Withdraw" }).click();
    await expect(heading(page)).toHaveText("You withdrew this Trade Proposal");
    await expect(toast(page)).toContainText("Withdrawn");
  }
  await page.goto(`${ORIGIN}/trades/list`);
  await expect(
    page
      .getByRole("main")
      .getByRole("list", { name: `${secret} Binder` })
      .getByRole("listitem")
  ).toContainText("×3");
  await ash.page.goto(`${ORIGIN}/friends/${mistyHandle}/trade-list`);
  await expect(
    ash.page.getByRole("main").getByRole("list", { name: "Iono", exact: true })
  ).toContainText("×3");
  await openConversation(ash.page, "Misty W");
  await expect(
    timelineTrades(ash.page).filter({
      hasText: /Misty W withdrew this Trade Proposal/,
    })
  ).toHaveCount(2);
  await ash.page.goto(swap);
  await expect(heading(ash.page)).toHaveText(
    "Misty W withdrew this Trade Proposal"
  );

  // Nothing about these Trades that reached Ash names one of Misty's Locations, by name or by id.
  const bodies = (await Promise.all(answers)).filter(
    (body): body is string => body !== null
  );
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies) {
    expect(body).not.toContain(secret);
    expect(body).not.toContain(binder);
  }
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("a Trade Proposal built from a Friend's Trade List and your own is sent, seen by the Friend, and withdrawn, with the cards leaving and coming back to both lists", async ({
    page,
    collectors,
  }) => {
    // Three collectors in three contexts, a catalog seed and several page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "desktop width");
  });
});

test.describe("phone", () => {
  const size = {
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  };
  test.use(size);

  test("the same at 375 px, with no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    // Three collectors in three contexts, a catalog seed and several page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "375 px");
  });
});
