// Ticket #300 (Trading Stage 2, "Near you and card search"): Find trades gets a card search, a Near you section for
// nearby collectors who are not Friends, and an off prompt while open discovery is off. Ash (the test's page, zip 00010,
// discovery off with the zip stored) holds an Arven for trade and wants an Iono PAL 185. Gary is his Friend and holds
// that Iono. Misty (00011, 5-10 mi) holds the Iono and wants an Arven: a two-way match. Brock (00014, 25-50 mi) holds an
// Iono PAF 80 and wants an Arven: he wants what Ash has. The specs cover Turn on, the rows with their bands, the radius
// choice and its saved value, the empty radius, a row's links, Turn on without a stored zip (it points to Settings), the
// card search by name and by printing (Friends first, then nearby holders in band order), the search while off, and the
// two For trade sentences. Tests 1 and 3 also run at 375 px. No screen shows a Handle, a zip code or a data source.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type {
  BrowserContextOptions,
  Locator,
  Page,
  Route,
} from "@playwright/test";
import type { Pool } from "pg";
import { expect, test } from "./support/collectors";
import { discoverable, seedZips, traderIdOf } from "./support/conversations";
import {
  accountId,
  api,
  befriend,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import { DESKTOP_SIZE, PHONE_SIZE, forTradeLeaf } from "./support/trades";

const NO_SOURCES = /refresh|poll|updated \d|TCGdex|TCGplayer/i;
const OFF_SENTENCE =
  "Turn on open discovery to find collectors near you who want your cards or have cards you want.";
const EMPTY_SENTENCE = "Nobody near you has cards you want or wants yours yet.";
const BEYOND =
  "Friends, and collectors near you or in your conversations, can trade for the cards in these Locations and everything inside them. Change this in each Location's settings in Collection.";
const STAGE_ONE =
  "Friends can trade for the cards in these Locations and everything inside them, apart from Decks. Change this in each Location's settings in Collection.";
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

type Collectors = {
  signIn: (options?: {
    next?: string;
    contextOptions?: BrowserContextOptions;
  }) => Promise<{ page: Page }>;
  pool: Pool;
};

type World = {
  ids: Record<string, string>;
  ash: Page;
  ashLeaf: string;
  gary: Page;
  garyTrader: string;
  mistyTrader: string;
  brockTrader: string;
  handles: string[];
};

/** Misty (00011) and Brock (00014) in open discovery, Gary a Friend, and Ash (the test's page) with zip 00010 stored and
 * discovery off. Zip 00014 sits 0.4 degrees (about 27.6 mi) north of 00010, so it is seeded here. */
async function world(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions
): Promise<World> {
  const ids = seedCatalog();
  const misty = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(misty, "Misty W");
  await hold(
    misty,
    await forTradeLeaf(misty, "Misty Binder"),
    ids["PAL 185"],
    1
  );
  await api(misty, "PUT", `/api/trade-wants/${ids["SVI 166"]}`, {
    quantity: "1",
  });
  const brock = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(brock, "Brock T");
  await hold(
    brock,
    await forTradeLeaf(brock, "Brock Binder"),
    ids["PAF 80"],
    1
  );
  await api(brock, "PUT", `/api/trade-wants/${ids["SVI 166"]}`, {
    quantity: "1",
  });
  const gary = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(gary, "Gary O");
  await hold(gary, await forTradeLeaf(gary, "Gary Binder"), ids["PAL 185"], 1);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  const ashLeaf = await forTradeLeaf(page, "Ash Shelf");
  await hold(page, ashLeaf, ids["SVI 166"], 1);
  await api(page, "PUT", `/api/trade-wants/${ids["PAL 185"]}`, {
    quantity: "1",
  });
  await befriend(page, gary);
  await seedZips();
  await collectors.pool.query(
    `INSERT INTO zip_centroid (zip, lat, lon, source) VALUES ('00014', 40.4, -100.0, 'census')
     ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source`
  );
  await discoverable(misty, "00011");
  await discoverable(brock, "00014");
  await discoverable(gary, "00010");
  await discoverable(page, "00010");
  await api(page, "PUT", "/api/social/discovery", { enabled: false });
  for (const on of [page, misty, brock, gary]) await noArtwork(on);
  const handles: string[] = [];
  for (const who of [misty, brock])
    handles.push(
      (
        await collectors.pool.query<{ handle: string }>(
          "SELECT handle FROM collector_profile WHERE user_id = $1",
          [await accountId(who)]
        )
      ).rows[0].handle
    );
  return {
    ids,
    ash: page,
    ashLeaf,
    gary,
    garyTrader: await traderIdOf(gary),
    mistyTrader: await traderIdOf(misty),
    brockTrader: await traderIdOf(brock),
    handles,
  };
}

/** Nothing on Ash's screen names Misty's or Brock's Handle, a zip code or a data source. */
async function expectNoLeaks(page: Page, w: World) {
  const text = (await page.locator("body").innerText()) ?? "";
  for (const handle of w.handles) expect(text).not.toContain(handle);
  expect(text).not.toMatch(/\b0001[0-4]\b/);
  expect(text).not.toMatch(NO_SOURCES);
}

const region = (page: Page, name: string) =>
  page.getByRole("main").getByRole("region", { name, exact: true });
const radio = (page: Page, name: string) =>
  region(page, "Near you").getByRole("radio", { name, exact: true });
const nearRows = (page: Page) =>
  region(page, "Near you")
    .getByRole("list", { name: "Matches near you" })
    .locator("> li");

/** Types a card name, picks the Iono PAL 185 option and waits for the results. */
async function searchIono(page: Page) {
  const search = region(page, "Search for a card");
  await search.getByRole("searchbox", { name: "Card name" }).fill("Iono");
  await search
    .getByRole("list", { name: "Cards" })
    .getByRole("button", { name: "Iono, Paldea Evolved 185" })
    .click();
  return search;
}

async function nearYouStory(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  const w = await world(page, collectors, contextOptions);
  const phone = isPhone(page);
  await page.goto(`${ORIGIN}/trades/find`);

  // 1. Friends first: Gary's row. Near you shows the off prompt and Turn on, and no cash badge.
  const friends = region(page, "Friends");
  await expect(
    friends.getByRole("heading", { name: "Friends", level: 2 })
  ).toBeVisible();
  await expect(friends.getByRole("list", { name: "Matches" })).toContainText(
    "Gary O"
  );
  const near = region(page, "Near you");
  await expect(near).toContainText(OFF_SENTENCE);
  await expect(near).not.toContainText("Open to cash offers");
  const turnOn = near.getByRole("button", { name: "Turn on", exact: true });
  await expectPageChecks(
    page,
    `Find trades with the Near you prompt, ${width}`
  );
  if (phone) await expectTouchTarget(turnOn);

  // 2. Turn on: 25 mi is chosen and Misty is the one two-way row, with her band and no Handle.
  await turnOn.click();
  await expect(radio(page, "25 mi")).toBeChecked();
  await expect(nearRows(page)).toHaveCount(1);
  const misty = nearRows(page).first();
  await expect(misty).toContainText("Misty W");
  await expect(misty).toContainText("Two-way match");
  await expect(misty).toContainText("5–10 mi · New to trading");
  await expect(misty).not.toContainText("@");
  await expect(near).toContainText(
    "Collectors near you who have cards you want, or want cards you have."
  );
  await expectNoLeaks(page, w);

  // 3. 50 mi adds Brock after Misty (two-way first), in the 25-50 mi band and with no tag; it is saved.
  if (phone)
    for (const label of ["5 mi", "10 mi", "25 mi", "50 mi"])
      await expectTouchTarget(radio(page, label));
  await radio(page, "50 mi").click();
  await expect(radio(page, "50 mi")).toBeChecked();
  await expect(nearRows(page)).toHaveCount(2);
  await expect(nearRows(page).nth(0)).toContainText("Misty W");
  const brock = nearRows(page).nth(1);
  await expect(brock).toContainText("Brock T");
  await expect(brock).toContainText("25–50 mi");
  await expect(brock).not.toContainText("Two-way match");
  await expect(brock).not.toContainText("You could");
  await expect(brock).not.toContainText("@");
  await expect(near).not.toContainText("Gary O");
  await page.reload();
  await expect(radio(page, "50 mi")).toBeChecked();
  await expect(nearRows(page)).toHaveCount(2);

  // 4. 5 mi leaves nobody; 25 mi brings Misty back.
  await radio(page, "5 mi").click();
  await expect(radio(page, "5 mi")).toBeChecked();
  await expect(near).toContainText(EMPTY_SENTENCE);
  await radio(page, "25 mi").click();
  await expect(nearRows(page)).toHaveCount(1);

  // 5. Misty's open row: Message, her Trade List by trader id, Propose trade and its ⋯ menu.
  const row = nearRows(page).first();
  await row.getByRole("button", { name: /Misty W/ }).click();
  const message = row.getByRole("link", { name: "Message Misty W" });
  await expect(message).toHaveAttribute(
    "href",
    `/trades/with/${w.mistyTrader}`
  );
  await expect(
    row.getByRole("link", { name: "See all of Misty W's Trade List" })
  ).toHaveAttribute("href", `/trades/trader/${w.mistyTrader}`);
  const more = row.getByRole("button", { name: "More for Misty W" });
  await expect(more).toHaveCount(1);
  const propose = row.getByRole("button", { name: "Propose trade to Misty W" });
  await expectPageChecks(page, `Find trades with Near you rows, ${width}`);
  await expectNoLeaks(page, w);
  if (phone) {
    await expectTouchTarget(propose);
    await expectTouchTarget(message);
    await expectTouchTarget(more);
  }
  await propose.click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${w.mistyTrader}`);
}

/** Ash blocks Misty from her Near you row: Cancel keeps the row and returns focus to the ⋯; Block removes the row, says so
 * in Near you, and Settings > Privacy lists her. */
async function blockFromRowStory(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  const w = await world(page, collectors, contextOptions);
  const phone = isPhone(page);
  await api(page, "PUT", "/api/social/discovery", { enabled: true });
  await page.goto(`${ORIGIN}/trades/find`);
  const near = region(page, "Near you");
  await expect(nearRows(page)).toHaveCount(1);
  const row = nearRows(page).first();
  await row.getByRole("button", { name: /Misty W/ }).click();
  const more = row.getByRole("button", { name: "More for Misty W" });
  const ask = async () => {
    await more.click();
    await page.getByRole("menuitem", { name: "Block" }).click();
  };
  const question = row.getByText("Block Misty W? They won't be told.", {
    exact: true,
  });
  const confirm = row.getByRole("button", { name: "Block", exact: true });

  // 1. Choosing Block asks first; Cancel changes nothing and focus returns to the ⋯.
  await ask();
  await expect(question).toBeVisible();
  await expect(confirm).toBeFocused();
  if (phone) await expectTouchTarget(confirm);
  await expectPageChecks(page, `Near you with the Block question, ${width}`);
  await row.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(question).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(nearRows(page)).toHaveCount(1);

  // 2. A failed Block says so on the row, keeps the row and returns focus to the ⋯.
  const refuse = (route: Route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Server error" }),
    });
  await page.route("**/api/social/traders/*/block", refuse);
  await ask();
  await confirm.click();
  await expect(row.getByRole("alert")).toBeVisible();
  await expect(more).toBeFocused();
  await expect(nearRows(page)).toHaveCount(1);
  await page.unroute("**/api/social/traders/*/block", refuse);

  // 3. Confirming blocks: the row leaves, Near you says so once and focus moves to its heading. The reload is held so
  // the row is still on screen while the status is counted.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const hold = async (route: Route) => {
    await held;
    await route.continue();
  };
  await page.route("**/api/social/trade-matches/near", hold);
  await ask();
  await confirm.click();
  const announced = page
    .getByRole("status")
    .filter({ hasText: "Blocked Misty W." });
  await expect(announced).toHaveCount(1);
  await expect(nearRows(page)).toHaveCount(1);
  release();
  await expect(nearRows(page)).toHaveCount(0);
  await page.unroute("**/api/social/trade-matches/near", hold);
  await expect(announced).toHaveCount(1);
  await expect(
    near.getByRole("status").filter({ hasText: "Blocked Misty W." })
  ).toHaveText("Blocked Misty W. They aren't told.");
  await expect(
    near.getByRole("heading", { name: "Near you", level: 2 })
  ).toBeFocused();
  await expectNoLeaks(page, w);

  // 4. Settings > Privacy lists her by name alone.
  await page.goto(`${ORIGIN}/settings`);
  const blocked = page.getByRole("region", { name: "Blocked collectors" });
  const listed = blocked.getByRole("listitem").filter({ hasText: "Misty W" });
  await expect(listed).toHaveCount(1);
  await expect(listed).not.toContainText("@");
  await page.goto(`${ORIGIN}/trades/find`);
  await expect(near).toContainText(EMPTY_SENTENCE);
}

async function cardSearchStory(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  const w = await world(page, collectors, contextOptions);
  const phone = isPhone(page);
  await api(page, "PUT", "/api/social/discovery", { enabled: true });
  await api(page, "PUT", "/api/social/discovery", { radius_mi: 50 });
  await page.goto(`${ORIGIN}/trades/find`);

  const search = region(page, "Search for a card");
  await expect(search).toContainText(
    "Find Friends and collectors near you who have a card for trade."
  );
  await search.getByRole("searchbox", { name: "Card name" }).fill("Iono");
  const option = search
    .getByRole("list", { name: "Cards" })
    .getByRole("button", { name: "Iono, Paldea Evolved 185" });
  await expect(option).toBeVisible();
  await expectPageChecks(page, `the card options, ${width}`);
  if (phone) await expectTouchTarget(option);
  await option.click();
  await expect(
    search.getByRole("button", { name: "Change card" })
  ).toBeFocused();

  // Every printing: Gary under Friends, then Misty and Brock in band order.
  await expect(
    search.getByRole("radio", { name: "Every printing", exact: true })
  ).toBeChecked();
  const friends = search.getByRole("list", { name: "Friends with this card" });
  const nearHolders = search.getByRole("list", {
    name: "Collectors near you with this card",
  });
  await expect(friends.locator("> li")).toHaveCount(1);
  await expect(friends).toContainText("Gary O");
  await expect(nearHolders.locator("> li")).toHaveCount(2);
  const mistyHolder = nearHolders.locator("> li").nth(0);
  await expect(mistyHolder).toContainText("Misty W");
  await expect(mistyHolder).toContainText("5–10 mi · New to trading");
  await expect(mistyHolder).toContainText("PAL 185");
  const brockHolder = nearHolders.locator("> li").nth(1);
  await expect(brockHolder).toContainText("Brock T");
  await expect(brockHolder).toContainText("25–50 mi");
  await expect(brockHolder).toContainText("PAF 080");
  await expect(search).not.toContainText("@");
  await expectPageChecks(page, `card search results, ${width}`);
  await expectNoLeaks(page, w);

  // This printing: Brock's PAF 80 leaves; Misty and Gary stay.
  await search
    .getByRole("radio", { name: "This printing", exact: true })
    .click();
  await expect(nearHolders.locator("> li")).toHaveCount(1);
  await expect(nearHolders).toContainText("Misty W");
  await expect(nearHolders).not.toContainText("Brock T");
  await expect(friends).toContainText("Gary O");

  // Each holder offers Propose trade and Message.
  for (const [holder, name] of [
    [friends.locator("> li").first(), "Gary O"],
    [nearHolders.locator("> li").first(), "Misty W"],
  ] as [Locator, string][]) {
    const propose = holder.getByRole("button", {
      name: `Propose trade to ${name}`,
    });
    const message = holder.getByRole("link", { name: `Message ${name}` });
    await expect(propose).toBeVisible();
    await expect(message).toBeVisible();
    if (phone) {
      await expectTouchTarget(propose);
      await expectTouchTarget(message);
    }
  }

  // Change card returns focus to the search box; Propose trade opens the builder for Misty.
  await search.getByRole("button", { name: "Change card" }).click();
  await expect(
    search.getByRole("searchbox", { name: "Card name" })
  ).toBeFocused();
  await searchIono(page);
  await nearHolders
    .getByRole("button", { name: "Propose trade to Misty W" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${w.mistyTrader}`);
}

