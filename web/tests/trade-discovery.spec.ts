// Ticket #276, on the proposal builder of #284: Find trades among Friends and Ask to trade (Trading spec "Finding
// matches" and "Card popup: Ask to trade", prototype verdict variant A). Misty wants Ash's Arven (a Deck line and Trade
// Wants) and his Reverse Holo Boss's Orders (a Deck line that takes any finish), and Ash's Deck wants her Iono: a
// two-way row, first. Brock has the Iono PAF 80 on her Trade Wants and wants nothing of hers: a one-way row with no
// sale tag, since he isn't Open to cash offers. The open row shows both sides with their counts and tags. A list read
// that cut Ash's side short shows the header from the per-Friend read once Show 1 more loads, and focus moves to that
// side's heading. Propose trade opens an empty proposal builder with the matched cards first, two are added with one
// tap each and the proposal is sent. In the card popup, Ask to trade opens Brock's builder with the card in You get;
// leaving untouched asks nothing, and leaving after one more tap asks first. A collector with no Friends is told that
// matching needs Friends. Nothing that reaches the browser names a Location or a Deck. At desktop width and at 375 px.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py). The other collectors sign in first, so the
// test's own page signs in afterwards as a new account.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { traderIdOf } from "./support/conversations";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { bodyOf } from "./support/trades";

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

/** A Deck with these lines (Edition id, copies); returns its id. */
async function deckWith(
  page: Page,
  name: string,
  lines: [string, number][]
): Promise<string> {
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  const deckId = created.location.id as string;
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  await api(page, "POST", `/api/decks/${deckId}/deck-list/changes`, {
    revision: detail.deck_list.revision,
    idempotency_key: randomUUID(),
    changes: lines.map(([edition, quantity]) => ({
      edition_id: edition,
      quantity: String(quantity),
    })),
  });
  return deckId;
}

const tradeWant = (page: Page, edition: string, quantity: number) =>
  api(page, "PUT", `/api/trade-wants/${edition}`, {
    quantity: String(quantity),
  });

