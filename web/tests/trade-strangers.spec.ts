// Ticket #299 (Trading Stage 2, "The reach rule and stranger Trades"): two collectors who are not Friends trade because
// both are in open discovery within 50 miles. Misty (zip 00010) holds an Iono for trade and wants an Arven; Ash (00011,
// about 7 miles away) holds Arven for trade. Ash opens Misty's Trade List by her trader id (a band and "New to trading"
// under her name, and his Arven under "You give"), proposes from it, and Misty Counters; neither Trade screen shows a
// Handle. Further tests: a Friend's Handle address replaces itself with the trader id, a closed Trade whose conversation
// is gone still opens, a stranger's Trade List reads unavailable once she blocks Ash, and the same zip reads
// "Under 5 mi". The first story also runs at 375 px. Ash is the test's page, Misty signs in first.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
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
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
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

type Strangers = {
  ids: Record<string, string>;
  misty: Page;
  mistyHandle: string;
  mistyTrader: string;
  ash: Page;
  ashHandle: string;
  ashTrader: string;
};

/** Misty and Ash, not Friends, both in open discovery: Misty at 00010 holding an Iono and wanting an Arven, Ash (the
 * test's page) at 00011 holding three Arven. */
async function strangers(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions
): Promise<Strangers> {
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
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await forTradeLeaf(page, "Ash Shelf"), ids["SVI 166"], 3);
  await seedZips();
  await discoverable(misty, "00010");
  await discoverable(page, "00011");
  for (const on of [page, misty]) await noArtwork(on);
  const handleOf = async (who: Page) =>
    (
      await collectors.pool.query<{ handle: string }>(
        "SELECT handle FROM collector_profile WHERE user_id = $1",
        [await accountId(who)]
      )
    ).rows[0].handle;
  return {
    ids,
    misty,
    mistyHandle: await handleOf(misty),
    mistyTrader: await traderIdOf(misty),
    ash: page,
    ashHandle: await handleOf(page),
    ashTrader: await traderIdOf(page),
  };
}

/** Nothing on Ash's screen names Misty's Handle, a zip code or a data source. */
async function expectNoLeaks(page: Page, s: Strangers) {
  const text = (await page.locator("body").innerText()) ?? "";
  expect(text).not.toContain(s.mistyHandle);
  expect(text).not.toMatch(/\b0001[01]\b/);
  expect(text).not.toMatch(NO_SOURCES);
}