test.describe("desktop, Near you and card search", () => {
  test.use(DESKTOP_SIZE);

  test("Near you turns on, lists nearby collectors with bands and narrows by radius", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await nearYouStory(page, collectors, DESKTOP_SIZE, "desktop width");
  });

  test("Turn on without a stored zip points to Settings", async ({
    collectors,
  }) => {
    const fresh = (
      await collectors.signIn({
        next: "/trades/find",
        contextOptions: DESKTOP_SIZE,
      })
    ).page;
    await noArtwork(fresh);
    const near = region(fresh, "Near you");
    await expect(near).toContainText(OFF_SENTENCE);
    await near.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(near).toContainText(
      "Enter your zip code to turn on open discovery."
    );
    await expect(
      near.getByRole("link", { name: "Open Settings" })
    ).toHaveAttribute("href", "/settings");
    await expectPageChecks(fresh, "Find trades asking for a zip code");
    await near.getByRole("link", { name: "Open Settings" }).click();
    await expect(fresh).toHaveURL(`${ORIGIN}/settings`);
  });

  test("card search finds Friends first, then nearby holders, by scope", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await cardSearchStory(page, collectors, DESKTOP_SIZE, "desktop width");
  });

  test("card search while off answers Friends and says how to search nearby", async ({
    page,
    collectors,
  }) => {
    const w = await world(page, collectors, DESKTOP_SIZE);
    await page.goto(`${ORIGIN}/trades/find`);
    const search = await searchIono(page);
    await expect(
      search.getByRole("list", { name: "Friends with this card" })
    ).toContainText("Gary O");
    await expect(search).toContainText(
      "Turn on open discovery to search collectors near you."
    );
    await expect(
      search.getByRole("list", { name: "Collectors near you with this card" })
    ).toHaveCount(0);
    await expect(search.getByRole("button", { name: "Turn on" })).toHaveCount(
      0
    );
    await expectPageChecks(page, "card search while discovery is off");
    await expectNoLeaks(page, w);
  });

  test("the For trade wording names collectors near you while discovery is on", async ({
    page,
    collectors,
  }) => {
    test.slow();
    const w = await world(page, collectors, DESKTOP_SIZE);
    const forTrade = () => region(page, "For trade");
    const gear = () =>
      page
        .getByRole("complementary", { name: "Sidebar" })
        .getByRole("navigation", { name: "Locations" })
        .getByRole("button", { name: "Settings for Ash Shelf", exact: true });
    const dialog = () =>
      page.getByRole("dialog", { name: "Ash Shelf", exact: true });
    const hiddenStill =
      "Ash Shelf is hidden from Friends, but its cards are still on your Trade List for Friends and for collectors near you or in your conversations.";

    await api(page, "PUT", "/api/social/discovery", { enabled: true });
    await page.goto(`${ORIGIN}/settings`);
    await expect(forTrade()).toContainText(BEYOND);
    await expectPageChecks(page, "Settings For trade, beyond Friends");

    const tree = await api(page, "GET", "/api/location-tree");
    const leaf = (tree.locations as { id: string; version: number }[]).find(
      (location) => location.id === w.ashLeaf
    )!;
    await api(page, "PUT", `/api/location-tree/${leaf.id}/hidden`, {
      hidden: true,
      version: leaf.version,
      idempotency_key: randomUUID(),
    });
    await page.goto(`${ORIGIN}/collection`);
    await gear().click();
    await expect(dialog()).toContainText(hiddenStill);
    await expectPageChecks(page, "a hidden For trade Location, beyond Friends");
    await page.keyboard.press("Escape");

    await api(page, "PUT", "/api/social/discovery", { enabled: false });
    await page.goto(`${ORIGIN}/settings`);
    await expect(forTrade()).toContainText(STAGE_ONE);
    await expect(forTrade()).not.toContainText("collectors near you");
    await page.goto(`${ORIGIN}/collection`);
    await gear().click();
    await expect(dialog()).toContainText("Still on your Trade List");
    await expect(dialog()).not.toContainText("collectors near you");
    await expectPageChecks(page, "a hidden For trade Location, Friends only");
  });
});

test.describe("desktop, Block from a Near you row", () => {
  test.use(DESKTOP_SIZE);

  test("Block from a Near you row removes it, and Settings lists it", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await blockFromRowStory(page, collectors, DESKTOP_SIZE, "desktop width");
  });
});

test.describe("phone, Near you and card search", () => {
  test.use(PHONE_SIZE);

  test("Near you at 375 px, with touch-sized controls", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await nearYouStory(page, collectors, PHONE_SIZE, "375 px");
  });

  test("Block from a Near you row at 375 px", async ({ page, collectors }) => {
    test.slow();
    await blockFromRowStory(page, collectors, PHONE_SIZE, "375 px");
  });

  test("card search at 375 px, with touch-sized controls", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await cardSearchStory(page, collectors, PHONE_SIZE, "375 px");
  });
});