const willAccept = (page: Page, edition: string, rule: string) =>
  api(page, "PUT", `/api/trade-wants/will-accept/${edition}`, { rule });

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
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
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });

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
  const ashTrader = await traderIdOf(ash.page);
  const shelf = await forTradeBinder(ash.page, `${secret} Shelf`);
  await hold(ash.page, shelf, ids["SVI 166"], 2);
  await hold(ash.page, shelf, ids["PAL 172 Reverse Holo"], 1);
  const ashDeck = await deckWith(ash.page, `${secret} Lost Box`, [
    [ids["PAL 185"], 2],
  ]);
  const brock = await collectors.signIn({ contextOptions });
  const brockHandle = await nameCollector(brock.page, "Brock T");
  const brockTrader = await traderIdOf(brock.page);
  const brockBinder = await forTradeBinder(brock.page, `${secret} Case`);
  await hold(brock.page, brockBinder, ids["PAF 80"], 1);
  await hold(brock.page, brockBinder, ids["PAL 254"], 1);

  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const binder = await forTradeBinder(page, `${secret} Binder`);
  await hold(page, binder, ids["PAL 185"], 3);
  const mistyDeck = await deckWith(page, `${secret} Gardevoir`, [
    [ids["SVI 166"], 1],
    [ids["PAL 172"], 1],
  ]);
  await tradeWant(page, ids["SVI 166"], 2);
  await tradeWant(page, ids["PAF 80"], 1);
  await willAccept(page, ids["PAL 172"], "printing");
  await befriend(page, ash.page);
  await befriend(page, brock.page);
  // Everything about Trades that reaches Misty's browser, to check it never names a Location or a Deck.
  const answers: Promise<string | null>[] = [];
  page.on("response", (response) => {
    if (/\/api\/social\/trade/.test(response.url()))
      answers.push(bodyOf(response));
  });

  // A: Find trades, from the Trades tab's switch. Ash's two-way row comes first; Brock's one-way row has no tag.
  await page.goto(`${ORIGIN}/trades`);
  await page.getByRole("tab", { name: "Find trades", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/find`);
  const matches = page.getByRole("list", { name: "Matches" });
  const rows = matches.getByRole("button", { expanded: false });
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Ash K");
  await expect(rows.nth(0)).toContainText("Two-way match");
  await expect(rows.nth(0)).toContainText(
    "Ash K has 2 cards you want and wants 1 of yours"
  );
  await expect(rows.nth(1)).toContainText("Brock T has 1 card you want");
  await expect(rows.nth(1)).not.toContainText("You could buy");
  await expect(page.getByRole("main")).not.toContainText("Open to cash offers");
  await expectPageChecks(page, `Find trades at ${width}`);

  // The open row shows only the matched cards on each side, with their counts and tags, and no price.
  await matches.getByRole("button", { name: /^Ash K/ }).click();
  await expect(
    matches.getByRole("button", { name: /^Ash K/, expanded: true })
  ).toBeVisible();
  const youGet = page.getByRole("list", { name: "You get from Ash K" });
  const youGive = page.getByRole("list", { name: "You give Ash K" });
  await expect(youGet.getByRole("listitem")).toHaveCount(2);
  const arven = youGet.getByRole("listitem").filter({ hasText: "Arven" });
  await expect(arven).toContainText("3 wanted (1 for Decks)");
  await expect(arven).toContainText("For Decks and Trade Wants");
  await expect(arven).toContainText("Exact");
  await expect(arven).toContainText("×2");
  const boss = youGet
    .getByRole("listitem")
    .filter({ hasText: "Boss's Orders" });
  await expect(boss).toContainText("Any finish");
  await expect(boss).toContainText("1 wanted (1 for Decks)");
  await expect(youGive.getByRole("listitem")).toHaveCount(1);
  await expect(youGive).toContainText("Iono");
  await expect(youGive).toContainText("2 wanted (2 for Decks)");
  await expect(youGive).toContainText("For Decks");
  await expect(youGive).toContainText("×3");
  await expect(page.getByRole("main")).not.toContainText("$");
  await expect(page.getByRole("main")).not.toContainText(secret);
  await expect(
    page.getByRole("link", { name: "See all of Ash K's Trade List" })
  ).toBeVisible();
  await expectPageChecks(page, `an open match at ${width}`);

  // A2: the list read cut Ash's side short; Show 1 more loads the per-Friend read, which moves focus to the side's
  // heading and gives the row header the full read's tag.
  const listRead = `${ORIGIN}/api/social/trade-matches`;
  await page.route(listRead, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const row of body.rows)
      if (row.display_name === "Ash K") {
        row.match = "wants_what_you_have";
        row.more_you_get = row.you_get.length - 1;
        row.you_get = row.you_get.slice(0, 1);
      }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await matches.getByRole("button", { name: /^Ash K/ }).click();
  const ashHeader = matches.getByRole("button", { name: /^Ash K/ });
  await expect(ashHeader).not.toContainText("Two-way match");
  await expect(
    page.getByRole("list", { name: "You get from Ash K" }).getByRole("listitem")
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Show 1 more" }).click();
  await expect(
    page.getByRole("heading", { name: "You get", level: 4 })
  ).toBeFocused();
  await expect(
    page.getByRole("list", { name: "You get from Ash K" }).getByRole("listitem")
  ).toHaveCount(2);
  await expect(ashHeader).toContainText("Two-way match");
  await page.unroute(listRead);

  // B: Propose trade opens an empty proposal builder with the matched cards first in Ash's Trade List.
  await page.getByRole("button", { name: "Propose trade to Ash K" }).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${ashTrader}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Find trades", exact: true })
  ).toHaveAttribute("href", "/trades/find");
  await show(page, "Proposal");
  await expect(
    page.getByRole("list", { name: "You get", exact: true })
  ).toHaveText("Nothing yet");
  await expect(
    page.getByRole("list", { name: "You give", exact: true })
  ).toHaveText("Nothing yet");
  await show(page, "Cards");
  const theirList = page.getByRole("list", { name: "Ash K's Trade List" });
  const adds = theirList.getByRole("button", { name: /^Add to You get/ });
  await expect(adds.nth(0)).toHaveAccessibleName(
    /^Add to You get, Arven, SVI 166,.*3 wanted \(1 for Decks\)/
  );
  await expect(adds.nth(1)).toHaveAccessibleName(
    /^Add to You get, Boss's Orders, PAL 172,.*Reverse Holo.*1 wanted \(1 for Decks\)/
  );
  await expect(adds.nth(0)).toContainText("You want");
  await expect(adds.nth(1)).toContainText("You want");
  await expectPageChecks(
    page,
    `the proposal builder from Find trades at ${width}`
  );
  // One tap is one copy.
  await tile(theirList, "get", "Arven, SVI 166, .+?, Normal").click();
  await show(page, "Proposal");
  await expect(group(page, "Arven (SVI 166) you get")).toContainText("1");
  await expect(group(page, "Arven (SVI 166) you get")).not.toContainText("2");
  await show(page, "Cards");
  await page.getByRole("radio", { name: "My Trade List" }).click();
  await tile(
    page.getByRole("list", { name: "Your Trade List" }),
    "give",
    "Iono, PAL 185, .+?, Normal"
  ).click();
  await show(page, "Proposal");
  await expect(group(page, "Iono (PAL 185) you give")).toContainText("1");
  await page.getByRole("button", { name: "Send Trade Proposal" }).click();
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`));
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");

  // C: Ask to trade in the card popup opens Brock's builder with the card in You get.
  await page.goto(`${ORIGIN}/catalog`);
  await results(page)
    .getByRole("button", { name: /^Iono, PAF/ })
    .click();
  const popup = page.getByRole("dialog", { name: "Iono" });
  const offering = popup.getByRole("list", {
    name: "Friends with this on their Trade List",
  });
  await expect(offering.getByRole("listitem")).toHaveCount(1);
  await expect(offering).toContainText("Brock T");
  await expect(offering).toContainText("×1");
  // The popup's Add row names Misty's own Locations; the Friends' part names none of Brock's.
  await expect(offering).not.toContainText(secret);
  const askBrock = async () => {
    await popup
      .getByRole("button", { name: /^Ask Brock T to trade Iono \(PAF 0?80\)$/ })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/trades/new/${brockTrader}`);
    await show(page, "Cards");
    await expect(
      page.getByRole("radio", { name: "Their Trade List" })
    ).toBeChecked();
    await show(page, "Proposal");
    await expect(group(page, /^Iono \(PAF 0?80\) you get$/)).toContainText("1");
  };
  await askBrock();
  for (const pane of isPhone(page)
    ? (["Proposal", "Cards"] as const)
    : ([null] as const)) {
    if (pane) await show(page, pane);
    await expectPageChecks(
      page,
      `the proposal builder from Ask to trade at ${width}${pane ? `, ${pane} pane` : ""}`
    );
  }
  // Ask to trade is not a page of the Friend's, so the back link goes to Find trades.
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Find trades", exact: true })
  ).toHaveAttribute("href", "/trades/find");
  // Leaving without touching it asks nothing.
  const discard = page.getByRole("dialog", {
    name: "Discard this proposal to Brock T?",
  });
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/catalog`);
  await expect(discard).toHaveCount(0);
  // One more card makes leaving ask first.
  await results(page)
    .getByRole("button", { name: /^Iono, PAF/ })
    .click();
  await askBrock();
  await show(page, "Cards");
  await tile(
    page.getByRole("list", { name: "Brock T's Trade List" }),
    "get",
    "Iono, PAL 254, .+?, Normal"
  ).click();
  await page.goBack();
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page).toHaveURL(`${ORIGIN}/catalog`);

  // A card no Friend offers has no Ask to trade.
  await results(page)
    .getByRole("button", { name: /^Iono, PAL 185/ })
    .click();
  await expect(popup).toBeVisible();
  await expect(popup).not.toContainText(
    "Friends with this on their Trade List"
  );
  await popup.getByRole("button", { name: /^Close/ }).click();

  // Nothing about Trades that reached Misty's browser names a Location or a Deck, by name or by id.
  const bodies = (await Promise.all(answers)).filter(
    (body): body is string => body !== null
  );
  expect(bodies.length).toBeGreaterThan(0);
  for (const body of bodies)
    for (const word of [secret, shelf, ashDeck, brockBinder, binder, mistyDeck])
      expect(body).not.toContain(word);
}

