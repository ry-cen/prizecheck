// Ticket #284: the proposal builder, one per Friend (Trading spec "Building a proposal"), laid out like the Deck
// builder. Misty opens it prefilled from Find trades, empty from Ash's Trade List page, and with one Arven already in You get
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
import { traderIdOf } from "./support/conversations";
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
  page.getByRole("group", { name, exact: true });
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

  const builder = `${ORIGIN}/trades/new/${await traderIdOf(ash.page)}`;
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

  // 1: Single-member need groups prefill both sides; removing their cards leaves the usual empty state.
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
  await expect(
    group(page, "Iono (PAL 185) you get").getByText("1", { exact: true })
  ).toHaveText("1");
  await expect(
    group(page, "Iono (PAL 254) you give").getByText("1", { exact: true })
  ).toHaveText("1");
  await expect(
    page.getByRole("region", { name: /^Choose printings for You/ })
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Decrease Iono (PAL 185) you get" })
    .click();
  await page
    .getByRole("button", { name: "Decrease Iono (PAL 254) you give" })
    .click();
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
  // Real clicks above provide Chromium sticky activation.
  expect(seen).toEqual(["beforeunload"]);

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
  // Send went away with the builder: focus moves to the sent Trade's headline instead of the page body.
  await expect(heading(page)).toBeFocused();
  await expect(heading(page)).toBeInViewport();
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

// T-A UI-only edge states forced at the transport boundary. The real legacy
// receipt/migration proofs live in api/tests/test_trade_send_replay.py. These
// scenarios exercise the real composer and its imported generated send client;
// they do not establish the later full thread-detail navigation gate.
async function replayComposer(
  page: Page,
  collectors: Parameters<typeof story>[1]
) {
  const ids = seedCatalog();
  const ash = await collectors.signIn();
  await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, "Ash Shelf");
  await hold(ash.page, shelf, ids["SVI 166"], 3);
  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  await befriend(page, ash.page);
  const trader = await traderIdOf(ash.page);
  const current = await api(page, "POST", "/api/trades", {
    recipient_trader_id: trader,
    you_give: [],
    you_get: [{ edition_id: ids["SVI 166"], quantity: "2" }],
    idempotency_key: randomUUID(),
  });
  await page.goto(`${ORIGIN}/trades/new/${trader}`);
  await tile(
    page.getByRole("list", { name: "Ash K's Trade List" }),
    "get",
    ARVEN
  ).click();
  return current;
}

