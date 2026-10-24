// Ticket #305 (Trading Stage 2, "Story specs"): the end-to-end proof, at desktop width and at 375 px.
// Story one: Ash (A, zip 00010) and Brock (B, 00013, about 3 mi away) are strangers. Both switch open discovery on in
// Settings. Brock finds Ash under Near you, opens his Trade List and messages him; Ash's Trades badge counts it after
// focus and he replies; Brock proposes from the conversation, Ash accepts and reads the meet-in-public tip, both confirm
// and see "1 completed trade", Brock adds Ash as a Friend and Ash accepts in the Friends drawer.
// Story two: Cara (C), whom Ash blocked, reports Ash from her read-only conversation; the owner reviews the snapshot
// and suspends Ash; Brock's conversation with Ash reads unavailable and Ash still opens his Collection.
// Brock's and Cara's screens never carry Ash's zip, nor his Handle before they are Friends.
// Ash and Brock are collectors; Brock is the test's page in story one and the owner is the test's page in story two.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import type { Pool } from "pg";
import { expect, test } from "./support/collectors";
import {
  discoverable,
  focusPulse,
  seedZips,
  timeline,
  traderIdOf,
} from "./support/conversations";
import {
  accountId,
  api,
  hold,
  nameCollector,
  ORIGIN,
  seedCatalog,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { seedNearbyZip } from "./support/strangersStory";
import { expectTouchTarget } from "./support/touch-target";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  proposeToTrader,
} from "./support/trades";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const NO_SOURCES = /refresh|poll|updated \d|TCGdex|TCGplayer/i;
const MEET =
  "Meet somewhere public, like a local game store, and check the cards before you swap.";
const UNAVAILABLE = "This collector is no longer available";
const SUSPENDED_NOTE = "Your account can't trade or message right now.";
const A_ZIP = "00010";
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const main = (page: Page) => page.getByRole("main");
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const send = (page: Page) =>
  page.getByRole("button", { name: "Send", exact: true });
const tradesTab = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Trades/ });
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
  ashTrader: string;
  ashHandle: string;
  brock: Page;
  brockTrader: string;
  cara?: Page;
  caraTrader?: string;
};

const handleOf = async (collectors: Collectors, who: Page) =>
  (
    await collectors.pool.query<{ handle: string }>(
      "SELECT handle FROM collector_profile WHERE user_id = $1",
      [await accountId(who)]
    )
  ).rows[0].handle;

/** Ash holds three Arven and wants an Iono; Brock holds an Iono and wants an Arven. Both are named, Ash's page is on
 * Settings. In story one Brock is the test's page (signed in after Ash); in story two Brock and Cara are collectors,
 * Ash has blocked Cara and the owner is the test's page, signed in by the caller. Nobody is in open discovery yet. */
async function world(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  story: 1 | 2
): Promise<World> {
  const ids = seedCatalog();
  const ash = (await collectors.signIn({ next: "/settings", contextOptions }))
    .page;
  await nameCollector(ash, "Ash K");
  await hold(ash, await forTradeLeaf(ash, "Ash Shelf"), ids["SVI 166"], 3);
  await api(ash, "PUT", `/api/trade-wants/${ids["PAL 185"]}`, {
    quantity: "1",
  });
  let brock = page;
  if (story === 1) await signInAsOwner(page, "/settings");
  else brock = (await collectors.signIn({ contextOptions })).page;
  await nameCollector(brock, "Brock T");
  await hold(
    brock,
    await forTradeLeaf(brock, "Brock Binder"),
    ids["PAL 185"],
    1
  );
  await api(brock, "PUT", `/api/trade-wants/${ids["SVI 166"]}`, {
    quantity: "1",
  });
  await seedZips();
  await seedNearbyZip();
  const w: World = {
    ids,
    ash,
    ashTrader: await traderIdOf(ash),
    ashHandle: await handleOf(collectors, ash),
    brock,
    brockTrader: await traderIdOf(brock),
  };
  if (story === 2) {
    w.cara = (await collectors.signIn({ contextOptions })).page;
    await nameCollector(w.cara, "Cara N");
    w.caraTrader = await traderIdOf(w.cara);
  }
  const pages = [ash, brock, ...(w.cara ? [w.cara] : [])];
  for (const on of pages) await noArtwork(on);
  return w;
}

/** Nothing on this screen names Ash's zip or a data source, nor his Handle while `handle` is given. */
async function expectNoLeaks(page: Page, handle?: string) {
  const body = page.locator("body");
  await expect(body).not.toContainText(new RegExp(`\\b${A_ZIP}\\b`));
  await expect(body).not.toContainText(NO_SOURCES);
  if (handle) await expect(body).not.toContainText(handle);
}

