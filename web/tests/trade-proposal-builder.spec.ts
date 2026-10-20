// Ticket #284: the proposal builder, one per Friend (Trading spec "Building a proposal"), laid out like the Deck
// builder. Misty opens it empty from Find trades and from Ash's Trade List page, and with one Arven already in You get
// from Ask to trade. The library opens on Ash's Trade List with his matches first (his Iono, which Misty wants), flips
// to Misty's own, and each list has its own search. One tap adds one copy, Details adds nothing, the steppers stop at
// the copies available, and a card can't be on both sides. Leaving with cards added asks "Discard this proposal to Ash
// K?" for a shell tab, browser Back and the back link, and Keep editing keeps everything; the browser's own warning is
// armed only while cards are held. A card Ask to trade preloaded is not an edit: leaving untouched asks nothing, and
// one more tap makes it ask. Nothing is asked when empty or after a send. At desktop width and at 375 px, where a
// Proposal / Cards switch shows one pane at a time. The catalog is the Swap catalog
// (api/tests/want_list_swap_fixtures.py). Ash signs in first, so the test's own page signs in afterwards as Misty.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type {
  BrowserContextOptions,
  Dialog,
  Locator,
  Page,
} from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

type Editions = Record<
  | "PAL 185"
  | "PAL 254"
  | "PAF 80"
  | "SVI 166"
  | "PAL 172"
  | "PAL 172 Reverse Holo",
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

const tradeWant = (page: Page, edition: string, quantity: number) =>
  api(page, "PUT", `/api/trade-wants/${edition}`, {
    quantity: String(quantity),
  });

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const tradesTab = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: "Trades", exact: true });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;

/** On a phone, selects the builder's pane (the other one is hidden, so out of the accessibility tree); on desktop both show. */
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

/** Runs the page checks on the builder: once at desktop width, on each pane on a phone. */
async function checkPanes(page: Page, state: string) {
  if (!isPhone(page)) return expectPageChecks(page, state);
  for (const pane of ["Proposal", "Cards"] as const) {
    await show(page, pane);
    await expectPageChecks(page, `${state}, ${pane} pane`);
  }
}

/** The library tile that adds `card` (a regex fragment such as "Arven, SVI 166, .+?, Normal") to You get or You give. */
const tile = (scope: Locator, side: "get" | "give", card: string) =>
  scope.getByRole("button", {
    name: new RegExp(`^Add to You ${side}, ${card}, `),
  });
const library = (page: Page) =>
  page.getByRole("complementary", { name: "Cards" });
const group = (page: Page, name: string | RegExp) =>
  page.getByRole("group", { name });
const lists = (page: Page) => ({
  get: page.getByRole("list", { name: "You get", exact: true }),
  give: page.getByRole("list", { name: "You give", exact: true }),
});