/** A collector with no Friends is told that matching needs Friends; with a Friend who matches nothing, says so. */
async function noFriends(
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
  const gary = await collectors.signIn({ contextOptions });
  await nameCollector(gary.page, "Gary O");
  await signInAsOwner(page, "/trades/find");
  await nameCollector(page, "Dawn B");
  await page.goto(`${ORIGIN}/trades/find`);
  const empty = page.getByRole("region", { name: "Matching needs Friends" });
  await expect(empty).toContainText(
    "Trading matches you with your Friends. Add a Friend to see who has cards you want."
  );
  await expectPageChecks(page, `Find trades with no Friends at ${width}`);
  const add = empty.getByRole("button", { name: "Add a Friend" });
  await add.click();
  await expect(page.getByRole("dialog", { name: "Friends" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Friends" })).toHaveCount(0);
  await expect(add).toBeFocused();

  await befriend(page, gary.page);
  await page.reload();
  await expect(page.getByRole("main")).toContainText(
    "None of your Friends has cards you want or wants yours yet."
  );
  await expect(page.getByRole("list", { name: "Matches" })).toHaveCount(0);
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("Find trades shows a two-way row first, opens it and proposes from it, and Ask to trade builds one draft and asks before replacing it", async ({
    page,
    collectors,
  }) => {
    // Three collectors in three contexts, a catalog seed and several page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "desktop width");
  });

  test("Find trades tells a collector with no Friends that matching needs Friends", async ({
    page,
    collectors,
  }) => {
    await noFriends(page, collectors, size, "desktop width");
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

  test("the empty state at 375 px", async ({ page, collectors }) => {
    await noFriends(page, collectors, size, "375 px");
  });
});