/** On Settings, switches open discovery on with `zip`. */
async function switchOn(page: Page, zip: string) {
  const section = page.getByRole("region", { name: "Open discovery" });
  await section.getByLabel("Zip code").fill(zip);
  await section.getByRole("switch", { name: "Open discovery" }).click();
  await expect(
    section.getByRole("switch", { name: "Open discovery" })
  ).toBeChecked();
  await expect(section.getByRole("status")).toHaveText("Open discovery is on.");
}

const dialog = (page: Page, other: string) =>
  page.getByRole("dialog", { name: `Confirm swap with ${other}?` });

/** Confirm swap from the Trade screen, into Unsorted. */
async function confirmSwap(page: Page, other: string) {
  await main(page).getByRole("button", { name: "Confirm swap" }).click();
  await dialog(page, other)
    .getByRole("button", { name: "Confirm swap" })
    .click();
  await expect(dialog(page, other)).toBeHidden();
}

/** On a phone, selects the builder's pane (the other one is out of the accessibility tree). */
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

const tile = (scope: Locator, side: "get" | "give", card: string) =>
  scope.getByRole("button", {
    name: new RegExp(`^Add to You ${side}, ${card}, `),
  });

async function storyOne(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  const w = await world(page, collectors, contextOptions, 1);
  const phone = isPhone(page);
  const { ash } = w;

  // 1. Both switch open discovery on in Settings; Ash then waits on his Collection.
  await switchOn(ash, A_ZIP);
  await switchOn(page, "00013");
  await ash.goto(`${ORIGIN}/collection`);
  await expect(tradesTab(ash)).toHaveAccessibleName("Trades");

  // 2. Brock finds Ash under Near you with his band and record, and no Handle.
  await page.goto(`${ORIGIN}/trades/find`);
  const near = main(page).getByRole("region", {
    name: "Near you",
    exact: true,
  });
  const rows = near
    .getByRole("list", { name: "Matches near you" })
    .locator("> li");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Ash K");
  await expect(rows.first()).toContainText("Under 5 mi · New to trading");
  await expect(rows.first()).not.toContainText("@");
  await expectPageChecks(page, `Near you with Ash's row, ${width}`);
  await expectNoLeaks(page, w.ashHandle);

  // 3. He opens Ash's Trade List and messages him about Ash's Arven: the question waits in the composer.
  await rows.first().getByRole("button", { name: /Ash K/ }).click();
  await rows
    .first()
    .getByRole("link", { name: "See all of Ash K's Trade List" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/trader/${w.ashTrader}`);
  await expect(heading(page)).toHaveText("Ash K's Trade List");
  await expect(
    main(page).getByText("Under 5 mi · New to trading", { exact: true })
  ).toBeVisible();
  const message = main(page).getByRole("button", {
    name: /^Message Ash K about Arven/,
  });
  if (phone) await expectTouchTarget(message);
  await expectPageChecks(page, `Ash's Trade List, ${width}`);
  await message.click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/with/${w.ashTrader}`);
  await expect(composer(page)).toHaveValue(
    /^Is your Arven .* still available\?$/
  );
  await send(page).click();
  await expect(timeline(page).getByRole("listitem")).toHaveCount(1);
  await expect(composer(page)).toHaveValue("");
  await expectNoLeaks(page, w.ashHandle);

  // 4. Ash's Trades badge counts it after focus; he opens it from the list and replies.
  await focusPulse(ash);
  await expect(tradesTab(ash)).toHaveAccessibleName(
    "Trades, 1 unread conversation"
  );
  await tradesTab(ash).click();
  const row = ash
    .getByRole("list", { name: "Conversations" })
    .getByRole("link", { name: /^Brock T/ });
  await expect(row).toContainText("Unread");
  await row.click();
  await expect(heading(ash)).toHaveText("Brock T");
  await composer(ash).fill("Yes, I have three.");
  await send(ash).click();
  await expect(timeline(ash).getByRole("listitem")).toHaveCount(2);
  await expect(tradesTab(ash)).toHaveAccessibleName("Trades");
  await focusPulse(page);
  await expect(timeline(page).getByRole("listitem")).toHaveCount(2);

  // 5. Brock proposes from the conversation.
  const propose = page.getByRole("button", { name: "Propose trade to Ash K" });
  if (phone) await expectTouchTarget(propose);
  await propose.click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${w.ashTrader}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  let tradeId: string;
  if (phone) {
    // The builder's two panes are covered by the Stage 2 trade-strangers spec; here the proposal goes by the API.
    await expectPageChecks(page, "the proposal builder, 375 px");
    tradeId = await proposeToTrader(
      page,
      w.ashTrader,
      [[w.ids["PAL 185"], 1]],
      [[w.ids["SVI 166"], 1]]
    );
  } else {
    await show(page, "Cards");
    await tile(
      page.getByRole("list", { name: "Ash K's Trade List" }),
      "get",
      "Arven, SVI 166, .+?, Normal"
    ).click();
    await page.getByRole("radio", { name: "My Trade List" }).click();
    await tile(
      page.getByRole("list", { name: "Your Trade List" }),
      "give",
      "Iono, PAL 185, .+?, Normal"
    ).click();
    await show(page, "Proposal");
    await page.getByRole("button", { name: "Send Trade Proposal" }).click();
    await expect(page).toHaveURL(
      new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`)
    );
    await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
    tradeId = page.url().split("/").pop()!;
  }

  // 6. Ash accepts and reads the meet-in-public tip.
  await ash.goto(`${ORIGIN}/trades/${tradeId}`);
  await expect(heading(ash)).toHaveText("Brock T sent you a Trade Proposal");
  await main(ash).getByRole("button", { name: "Accept" }).click();
  await expect(heading(ash)).toHaveText("Ready to swap with Brock T");
  await expect(ash.getByText(MEET, { exact: true })).toBeVisible();
  await expectPageChecks(ash, `an accepted stranger Trade, ${width}`);

  // 7. Both confirm; each then sees "1 completed trade" on the other, and Brock is offered Add as Friend.
  await confirmSwap(ash, "Brock T");
  await expect(heading(ash)).toHaveText(
    "Waiting for Brock T to confirm the swap"
  );
  await page.goto(`${ORIGIN}/trades/${tradeId}`);
  await expect(heading(page)).toHaveText("Ash K confirmed the swap");
  await confirmSwap(page, "Ash K");
  await expect(
    page.getByRole("link", { name: /^Conversation with Ash K/ })
  ).toBeVisible();
  await page.goto(`${ORIGIN}/trades/with/${w.ashTrader}`);
  await expect(main(page)).toContainText("Under 5 mi · 1 completed trade");
  await ash.goto(`${ORIGIN}/trades/with/${w.brockTrader}`);
  await expect(main(ash)).toContainText("Under 5 mi · 1 completed trade");

  // 8. Brock adds Ash as a Friend on the Trade; his screens still carry no Handle.
  await page.goto(`${ORIGIN}/trades/${tradeId}`);
  const addFriend = page.getByRole("button", { name: "Add as Friend" });
  await expect(addFriend).toBeVisible();
  if (phone) await expectTouchTarget(addFriend);
  await expectPageChecks(
    page,
    `a swapped Trade offering Add as Friend, ${width}`
  );
  await addFriend.click();
  await expect(page.getByText("Friend Request sent to Ash K.")).toBeVisible();
  await expectNoLeaks(page, w.ashHandle);

  // 9. Ash accepts in the Friends drawer; Brock then sees Ash's Handle.
  await ash.reload();
  await ash
    .getByRole("button", { name: "Friends, 1 request", exact: true })
    .click();
  const drawer = ash.getByRole("dialog", { name: "Friends" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Accept Brock T" }).click();
  await expect(drawer.getByRole("status")).toHaveText(
    "You and Brock T are now Friends."
  );
  await page.goto(`${ORIGIN}/trades/${tradeId}`);
  await expect(page.getByText(`@${w.ashHandle}`)).toBeVisible();
  await expect(addFriend).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(
    new RegExp(`\\b${A_ZIP}\\b`)
  );
}

const reasonLabel = (page: Page, name: string) =>
  page.locator("label").filter({ hasText: new RegExp(`^${name}$`) });

async function storyTwo(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  // Reports other tests of this stack left would count in the tab. Safe: each Playwright worker has its own stack
  // (docs/agents/verification.md).
  await collectors.pool.query("DELETE FROM trade_report");
  const w = await world(page, collectors, contextOptions, 2);
  const phone = isPhone(w.ash);
  const { ash, brock } = w;
  const cara = w.cara!;
  const say = (from: Page, to: string, body: string) =>
    api(from, "POST", `/api/social/traders/${to}/messages`, {
      body,
      idempotency_key: randomUUID(),
    });

  // 1. Ash, Brock and Cara are in reach; Brock and Ash talk; Cara and Ash talk, then Ash blocks Cara.
  await discoverable(ash, A_ZIP);
  await discoverable(brock, "00013");
  await discoverable(cara, "00012");
  await say(brock, w.ashTrader, "Hi Ash, is your Arven available?");
  await say(ash, w.brockTrader, "Yes, it is.");
  await say(cara, w.ashTrader, "Send me your cards first.");
  await say(ash, w.caraTrader!, "No.");
  await api(ash, "POST", `/api/social/traders/${w.caraTrader}/block`, {
    idempotency_key: randomUUID(),
  });

  // 2. Cara opens her read-only conversation and reports Ash from its ⋯ menu.
  await cara.goto(`${ORIGIN}/trades/with/${w.ashTrader}`);
  await expect(cara.getByText(UNAVAILABLE)).toBeVisible();
  await expect(composer(cara)).toHaveCount(0);
  const more = cara.getByRole("button", { name: "More for Ash K" });
  if (phone) await expectTouchTarget(more);
  await more.click();
  await cara.getByRole("menuitem", { name: "Report" }).click();
  await expect(cara.getByText("Report Ash K?", { exact: true })).toBeVisible();
  await expectPageChecks(cara, `Cara's Report form, ${width}`);
  await reasonLabel(cara, "Scam or no-show").click();
  await cara
    .getByRole("textbox", { name: "Add a note (optional)" })
    .fill("Asked me to send cards first");
  const submit = cara.getByRole("button", { name: "Report", exact: true });
  if (phone) await expectTouchTarget(submit);
  await submit.click();
  await expect(
    cara.getByRole("status").filter({ hasText: "Reported Ash K." })
  ).toHaveText("Reported Ash K. They're blocked and aren't told.");
  await expectNoLeaks(cara, w.ashHandle);

  // 3. The owner reviews the snapshot in Trade reports and suspends Ash. The owner's table is read at desktop width.
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInAsOwner(page, "/collection");
  await collectors.pool.query(
    'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
    [OWNER_EMAIL]
  );
  await page.goto(`${ORIGIN}/owner/trade-reports`);
  const table = page.getByRole("region", { name: "Trade reports table" });
  const report = table.getByRole("row").filter({ hasText: "Ash K" });
  await expect(report).toHaveCount(1);
  await expect(report).toContainText("Scam or no-show");
  await report.getByRole("button", { name: "Review report on Ash K" }).click();
  await expect(
    page.getByText("Report on Ash K", { exact: true })
  ).toBeVisible();
  await expect(table).toContainText("Send me your cards first.");
  await expect(table).toContainText("Asked me to send cards first");
  // Only the snapshot: Brock's conversation with Ash is not in it.
  await expect(table).not.toContainText("is your Arven available");
  await expectPageChecks(page, "a Trade report's review, 1280");
  await page.getByRole("button", { name: "Suspend account" }).click();
  await expect(toast(page)).toContainText("Account suspended.");

  // 4. Brock's conversation with Ash reads unavailable, with no zip or Handle; Ash still opens his Collection.
  await brock.goto(`${ORIGIN}/trades/with/${w.ashTrader}`);
  await expect(brock.getByText(UNAVAILABLE)).toBeVisible();
  await expect(composer(brock)).toHaveCount(0);
  await expectPageChecks(brock, `Brock's unavailable conversation, ${width}`);
  await expectNoLeaks(brock, w.ashHandle);
  await ash.goto(`${ORIGIN}/trades`);
  await expect(ash.getByText(SUSPENDED_NOTE, { exact: true })).toBeVisible();
  await ash.goto(`${ORIGIN}/collection`);
  await expect(ash).toHaveURL(`${ORIGIN}/collection`);
  await expect(main(ash).getByText("Ash Shelf").first()).toBeVisible();
  await expectPageChecks(ash, `Ash's Collection while suspended, ${width}`);
}

test.describe("desktop, Trading Stage 2 stories", () => {
  test.use(DESKTOP_SIZE);

  test("strangers find each other, talk, trade and become Friends", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await storyOne(page, collectors, DESKTOP_SIZE, "desktop width");
  });

  test("a blocked collector reports, the owner suspends, and the suspended collector keeps their Collection", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await storyTwo(page, collectors, DESKTOP_SIZE, "desktop width");
  });
});

test.describe("phone, Trading Stage 2 stories", () => {
  test.use(PHONE_SIZE);

  test("strangers find each other, talk, trade and become Friends at 375 px", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await storyOne(page, collectors, PHONE_SIZE, "375 px");
  });

  test("a blocked collector reports, the owner suspends, and the suspended collector keeps their Collection at 375 px", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await storyTwo(page, collectors, PHONE_SIZE, "375 px");
  });
});