const ARVEN = "Arven, SVI 166, .+?, Normal";
const IONO_185 = "Iono, PAL 185, .+?, Normal";
const IONO_254 = "Iono, PAL 254, .+?, Normal";
const BOSS = "Boss's Orders, PAL 172, .+?, Normal";

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
  const ash = await collectors.signIn({ contextOptions });
  const ashHandle = await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, "Ash Shelf");
  await hold(ash.page, shelf, ids["SVI 166"], 2);
  await hold(ash.page, shelf, ids["PAL 185"], 1);
  await hold(ash.page, shelf, ids["PAL 172"], 1);
  await tradeWant(ash.page, ids["PAL 254"], 1);

  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const binder = await forTradeBinder(page, "Misty Binder");
  await hold(page, binder, ids["PAL 254"], 2);
  await hold(page, binder, ids["PAF 80"], 1);
  await hold(page, binder, ids["PAL 172"], 1);
  await tradeWant(page, ids["PAL 185"], 1);
  await befriend(page, ash.page);

  const builder = `${ORIGIN}/trades/new/${ashHandle}`;
  const main = page.getByRole("main");
  const findLink = main.getByRole("link", { name: "Find trades", exact: true });
  const listLink = main.getByRole("link", {
    name: "Ash K's Trade List",
    exact: true,
  });
  const theirList = page.getByRole("list", { name: "Ash K's Trade List" });
  const myList = page.getByRole("list", { name: "Your Trade List" });
  const theirs = page.getByRole("radio", { name: "Their Trade List" });
  const mine = page.getByRole("radio", { name: "My Trade List" });
  const dialog = page.getByRole("dialog", {
    name: "Discard this proposal to Ash K?",
  });
  const arvenGet = group(page, "Arven (SVI 166) you get");
  const warns = () =>
    page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });

  // 1: Propose trade on Find trades opens the builder empty, with Ash's matches first.
  await page.goto(`${ORIGIN}/trades/find`);
  await page
    .getByRole("list", { name: "Matches" })
    .getByRole("button", { name: /^Ash K/ })
    .click();
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(builder);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  await show(page, "Cards");
  await expect(theirs).toBeChecked();
  const adds = theirList.getByRole("button", { name: /^Add to You get/ });
  await expect(adds).toHaveCount(3);
  await expect(adds.nth(0)).toHaveAccessibleName(
    /^Add to You get, Iono, PAL 185, .*1 wanted/
  );
  await expect(adds.nth(0)).toContainText("You want");
  await expect(adds.nth(1)).toHaveAccessibleName(
    /^Add to You get, Arven, SVI 166,/
  );
  await show(page, "Proposal");
  await expect(lists(page).get).toHaveText("Nothing yet");
  await expect(lists(page).give).toHaveText("Nothing yet");
  await expect(
    page.getByRole("button", { name: "Send Trade Proposal" })
  ).toBeDisabled();
  await expect(main).toContainText("Add at least one card to either side.");
  await checkPanes(
    page,
    `the empty proposal builder from Find trades at ${width}`
  );

  // 2: My Trade List and the two searches.
  await show(page, "Cards");
  await mine.click();
  await expect(
    myList.getByRole("button", { name: /^Add to You give/ })
  ).toHaveCount(3);
  await expect(
    myList.getByRole("button", { name: /^Add to You give/ }).nth(0)
  ).toHaveAccessibleName(/^Add to You give, Iono, PAL 254, .*1 wanted/);
  await expect(
    myList.getByRole("button", { name: /^Add to You give/ }).nth(0)
  ).toContainText("Ash K wants");
  const mineSearch = page.getByRole("searchbox", {
    name: "Search your Trade List",
  });
  await mineSearch.fill("iono");
  await expect(
    myList.getByRole("button", { name: /^Add to You give/ })
  ).toHaveCount(2);
  await mineSearch.fill("zzz");
  await expect(library(page)).toContainText("No cards match that name.");
  await mineSearch.fill("");
  await expect(
    myList.getByRole("button", { name: /^Add to You give/ })
  ).toHaveCount(3);
  await theirs.click();
  const theirSearch = page.getByRole("searchbox", {
    name: "Search Ash K's Trade List",
  });
  await theirSearch.fill("boss");
  await expect(adds).toHaveCount(1);
  await expect(adds).toHaveAccessibleName(/Boss's Orders/);
  await theirSearch.fill("");
  await expect(adds).toHaveCount(3);

  // 3: one tap adds one copy, Details adds nothing, and the cap holds.
  await tile(theirList, "get", ARVEN).click();
  await show(page, "Proposal");
  await expect(arvenGet).toContainText("1");
  if (isPhone(page))
    await expect(page.getByRole("tab", { name: /^Proposal 1/ })).toBeVisible();
  await show(page, "Cards");
  await expect(tile(theirList, "get", ARVEN)).toHaveAccessibleName(
    /1 of 2 in You get/
  );
  const details = page.getByRole("button", {
    name: "Details for Arven (SVI 166)",
  });
  await details.click();
  const popup = page.getByRole("dialog", { name: "Arven" });
  await expect(popup).toBeVisible();
  await expect(popup).toContainText("2 available");
  await expectPageChecks(page, `card details at ${width}`);
  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(details).toBeFocused();
  await show(page, "Proposal");
  await expect(arvenGet).toContainText("1");
  await page
    .getByRole("button", { name: "Increase Arven (SVI 166) you get" })
    .click();
  await expect(arvenGet).toContainText("2");
  await expect(
    page.getByRole("button", { name: "Increase Arven (SVI 166) you get" })
  ).toBeDisabled();
  await show(page, "Cards");
  const arvenTile = tile(theirList, "get", ARVEN);
  await expect(arvenTile).toHaveAttribute("aria-disabled", "true");
  await arvenTile.click({ force: true });
  await expect(library(page).getByRole("status")).toHaveText(
    "All 2 Arven (SVI 166) are in You get."
  );
  await show(page, "Proposal");
  await expect(arvenGet).toContainText("2");

  // 4: a card is on one side only.
  await show(page, "Cards");
  await tile(theirList, "get", BOSS).click();
  await mine.click();
  const bossTile = tile(myList, "give", BOSS);
  await expect(bossTile).toHaveAccessibleName(/in You get/);
  await expect(bossTile).toHaveAttribute("aria-disabled", "true");
  await bossTile.click({ force: true });
  await expect(library(page).getByRole("status")).toHaveText(
    "Boss's Orders (PAL 172) is in You get. A card can't be on both sides."
  );
  await show(page, "Proposal");
  await expect(group(page, "Boss's Orders (PAL 172) you give")).toHaveCount(0);
  await show(page, "Cards");
  await tile(myList, "give", IONO_254).click();
  await show(page, "Proposal");
  await expect(group(page, "Iono (PAL 254) you give")).toContainText("1");

  // 5: removing a line moves focus to its side's heading.
  await page
    .getByRole("button", { name: "Decrease Boss's Orders (PAL 172) you get" })
    .click();
  await expect(group(page, "Boss's Orders (PAL 172) you get")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "You get", level: 2 })
  ).toBeFocused();

  // 6: leaving with Arven ×2 held asks first.
  await tradesTab(page).click();
  await expect(dialog).toBeVisible();
  await expectPageChecks(page, `the discard question at ${width}`);
  await dialog
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(builder);
  await expect(tradesTab(page)).toBeFocused();
  await show(page, "Proposal");
  await expect(arvenGet).toContainText("2");
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Keep editing", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(builder);
  await expect(findLink).toHaveAttribute("href", "/trades/find");
  await findLink.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/find`);
  await page.goBack();
  await expect(page).toHaveURL(builder);
  await expect(dialog).toHaveCount(0);
  await show(page, "Proposal");
  await expect(lists(page).get).toHaveText("Nothing yet");
  await expect(lists(page).give).toHaveText("Nothing yet");

  // 7: the browser's own warning is armed only while cards are held, and a reload starts empty.
  await expect.poll(warns).toBe(false);
  await show(page, "Cards");
  await tile(theirList, "get", ARVEN).click();
  await expect.poll(warns).toBe(true);
  const seen: string[] = [];
  const accept = (d: Dialog) => {
    seen.push(d.type());
    void d.accept();
  };
  page.on("dialog", accept);
  await page.reload();
  await show(page, "Proposal");
  await expect(lists(page).get).toHaveText("Nothing yet");
  await expect(lists(page).give).toHaveText("Nothing yet");
  // A reload is a direct entry: the back link says Find trades.
  await expect(findLink).toBeVisible();
  await expect(listLink).toHaveCount(0);
  page.off("dialog", accept);
  // Chromium may skip the warning, but any dialog that did show is the browser's own.
  expect(seen.every((type) => type === "beforeunload")).toBe(true);

  // 8: nothing is asked when no card was added.
  await tradesTab(page).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades`);
  await expect(dialog).toHaveCount(0);

  // 9: Propose trade on a Friend's Trade List opens the builder empty.
  await page.goto(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  await expect(main).toContainText("Arven");
  await expect(main.getByRole("button", { name: /^Add / })).toHaveCount(0);
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(builder);
  await show(page, "Proposal");
  await expect(lists(page).get).toHaveText("Nothing yet");
  await expect(lists(page).give).toHaveText("Nothing yet");
  // The back link returns to the Friend's Trade List, where the collector came from.
  await expect(findLink).toHaveCount(0);
  await expect(listLink).toHaveAttribute(
    "href",
    `/friends/${ashHandle}/trade-list`
  );
  await listLink.click();
  await expect(page).toHaveURL(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(builder);

  // 10: a refused send keeps the cards; the next send opens the Trade and asks nothing on the way.
  await show(page, "Cards");
  await tile(theirList, "get", IONO_185).click();
  await show(page, "Proposal");
  await page.route(
    `${ORIGIN}/api/trades`,
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            status: 422,
            json: { detail: { code: "TOO_MANY_LINES" } },
          })
        : route.fallback(),
    { times: 1 }
  );
  const send = page.getByRole("button", { name: "Send Trade Proposal" });
  await send.click();
  await expect(main.getByRole("alert")).toHaveText(
    "A Trade Proposal can list up to 50 cards on each side. Remove some, then send again."
  );
  await expect(group(page, "Iono (PAL 185) you get")).toContainText("1");
  await send.click();
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`));
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
  await expect(toast(page)).toContainText("Trade Proposal sent to Ash K");
  await expect.poll(warns).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(builder);
  await expect(dialog).toHaveCount(0);
  await show(page, "Proposal");
  await expect(lists(page).get).toHaveText("Nothing yet");
  await expect(lists(page).give).toHaveText("Nothing yet");

  // 11: Ask to trade opens the builder with the card in You get. Leaving untouched asks nothing; one more tap does.
  const askArven = async () => {
    await page.goto(`${ORIGIN}/catalog`);
    await results(page)
      .getByRole("button", { name: /^Arven/ })
      .first()
      .click();
    await page
      .getByRole("dialog", { name: "Arven" })
      .getByRole("button", { name: "Ask Ash K to trade Arven (SVI 166)" })
      .click();
    await expect(page).toHaveURL(builder);
    await expect(page.getByRole("dialog", { name: "Arven" })).toHaveCount(0);
    await show(page, "Cards");
    await expect(theirs).toBeChecked();
    await show(page, "Proposal");
    await expect(arvenGet).toContainText("1");
    // The preloaded card is not the collector's own edit: nothing warns until they change something.
    await expect.poll(warns).toBe(false);
  };
  await askArven();
  if (isPhone(page)) {
    await show(page, "Cards");
    await expectTouchTarget(tile(theirList, "get", ARVEN));
    await expectTouchTarget(details);
    await expectTouchTarget(
      page.getByRole("tab", { name: "Cards", exact: true })
    );
    await expectTouchTarget(page.getByRole("tab", { name: /^Proposal/ }));
    await show(page, "Proposal");
    await expectTouchTarget(
      page.getByRole("button", { name: "Increase Arven (SVI 166) you get" })
    );
  } else {
    await expect(
      page.getByRole("tablist", { name: "Proposal builder" })
    ).toHaveCount(0);
  }
  await expect(findLink).toHaveAttribute("href", "/trades/find");
  await checkPanes(page, `the proposal builder from Ask to trade at ${width}`);
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/catalog`);
  await expect(dialog).toHaveCount(0);
  await askArven();
  await show(page, "Cards");
  await tile(theirList, "get", BOSS).click();
  await expect.poll(warns).toBe(true);
  await page.goBack();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/catalog`);
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("the proposal builder opens empty or with the asked card, lists matches first, adds one copy per tap, keeps a card to one side, asks before leaving with cards, and sends", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed and many page checks: well over 30 s on a loaded host.
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

  test("the same at 375 px, with each pane checked, no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed and many page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "375 px");
  });
});