async function story(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  width: string
) {
  const s = await strangers(page, collectors, contextOptions);
  const { misty } = s;

  // 1. Ash opens Misty's Trade List by her trader id: her band and record, her Iono, and his Arven she wants.
  await page.goto(`${ORIGIN}/trades/trader/${s.mistyTrader}`);
  await expect(heading(page)).toHaveText("Misty W's Trade List");
  const main = page.getByRole("main");
  await expect(
    main.getByText("5–10 mi · New to trading", { exact: true })
  ).toBeVisible();
  await expect(main).toContainText("Iono");
  await expect(
    main.getByRole("heading", { name: "You give", level: 2 })
  ).toBeVisible();
  await expect(
    main.getByRole("list", { name: "You give Misty W" })
  ).toContainText("Arven");
  await expectPageChecks(page, `a stranger's Trade List at ${width}`);
  await expectNoLeaks(page, s);
  const propose = main.getByRole("button", {
    name: "Propose trade to Misty W",
  });
  if (isPhone(page)) await expectTouchTarget(propose);

  // 2. Propose trade opens the builder by her trader id; Ash adds her Iono and his Arven and sends.
  await propose.click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/new/${s.mistyTrader}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Misty W");
  await expectPageChecks(
    page,
    `the proposal builder for a stranger at ${width}`
  );
  if (isPhone(page)) return;
  await show(page, "Cards");
  await tile(
    page.getByRole("list", { name: "Misty W's Trade List" }),
    "get",
    "Iono, PAL 185, .+?, Normal"
  ).click();
  await page.getByRole("radio", { name: "My Trade List" }).click();
  await tile(
    page.getByRole("list", { name: "Your Trade List" }),
    "give",
    "Arven, SVI 166, .+?, Normal"
  ).click();
  await show(page, "Proposal");
  await page.getByRole("button", { name: "Send Trade Proposal" }).click();
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`));
  await expect(heading(page)).toHaveText("Waiting for Misty W to answer");
  await expect(toast(page)).toContainText("Trade Proposal sent to Misty W");
  await expect(page.getByRole("main")).not.toContainText("@");
  await expectNoLeaks(page, s);
  const proposal = page.url();

  // 3. Misty opens it and chooses Counter; the builder names the proposal in its back link; she asks for more Arven.
  await misty.goto(proposal);
  await expect(heading(misty)).toHaveText("Ash K sent you a Trade Proposal");
  await expect(misty.getByRole("main")).not.toContainText("@");
  await misty
    .getByRole("main")
    .getByRole("button", { name: "Counter", exact: true })
    .click();
  await expect(heading(misty)).toHaveText("Counter to Ash K");
  await expect(
    misty.getByRole("link", { name: "Ash K's Trade Proposal" })
  ).toBeVisible();
  await expectPageChecks(
    misty,
    `the Counter builder for a stranger at ${width}`
  );
  await tile(
    misty.getByRole("list", { name: "Ash K's Trade List" }),
    "get",
    "Arven, SVI 166, .+?, Normal"
  ).click();
  await show(misty, "Proposal");
  await misty.getByRole("button", { name: "Send Counter" }).click();
  await expect(toast(misty)).toContainText("Counter sent to Ash K");
  await expect(heading(misty)).toHaveText("Waiting for Ash K to answer");
  await expect(misty.getByRole("main")).not.toContainText("@");

  // 4. Ash sees the Counter, still without a Handle on either side.
  await page.goto(`${ORIGIN}/trades`);
  await page
    .getByRole("list", { name: "Conversations" })
    .getByRole("link", { name: /^Misty W/ })
    .click();
  await page
    .getByRole("list", { name: "Messages and Trades" })
    .getByRole("link", { name: /countered/i })
    .last() // the timeline runs oldest first: the Counter is the newest card
    .click();
  await expect(heading(page)).toHaveText(
    "Misty W countered your Trade Proposal"
  );
  await expect(page.getByRole("main")).not.toContainText("@");
  await expectNoLeaks(page, s);
}

test.describe("desktop, stranger Trades", () => {
  test.use(DESKTOP_SIZE);

  test("a nearby stranger's Trade List, a proposal by trader id and a Counter", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await story(page, collectors, DESKTOP_SIZE, "desktop width");
  });

  test("the Handle address of a Friend's builder replaces itself with the trader id", async ({
    page,
    collectors,
  }) => {
    const misty = (await collectors.signIn({})).page;
    await nameCollector(misty, "Misty W");
    await signInAsOwner(page, "/collection");
    await nameCollector(page, "Ash K");
    await befriend(page, misty);
    const handle = (
      await collectors.pool.query<{ handle: string }>(
        "SELECT handle FROM collector_profile WHERE user_id = $1",
        [await accountId(misty)]
      )
    ).rows[0].handle;
    const mistyTrader = await traderIdOf(misty);
    await page.goto(`${ORIGIN}/collection`);
    await page.goto(`${ORIGIN}/trades/new/${handle}`);
    await expect(page).toHaveURL(`${ORIGIN}/trades/new/${mistyTrader}`);
    await expect(heading(page)).toHaveText("Trade Proposal to Misty W");
    await expectPageChecks(page, "the builder reached by a Handle address");
    await page.goBack();
    await expect(page).not.toHaveURL(`${ORIGIN}/trades/new/${handle}`);
    await expect(page).toHaveURL(`${ORIGIN}/collection`);
  });

  test("a closed Trade whose conversation is gone still opens", async ({
    page,
    collectors,
  }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    const sent = await api(page, "POST", "/api/trades", {
      recipient_trader_id: s.mistyTrader,
      you_give: [{ edition_id: s.ids["SVI 166"], quantity: "1" }],
      you_get: [],
      idempotency_key: randomUUID(),
    });
    const trade = await api(page, "GET", `/api/social/trades/${sent.id}`);
    await api(page, "POST", `/api/social/trades/${sent.id}/withdraw`, {
      revision: trade.revision,
      idempotency_key: randomUUID(),
    });
    await collectors.pool.query(
      "DELETE FROM conversation WHERE id = (SELECT conversation_id FROM trade WHERE id = $1)",
      [sent.id]
    );
    await page.goto(`${ORIGIN}/trades/${sent.id}`);
    await expect(page.getByRole("main")).toContainText("Misty W");
    await expect(
      page.getByRole("link", { name: /^Conversation with / })
    ).toHaveCount(0);
    await expectPageChecks(page, "a closed Trade with no conversation");
    await expectNoLeaks(page, s);
  });

  test("a stranger's Trade List reads unavailable once they block you", async ({
    page,
    collectors,
  }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    await page.goto(`${ORIGIN}/trades/trader/${s.mistyTrader}`);
    await expect(heading(page)).toHaveText("Misty W's Trade List");
    await api(s.misty, "POST", "/api/social/blocks", {
      collector_id: await accountId(page),
      idempotency_key: randomUUID(),
    });
    await page.reload();
    await expect(heading(page)).toHaveText("Trade List");
    await expect(page.getByRole("main")).toContainText(
      "This collector is no longer available"
    );
    await expectPageChecks(page, "an unavailable stranger's Trade List");
    await expectNoLeaks(page, s);
  });

  test("the same zip reads Under 5 mi", async ({ page, collectors }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    await discoverable(page, "00010");
    await page.goto(`${ORIGIN}/trades/trader/${s.mistyTrader}`);
    await expect(heading(page)).toHaveText("Misty W's Trade List");
    await expect(
      page
        .getByRole("main")
        .getByText("Under 5 mi · New to trading", { exact: true })
    ).toBeVisible();
    await expectNoLeaks(page, s);
  });
});

test.describe("phone, stranger Trades", () => {
  test.use(PHONE_SIZE);

  test("the same first two screens at 375 px, with no sideways scroll and a touch-sized Propose trade", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await story(page, collectors, PHONE_SIZE, "375 px");
  });
});
