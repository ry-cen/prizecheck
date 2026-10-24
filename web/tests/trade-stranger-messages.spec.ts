// Ticket #301 (Trading Stage 2, "Messaging strangers"): Ash opens Misty's Trade List (a stranger in open discovery) and
// presses Message on her Iono. The conversation opens with "Is your Iono (PAL 185) still available?" in the composer and
// no draft left in the address. At the daily limit (10 new conversations in 24 hours) Send keeps the draft and shows the
// refusal sentence; once the count is gone Send goes through and the composer empties for good. Then Misty proposes, Ash
// accepts, and his Trade screen shows the meet-in-public tip until they are Friends. A phone run covers the Message
// button's touch size. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py). Ash is the test's page,
// Misty signs in first.
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import type { Pool } from "pg";
import { expect, test } from "./support/collectors";
import {
  discoverable,
  seedZips,
  timeline,
  traderIdOf,
} from "./support/conversations";
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
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  tradeStep,
} from "./support/trades";

const NO_SOURCES = /refresh|poll|updated \d|TCGdex|TCGplayer/i;
const QUESTION = "Is your Iono (PAL 185) still available?";
const LIMIT =
  "You've started 10 new conversations in the last 24 hours. Try again in 1 hour.";
const MEET =
  "Meet somewhere public, like a local game store, and check the cards before you swap.";
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

type Collectors = {
  signIn: (options?: {
    next?: string;
    contextOptions?: BrowserContextOptions;
  }) => Promise<{ page: Page }>;
  pool: Pool;
};

type Strangers = {
  ids: Record<string, string>;
  misty: Page;
  mistyHandle: string;
  mistyTrader: string;
  ash: Page;
  ashTrader: string;
};

/** Misty and Ash, not Friends, both in open discovery: Misty at 00010 holding an Iono, Ash (the test's page) at 00011
 * holding three Arven. */
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
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await forTradeLeaf(page, "Ash Shelf"), ids["SVI 166"], 3);
  await seedZips();
  await discoverable(misty, "00010");
  await discoverable(page, "00011");
  for (const on of [page, misty]) await noArtwork(on);
  const mistyHandle = (
    await collectors.pool.query<{ handle: string }>(
      "SELECT handle FROM collector_profile WHERE user_id = $1",
      [await accountId(misty)]
    )
  ).rows[0].handle;
  return {
    ids,
    misty,
    mistyHandle,
    mistyTrader: await traderIdOf(misty),
    ash: page,
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

/** Opens Misty's Trade List and presses Message on her Iono; the conversation opens with the question in the composer. */
async function messageOnCard(page: Page, s: Strangers, phone: boolean) {
  await page.goto(`${ORIGIN}/trades/trader/${s.mistyTrader}`);
  await expect(heading(page)).toHaveText("Misty W's Trade List");
  const message = page
    .getByRole("main")
    .getByRole("button", { name: "Message Misty W about Iono (PAL 185)" });
  await expect(message).toBeVisible();
  if (phone) await expectTouchTarget(message);
  await expectPageChecks(
    page,
    `a stranger's Trade List with Message at ${phone ? "375 px" : "desktop width"}`
  );
  await message.click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/with/${s.mistyTrader}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(
    QUESTION
  );
  await expectPageChecks(
    page,
    `the prefilled conversation at ${phone ? "375 px" : "desktop width"}`
  );
  await expectNoLeaks(page, s);
}

test.describe("desktop, messaging strangers", () => {
  test.use(DESKTOP_SIZE);

  test("Message on a stranger's card prefills the composer, the daily limit keeps the draft, and an accepted stranger Trade shows the meetup tip", async ({
    page,
    collectors,
  }) => {
    test.slow();
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    const ash = await accountId(page);
    await messageOnCard(page, s, false);
    const composer = page.getByRole("textbox", { name: "Message" });

    // The limit refuses the first message, names the wait and keeps the draft.
    await collectors.pool.query(
      `INSERT INTO handle_lookup_event(user_id, kind, created_at)
       SELECT $1, 'new_conversation', now() - interval '23 hours' FROM generate_series(1, 10)`,
      [ash]
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: LIMIT })
    ).toBeVisible();
    await expect(composer).toHaveValue(QUESTION);

    // Without the count, Send goes through and the composer empties, also after a reload.
    await collectors.pool.query(
      "DELETE FROM handle_lookup_event WHERE user_id = $1 AND kind = 'new_conversation'",
      [ash]
    );
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(timeline(page)).toContainText(QUESTION);
    await expect(composer).toHaveValue("");
    await page.reload();
    await expect(timeline(page)).toContainText(QUESTION);
    await expect(composer).toHaveValue("");

    // Misty proposes, Ash accepts: a stranger's accepted Trade carries the meetup tip.
    const sent = await api(s.misty, "POST", "/api/trades", {
      recipient_trader_id: s.ashTrader,
      you_give: [{ edition_id: s.ids["PAL 185"], quantity: "1" }],
      you_get: [],
      idempotency_key: randomUUID(),
    });
    await tradeStep(page, sent.id, "accept");
    await page.goto(`${ORIGIN}/trades/${sent.id}`);
    const tip = page.getByText(MEET, { exact: true });
    await expect(tip).toBeVisible();
    await expectNoLeaks(page, s);
    await expectPageChecks(page, "an accepted stranger Trade");

    // Friends meet as they like: the tip goes.
    await befriend(page, s.misty);
    await page.goto(`${ORIGIN}/trades/${sent.id}`);
    // The Handle shows only once the Friend state has loaded; "Trade" alone also heads the loading screen.
    await expect(page.getByText(`@${s.mistyHandle}`)).toBeVisible();
    await expect(tip).toHaveCount(0);
  });
});

test.describe("phone, messaging strangers", () => {
  test.use(PHONE_SIZE);

  test("Message on a card at 375 px", async ({ page, collectors }) => {
    test.slow();
    const s = await strangers(page, collectors, PHONE_SIZE);
    await messageOnCard(page, s, true);
  });
});