for (const outcome of ["current", "unavailable"] as const) {
  test(`an already-applied ${outcome} send settles the mounted draft after double-click and refuses an in-flight edit`, async ({
    page,
    collectors,
  }) => {
    const current = await replayComposer(page, collectors);
    const keys: string[] = [];
    let release = () => {};
    const responseReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`${ORIGIN}/api/trades`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      keys.push(route.request().postDataJSON().idempotency_key);
      await responseReady;
      await route.fulfill(
        outcome === "current"
          ? {
              status: 201,
              json: {
                outcome: "already_applied",
                view: "current",
                label: "Current Trade",
                trade: current,
              },
            }
          : {
              status: 409,
              json: {
                detail: {
                  code: "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE",
                  outcome: "already_applied",
                  view: "unavailable",
                },
              },
            }
      );
    });
    try {
      const send = page.getByRole("button", { name: "Send Trade Proposal" });
      // Two DOM clicks in one event turn exercise the synchronous send guard,
      // before React's disabled/busy render can protect a second invocation.
      await send.evaluate((button) => {
        button.click();
        button.click();
      });
      await expect.poll(() => keys.length).toBe(1);
      await page
        .getByRole("radio", { name: "You pay", exact: true })
        .click({ force: true });
      await expect(
        page.getByRole("radio", { name: "No cash", exact: true })
      ).toBeChecked();
      await expect(
        page.getByRole("textbox", { name: "Amount in US dollars" })
      ).toHaveCount(0);
    } finally {
      release();
    }
    if (outcome === "current") {
      await expect(heading(page)).toHaveText("Current Trade");
      await expect(page.getByRole("main").getByRole("status")).toContainText(
        "Your proposal was already sent. These are the current terms."
      );
      await expect(
        page.getByRole("link", { name: "View current Trade" })
      ).toHaveAttribute("href", `/trades/${current.thread_id}`);
      await expect(
        page.getByRole("region", { name: "You get", exact: true })
      ).toContainText("2 copies");
    } else {
      await expect(page.getByRole("main").getByRole("status")).toContainText(
        "Your proposal was already sent. This Trade isn't available to view. Return to Trades to check your items."
      );
      await expect(
        page.getByRole("link", { name: "View current Trade" })
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", { name: "You get", exact: true })
      ).toHaveCount(0);
    }
    await expect(
      page.getByRole("button", { name: "Send Trade Proposal" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Amount in US dollars" })
    ).toHaveCount(0);
    await expect(toast(page)).not.toContainText("Trade Proposal sent to Ash K");
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      })
    ).toBe(false);
    await page
      .getByRole("link", { name: "Back to Trades", exact: true })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/trades`);
    await page.reload();
    expect(keys).toHaveLength(1);
  });
}

test("an unknown initial-send outcome keeps its key and a known nonterminal refusal allows a new one", async ({
  page,
  collectors,
}) => {
  await replayComposer(page, collectors);
  const keys: string[] = [];
  await page.route(`${ORIGIN}/api/trades`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    keys.push(route.request().postDataJSON().idempotency_key);
    const status = keys.length === 1 ? 503 : keys.length === 2 ? 422 : 409;
    const detail =
      keys.length === 1
        ? { code: "INVENTORY_TEMPORARILY_UNAVAILABLE" }
        : keys.length === 2
          ? { code: "TOO_MANY_LINES" }
          : {
              code: "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE",
              outcome: "already_applied",
              view: "unavailable",
            };
    await route.fulfill({ status, json: { detail } });
  });
  const send = page.getByRole("button", { name: "Send Trade Proposal" });
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).not.toBeEmpty();
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "A Trade Proposal can list up to 50 cards on each side. Remove some, then send again."
  );
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  await send.click();
  await expect(
    page.getByRole("button", { name: "Send Trade Proposal" })
  ).toHaveCount(0);
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[1]);
});

/** Small independent journeys for semantic draft loss; the long builder story above owns layout. */
async function discardBuilder(
  page: Page,
  collectors: Parameters<typeof story>[1],
  counter: boolean
) {
  const ids = seedCatalog();
  const ash = await collectors.signIn();
  const handle = await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, "Ash Shelf");
  await hold(ash.page, shelf, ids["SVI 166"], 3);
  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  await befriend(page, ash.page);
  let previous = `/friends/${handle}/trade-list`;
  if (counter) {
    const trade = await api(ash.page, "POST", "/api/trades", {
      recipient_trader_id: await traderIdOf(page),
      you_give: [{ edition_id: ids["SVI 166"], quantity: "1" }],
      you_get: [],
      idempotency_key: randomUUID(),
    });
    previous = `/trades/${trade.thread_id}`;
  }
  await page.goto(`${ORIGIN}${previous}`);
  await page
    .getByRole("button", {
      name: counter ? "Counter" : "Propose trade to Ash K",
      exact: true,
    })
    .click();
  await expect(heading(page)).toHaveText(
    counter ? "Counter to Ash K" : "Trade Proposal to Ash K"
  );
  return {
    address: page.url(),
    previous: `${ORIGIN}${previous}`,
    dialog: page.getByRole("dialog", { name: /Discard this/ }),
    other: ash.page,
  };
}

async function editDiscardCards(page: Page, counter: boolean) {
  if (!counter) {
    await show(page, "Cards");
    await tile(
      page.getByRole("list", { name: "Ash K's Trade List" }),
      "get",
      ARVEN
    ).click();
  }
  await show(page, "Proposal");
  if (counter)
    await page
      .getByRole("button", { name: "Increase Arven (SVI 166) you get" })
      .click();
}

async function reloadWithoutWarning(page: Page) {
  const seen: string[] = [];
  const accept = (dialog: Dialog) => {
    seen.push(dialog.type());
    void dialog.accept();
  };
  page.on("dialog", accept);
  try {
    await page.reload();
    await expect(heading(page)).not.toHaveText("Counter");
    await expect(
      page.getByRole("button", {
        name: /Send (Counter|Trade Proposal)/,
        includeHidden: true,
      })
    ).toBeAttached();
    expect(seen).toEqual([]);
  } finally {
    page.off("dialog", accept);
  }
}

/** Real backward Tab actions, bounded by the controls preceding the stepper; this is navigation, not a retry loop. */
async function reachReviewBackwards(
  page: Page,
  decrease: Locator,
  region: Locator
) {
  const main = page.locator("main:visible");
  const row = decrease.locator("xpath=ancestor::li[1]");
  const order = (element: Element) =>
    Array.from(
      element
        .closest("main")!
        .querySelectorAll("button,a[href],input,select,textarea,[tabindex]")
    ).indexOf(element);
  let previous = await decrease.evaluate(order);
  const stops = previous;
  for (let step = 0; step < stops; step++) {
    await page.keyboard.press("Shift+Tab");
    const focused = page.locator(":focus");
    await expect(main.locator(":focus")).toHaveCount(1);
    await expect(focused).toBeVisible();
    await expect(focused).toBeEnabled();
    await expect(
      row.locator(":focus").or(region.locator(":focus"))
    ).toHaveCount(1);
    const index = await focused.evaluate(order);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(previous);
    previous = index;
    if ((await region.locator("button:focus").count()) === 1) return;
  }
  throw new Error(
    "Review control was not reached before backward navigation exhausted the builder controls."
  );
}

type SendOutcome =
  | "changed"
  | "review-failed"
  | "refused"
  | "failure"
  | "unknown"
  | "gone"
  | "current"
  | "unavailable"
  | "success";
async function holdSend(
  page: Page,
  counter: boolean,
  address: string,
  outcome: SendOutcome,
  other: Page
): Promise<() => Promise<void>> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let released = false;
  const thread = new URL(address).pathname.split("/")[2];
  if (outcome === "review-failed")
    await page.route(`${ORIGIN}/api/trades/${thread}`, (route) =>
      released ? route.abort("failed") : route.fallback()
    );
  await page.route(
    counter ? /\/api\/trades\/[^/]+\/offer$/ : `${ORIGIN}/api/trades`,
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      arrive();
      await held;
      if (outcome === "changed" || outcome === "success")
        await route.continue();
      else if (outcome === "unknown") await route.abort("failed");
      else if (outcome === "current") {
        const packet = route.request().postDataJSON();
        const trade = await api(page, "POST", "/api/trades", {
          ...packet,
          idempotency_key: randomUUID(),
        });
        await route.fulfill({
          status: 201,
          json: {
            outcome: "already_applied",
            view: "current",
            label: "Current Trade",
            trade,
          },
        });
      } else
        await route.fulfill({
          status:
            outcome === "review-failed" || outcome === "unavailable"
              ? 409
              : outcome === "gone"
                ? 404
                : outcome === "failure"
                  ? 503
                  : 422,
          json: {
            detail:
              outcome === "unavailable"
                ? {
                    code: "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE",
                    outcome: "already_applied",
                    view: "unavailable",
                  }
                : {
                    code:
                      outcome === "review-failed"
                        ? "OFFER_CHANGED"
                        : outcome === "gone"
                          ? "TRADE_NOT_FOUND"
                          : "TOO_MANY_LINES",
                  },
          },
        });
    }
  );

  return async () => {
    try {
      await arrived;
      if (outcome === "changed") {
        const { live_offer: live } = await api(
          other,
          "GET",
          `/api/trades/${thread}`
        );
        await api(other, "POST", `/api/trades/${thread}/offer`, {
          offer_id: live.offer_id,
          revision: live.revision,
          you_give: live.you_give.map(
            (card: { edition_id: string; copies: string }) => ({
              edition_id: card.edition_id,
              quantity: String(Number(card.copies) + 1),
            })
          ),
          you_get: [],
          cash: null,
          idempotency_key: randomUUID(),
        });
      }
    } finally {
      released = true;
      release();
    }
  };
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`draft discard at ${viewport.width}px`, () => {
    test.use({ viewport });
    for (const counter of [false, true]) {
      const builder = counter ? "Counter" : "new proposal";
      test(`${builder}: real reload dismissal keeps edits and acceptance discards them`, async ({
        page,
        collectors,
      }) => {
        const { address } = await discardBuilder(page, collectors, counter);
        await editDiscardCards(page, counter);
        const warning = page.waitForEvent("dialog");
        // A dismissed Chromium reload may not settle its navigation promise. The dialog and retained UI are the evidence.
        void page.reload().catch(() => {});
        const native = await warning;
        expect(native.type()).toBe("beforeunload");
        await native.dismiss();
        await expect(page).toHaveURL(address);
        await expect(group(page, "Arven (SVI 166) you get")).toContainText(
          counter ? "2" : "1"
        );
        const accepted = page.waitForEvent("dialog");
        const reload = page.reload();
        const prompt = await accepted;
        expect(prompt.type()).toBe("beforeunload");
        await prompt.accept();
        await reload;
        await show(page, "Proposal");
        if (counter)
          await expect(group(page, "Arven (SVI 166) you get")).toContainText(
            "1"
          );
        else await expect(lists(page).get).toHaveText("Nothing yet");
      });

      test(`${builder}: cash counts, reverting does not, and removing opening cards counts`, async ({
        page,
        collectors,
      }) => {
        const { address, dialog } = await discardBuilder(
          page,
          collectors,
          counter
        );
        await show(page, "Proposal");
        await page.getByRole("radio", { name: "You pay", exact: true }).click();
        const amount = page.getByRole("textbox", {
          name: "Amount in US dollars",
        });
        await amount.fill("5.00");
        const warning = page.waitForEvent("dialog");
        void page.reload().catch(() => {});
        const native = await warning;
        expect(native.type()).toBe("beforeunload");
        await native.dismiss();
        await expect(amount).toHaveValue("5.00");
        await page.locator("main:visible").getByRole("link").first().click();
        await expect(
          dialog.getByRole("button", { name: "Keep editing", exact: true })
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(page).toHaveURL(address);
        await page.getByRole("radio", { name: "No cash", exact: true }).click();
        await editDiscardCards(page, counter);
        await page
          .getByRole("button", { name: "Decrease Arven (SVI 166) you get" })
          .click();
        await reloadWithoutWarning(page);
        if (counter) {
          await show(page, "Proposal");
          await page
            .getByRole("button", { name: "Decrease Arven (SVI 166) you get" })
            .click();
          await expect(lists(page).get).toHaveText("Nothing yet");
          await page
            .getByRole("navigation", { name: "Main views" })
            .getByRole("button", { name: "Collection", exact: true })
            .click();
          await expect(dialog).toBeVisible();
          await dialog
            .getByRole("button", { name: "Keep editing", exact: true })
            .click();
          const removedWarning = page.waitForEvent("dialog");
          void page.reload().catch(() => {});
          const removed = await removedWarning;
          expect(removed.type()).toBe("beforeunload");
          await removed.dismiss();
          await expect(lists(page).get).toHaveText("Nothing yet");
        } else {
          await page
            .getByRole("navigation", { name: "Main views" })
            .getByRole("button", { name: "Collection", exact: true })
            .click();
          await expect(page).toHaveURL(`${ORIGIN}/collection`);
          await expect(dialog).toHaveCount(0);
        }
      });

      for (const direction of ["link", "Back", "Forward"] as const) {
        for (const answer of ["Escape", "Keep editing", "Discard"] as const) {
          test(`${builder}: ${direction} with ${answer} keeps focus or reaches its target`, async ({
            page,
            collectors,
          }) => {
            const { address, previous, dialog } = await discardBuilder(
              page,
              collectors,
              counter
            );
            if (direction === "Forward") {
              await page
                .getByRole("navigation", { name: "Main views" })
                .getByRole("button", { name: "Collection", exact: true })
                .click();
              await expect(page).toHaveURL(`${ORIGIN}/collection`);
              await page.goBack();
              await expect(page).toHaveURL(address);
            }
            await editDiscardCards(page, counter);
            const link = page.locator("main:visible").getByRole("link").first();
            const target =
              direction === "Forward"
                ? `${ORIGIN}/collection`
                : direction === "Back"
                  ? previous
                  : new URL((await link.getAttribute("href"))!, ORIGIN).href;
            const opener =
              direction === "link"
                ? link
                : page.getByRole("button", {
                    name: "Increase Arven (SVI 166) you get",
                  });
            await opener.focus();
            if (direction === "link") await link.click();
            else if (direction === "Back") void page.goBack().catch(() => {});
            else void page.goForward().catch(() => {});
            await expect(dialog).toBeVisible();
            await expect(
              dialog.getByRole("button", { name: "Keep editing", exact: true })
            ).toBeFocused();
            if (answer === "Escape") await page.keyboard.press("Escape");
            else
              await dialog
                .getByRole("button", { name: answer, exact: true })
                .click();
            await expect(dialog).toHaveCount(0);
            if (answer === "Discard") await expect(page).toHaveURL(target);
            else {
              await expect(page).toHaveURL(address);
              await expect(
                group(page, "Arven (SVI 166) you get")
              ).toContainText(counter ? "2" : "1");
              await expect(opener).toBeFocused();
            }
          });
        }
      }

      const continuityCases = counter
        ? ([
            { control: "Increase", outcome: "changed" },
            { control: "Increase", outcome: "refused" },
            { control: "Decrease", outcome: "changed" },
            { control: "cash", outcome: "changed" },
            { control: "Increase", outcome: "success" },
            { control: "blank-area blur", outcome: "changed" },
            { control: "outside focus", outcome: "changed" },
          ] as const)
        : ([
            { control: "tile", outcome: "current" },
            { control: "Increase", outcome: "unavailable" },
            { control: "Decrease", outcome: "refused" },
            { control: "cash", outcome: "unknown" },
          ] as const);
      for (const { control, outcome } of continuityCases) {
        const name =
          control === "blank-area blur"
            ? `${builder}: blank-area blur is not taken back`
            : control === "outside focus"
              ? `${builder}: outside focus is kept`
              : `${builder}: focused ${control} stays live after ${outcome}`;
        test(name, async ({ page, collectors }) => {
          const { address, other } = await discardBuilder(
            page,
            collectors,
            counter
          );
          await editDiscardCards(page, counter);
          if (control === "cash") {
            await page
              .getByRole("radio", { name: "You pay", exact: true })
              .click();
            await page
              .getByRole("textbox", { name: "Amount in US dollars" })
              .fill("1.00");
          }
          const settle = await holdSend(page, counter, address, outcome, other);
          const send = page.getByRole("button", {
            name: counter ? "Send Counter" : "Send Trade Proposal",
            exact: true,
          });
          const decrease = page.getByRole("button", {
            name: "Decrease Arven (SVI 166) you get",
          });
          const outside = page
            .getByRole("navigation", { name: "Main views" })
            .getByRole("button", { name: /^Trades(?:,|$)/ });
          let target: Locator;
          try {
            await send.click();
            if (control === "tile") {
              await show(page, "Cards");
              target = tile(
                page.getByRole("list", { name: "Ash K's Trade List" }),
                "get",
                ARVEN
              );
            } else if (control === "cash")
              target = page.getByRole("textbox", {
                name: "Amount in US dollars",
              });
            else if (control === "Decrease") target = decrease;
            else
              target = page.getByRole("button", {
                name: "Increase Arven (SVI 166) you get",
              });
            await target.focus();
            if (control === "outside focus") await outside.focus();
            if (control === "blank-area blur") {
              const main = page.locator("main:visible");
              await main.evaluate((element) =>
                element.scrollIntoView({ block: "end" })
              );
              const box = await main.boundingBox();
              const x = box!.x + 4,
                y = Math.min(box!.y + box!.height - 4, viewport.height - 100);
              expect(
                await page.evaluate(
                  ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
                  { x, y }
                )
              ).toBe("MAIN");
              await page.mouse.click(x, y);
              await expect
                .poll(() =>
                  page.evaluate(() => document.activeElement?.tagName)
                )
                .toBe("BODY");
            }
          } finally {
            await settle();
          }
          if (outcome === "success") {
            await expect(page).toHaveURL(
              new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`)
            );
            await expect(heading(page)).toBeFocused();
          } else if (outcome === "current" || outcome === "unavailable")
            await expect(heading(page)).toBeFocused();
          else if (control === "blank-area blur") {
            await expect(
              page.getByRole("button", {
                name: "I reviewed the current offer",
                exact: true,
              })
            ).toBeVisible();
            await expect
              .poll(() => page.evaluate(() => document.activeElement?.tagName))
              .toBe("BODY");
          } else if (control === "outside focus") {
            await expect(
              page.getByRole("button", {
                name: "I reviewed the current offer",
                exact: true,
              })
            ).toBeVisible();
            await expect(outside).toBeFocused();
          } else if (control === "Increase") {
            await expect(decrease).toBeFocused();
            if (outcome === "changed") {
              const region = page.getByRole("region", {
                name: "Current offer to review",
              });
              await expect(
                region.getByRole("button", {
                  name: "I reviewed the current offer",
                  exact: true,
                })
              ).toBeVisible();
              await expect(
                page.locator('main:visible > p[role="status"]')
              ).toHaveText("The offer changed. Your draft is kept.");
              await expect(decrease).toBeFocused(); // Completing checking never takes focus on its own.
              await reachReviewBackwards(page, decrease, region);
            }
          } else {
            await expect(target!).toBeFocused();
            if (control === "cash")
              await expect(target!).not.toHaveAttribute("readonly", "");
          }
          if (control !== "blank-area blur" && control !== "outside focus")
            await expect
              .poll(() => page.evaluate(() => document.activeElement?.tagName))
              .not.toBe("BODY");
        });
      }

      const settlementOutcomes = counter
        ? ([
            "changed",
            "review-failed",
            "refused",
            "failure",
            "unknown",
            "gone",
          ] as const)
        : ([
            "refused",
            "failure",
            "unknown",
            "current",
            "unavailable",
          ] as const);
      for (const outcome of settlementOutcomes) {
        test(`${builder}: focused Send settles safely after ${outcome}`, async ({
          page,
          collectors,
        }) => {
          const { address, other } = await discardBuilder(
            page,
            collectors,
            counter
          );
          await editDiscardCards(page, counter);
          const send = page.getByRole("button", {
            name: counter ? "Send Counter" : "Send Trade Proposal",
            exact: true,
          });
          const settle = await holdSend(page, counter, address, outcome, other);
          try {
            await send.click();
            await expect(send).toBeFocused();
          } finally {
            await settle();
          }
          if (outcome !== "current" && outcome !== "unavailable")
            await expect(send).not.toHaveAttribute("aria-disabled", "true");
          if (outcome === "changed") {
            const review = page.getByRole("button", {
              name: "I reviewed the current offer",
              exact: true,
            });
            await expect(review).toBeFocused();
            await review.click();
            await expect(page.getByRole("alert")).toBeFocused();
            await expect(page.getByRole("alert")).toContainText(
              "Current offer reviewed"
            );
          } else if (outcome === "review-failed")
            await expect(
              page.getByRole("button", {
                name: "Retry current offer",
                exact: true,
              })
            ).toBeFocused();
          else if (outcome === "gone")
            await expect(
              page
                .getByRole("region", { name: "Current offer to review" })
                .getByRole("status")
            ).toBeFocused();
          else if (outcome === "current" || outcome === "unavailable")
            await expect(heading(page)).toBeFocused();
          else if (outcome === "refused" && counter) {
            // Only enabled Send or the persistent refusal notice may own settlement focus.
            await expect(
              send
                .and(page.locator(":focus:not(:disabled)"))
                .or(page.locator('p[role="alert"]:focus'))
            ).toHaveCount(1);
          } else {
            await expect(send).toBeEnabled();
            await expect(send).toBeFocused();
          }
        });
      }

      for (const outcome of ["refused", "unknown"] as const) {
        test(`${builder}: ${outcome} send keeps focused cash read-only then resumes editing and warnings`, async ({
          page,
          collectors,
        }) => {
          const { address, dialog } = await discardBuilder(
            page,
            collectors,
            counter
          );
          await editDiscardCards(page, counter);
          await page
            .getByRole("radio", { name: "You pay", exact: true })
            .click();
          const amount = page.getByRole("textbox", {
            name: "Amount in US dollars",
          });
          await amount.fill("2.00");
          let release!: () => void;
          const held = new Promise<void>((resolve) => {
            release = resolve;
          });
          let arrive!: () => void;
          const arrived = new Promise<void>((resolve) => {
            arrive = resolve;
          });
          await page.route(
            counter ? /\/api\/trades\/[^/]+\/offer$/ : `${ORIGIN}/api/trades`,
            async (route) => {
              if (route.request().method() !== "POST") return route.fallback();
              arrive();
              await held;
              if (outcome === "unknown") await route.abort("failed");
              else
                await route.fulfill({
                  status: 422,
                  json: { detail: { code: "TOO_MANY_LINES" } },
                });
            }
          );
          try {
            await amount.focus();
            // Start the command without moving the existing keyboard focus.
            await page
              .getByRole("button", {
                name: counter ? "Send Counter" : "Send Trade Proposal",
                exact: true,
              })
              .evaluate((button) => button.click());
            await arrived;
            await expect(amount).toBeFocused();
            await expect(amount).toHaveAttribute("readonly", "");
            await expect(amount).toHaveCSS("opacity", "0.45");
            await expect(amount).toHaveCSS("cursor", "default");
            await page.keyboard.type("5");
            await expect(amount).toHaveValue("2.00");
          } finally {
            release();
          }
          await expect(page).toHaveURL(address);
          await expect(amount).not.toHaveAttribute("readonly", "");
          await expect(amount).toBeFocused();
          await amount.fill("5.00");
          await page
            .getByRole("button", { name: "Increase Arven (SVI 166) you get" })
            .click();
          await expect(group(page, "Arven (SVI 166) you get")).toContainText(
            counter ? "3" : "2"
          );
          const warning = page.waitForEvent("dialog");
          void page.reload().catch(() => {});
          const prompt = await warning;
          expect(prompt.type()).toBe("beforeunload");
          await prompt.dismiss();
          await expect(amount).toHaveValue("5.00");
          await page.locator("main:visible").getByRole("link").first().click();
          await expect(dialog).toBeVisible();
          await dialog
            .getByRole("button", { name: "Keep editing", exact: true })
            .click();
          await expect(page).toHaveURL(address);
        });
      }

      test(`${builder}: draft edits freeze during a send without losing focus and successful sends do not warn`, async ({
        page,
        collectors,
      }) => {
        const { address } = await discardBuilder(page, collectors, counter);
        await editDiscardCards(page, counter);
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let arrived!: () => void;
        const sending = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        await page.route(
          counter ? /\/api\/trades\/[^/]+\/offer$/ : `${ORIGIN}/api/trades`,
          async (route) => {
            if (route.request().method() !== "POST") return route.fallback();
            arrived();
            await held;
            await route.continue();
          }
        );
        try {
          const send = page.getByRole("button", {
            name: counter ? "Send Counter" : "Send Trade Proposal",
            exact: true,
          });
          await send.click();
          await sending;
          await expect(send).toBeFocused();
          const stepper = page.getByRole("button", {
            name: "Decrease Arven (SVI 166) you get",
          });
          await expect(stepper).toHaveCSS("opacity", "0.45");
          await expect(stepper).toHaveCSS("cursor", "default");
          const frozenBackground = await stepper.evaluate(
            (element) => getComputedStyle(element).backgroundColor
          );
          await stepper.hover();
          await expect(stepper).toHaveCSS("background-color", frozenBackground);
          const payer = page.getByRole("radio", {
            name: "You pay",
            exact: true,
          });
          await expect(payer).toBeDisabled();
          await expect(payer).toHaveCSS("opacity", "0.45");
          await expect(payer).toHaveCSS("cursor", "default");
          const payerText = payer.locator("span").first();
          const frozenText = await payerText.evaluate(
            (element) => getComputedStyle(element).color
          );
          await payer.hover();
          await expect(payerText).toHaveCSS("color", frozenText);
          if (!counter)
            await expect(
              page.getByRole("textbox", { name: "Message (optional)" })
            ).toHaveCSS("opacity", "0.45");
          // Forced activation also checks the handler boundary, beyond the accessible disabled state.
          await payer.click({ force: true });
          await expect(
            page.getByRole("radio", { name: "No cash", exact: true })
          ).toBeChecked();
          await expect(
            page.getByRole("textbox", { name: "Amount in US dollars" })
          ).toHaveCount(0);
          await page
            .getByRole("button", { name: "Decrease Arven (SVI 166) you get" })
            .click({ force: true });
          await expect(group(page, "Arven (SVI 166) you get")).toContainText(
            counter ? "2" : "1"
          );
          await show(page, "Cards");
          const frozenTile = tile(
            page.getByRole("list", { name: "Ash K's Trade List" }),
            "get",
            ARVEN
          );
          await expect(frozenTile).toHaveCSS("opacity", "0.45");
          await expect(frozenTile).toHaveCSS("cursor", "default");
          await frozenTile.click({ force: true });
          await show(page, "Proposal");
          await expect(group(page, "Arven (SVI 166) you get")).toContainText(
            counter ? "2" : "1"
          );
          // A synthetic event checks the in-flight rule without aborting the real pending request.
          expect(
            await page.evaluate(() => {
              const event = new Event("beforeunload", { cancelable: true });
              window.dispatchEvent(event);
              return event.defaultPrevented;
            })
          ).toBe(false);
        } finally {
          release();
        }
        await expect(page).not.toHaveURL(address);
        const seen: string[] = [];
        const accept = (dialog: Dialog) => {
          seen.push(dialog.type());
          void dialog.accept();
        };
        page.on("dialog", accept);
        await page.reload();
        await expect(heading(page)).not.toHaveText(
          /^(Counter|Trade Proposal) to/
        );
        expect(seen).toEqual([]);
        page.off("dialog", accept);
      });
    }
  });
}
