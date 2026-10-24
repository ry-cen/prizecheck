// Ticket #302 (Trading Stage 2, "Block for strangers"): Misty (zip 00010) and Ash (00011) are strangers in reach. Ash
// blocks Misty from their conversation's ⋯ menu; the question counts the Trade Proposals it would cancel, both sides
// go read-only (Misty's open page turns on the pulse, with no reload and no mention of a Block), Settings › Privacy
// unblocks, and the conversation reopens. Ash is the test's page, Misty signs in first.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import type { Pool } from "pg";
import { expect, test } from "./support/collectors";
import {
  discoverable,
  focusPulse,
  seedZips,
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
import { expectTouchTarget } from "./support/touch-target";
import { DESKTOP_SIZE, PHONE_SIZE, forTradeLeaf } from "./support/trades";

const NO_SOURCES = /refresh|poll|updated \d|TCGdex|TCGplayer/i;
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

const MORE = "More for Misty W";

/** Ash opens the conversation with Misty and chooses Block from its ⋯ menu; returns the confirming button. */
async function askToBlock(page: Page, s: Strangers) {
  await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
  await page.getByRole("button", { name: MORE }).click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  return page.getByRole("button", { name: "Block", exact: true });
}

async function blockStory(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  phone: boolean
) {
  const s = await strangers(page, collectors, contextOptions);
  const { misty } = s;

  // 1. Ash says hello by trader id; Misty opens the conversation and can write back.
  await api(page, "POST", `/api/social/traders/${s.mistyTrader}/messages`, {
    body: "Hi Misty",
    idempotency_key: randomUUID(),
  });
  if (!phone) {
    await misty.goto(`${ORIGIN}/trades/with/${s.ashTrader}`);
    await expect(misty.getByRole("textbox", { name: "Message" })).toBeVisible();
  }

  // 2. Ash opens the conversation, chooses Block from the ⋯ menu and is asked first.
  await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
  await expectPageChecks(page, "a stranger's conversation with a ⋯ menu");
  const more = page.getByRole("button", { name: MORE });
  if (phone) await expectTouchTarget(more);
  await more.click();
  await page.getByRole("menuitem", { name: "Block" }).click();
  await expect(
    page.getByText("Block Misty W? They won't be told.", { exact: true })
  ).toBeVisible();
  const confirm = page.getByRole("button", { name: "Block", exact: true });
  await expect(confirm).toBeFocused();
  if (phone) await expectTouchTarget(confirm);

  // 3. Confirming blocks: Ash's conversation is read-only.
  await confirm.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Blocked Misty W." })
  ).toHaveText("Blocked Misty W. They aren't told.");
  await expect(
    page.getByRole("link", { name: "You blocked Misty W." })
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Propose trade to Misty W" })
  ).toHaveCount(0);
  // The ⋯ menu stays, offering Report (#303) alone.
  await expect(page.getByRole("button", { name: MORE })).toBeVisible();
  await page.getByRole("button", { name: MORE }).click();
  await expect(page.getByRole("menuitem")).toHaveText(["Report"]);
  await page.keyboard.press("Escape");
  if (phone) return;

  // 4. Misty's open page turns read-only on the pulse, with no reload and no word about a Block.
  await focusPulse(misty);
  await expect(
    misty.getByText("This collector is no longer available")
  ).toBeVisible();
  await expect(misty.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  const mistyText = await misty.locator("body").innerText();
  expect(mistyText).not.toMatch(/block/i);

  // 5. Ash follows the link to Settings, where the Block is listed by name alone, and lifts it there.
  await page.getByRole("link", { name: "You blocked Misty W." }).click();
  await expect(page).toHaveURL(`${ORIGIN}/settings`);
  const blocked = page.getByRole("region", { name: "Blocked collectors" });
  const row = blocked.getByRole("listitem").filter({ hasText: "Misty W" });
  await expect(row).toHaveCount(1);
  await expect(row).not.toContainText("@");
  await expectNoLeaks(page, s);
  await blocked.getByRole("button", { name: "Unblock Misty W" }).click();
  await expect(blocked.getByRole("status")).toHaveText("Unblocked Misty W.");
  await expect(blocked).toContainText("You haven't blocked anyone.");

  // 6. The conversation reopens for both.
  await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await expectNoLeaks(page, s);
  await focusPulse(misty);
  await expect(misty.getByRole("textbox", { name: "Message" })).toBeVisible();
}

test.describe("desktop, Block for strangers", () => {
  test.use(DESKTOP_SIZE);

  test("Block from a conversation turns it read-only for both, and Settings unblocks it", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await blockStory(page, collectors, DESKTOP_SIZE, false);
  });

  test("Block's question counts the Trade Proposal it would cancel, and Cancel changes nothing", async ({
    page,
    collectors,
  }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    const sent = await api(page, "POST", "/api/trades", {
      recipient_trader_id: s.mistyTrader,
      you_give: [{ edition_id: s.ids["SVI 166"], quantity: "1" }],
      you_get: [{ edition_id: s.ids["PAL 185"], quantity: "1" }],
      idempotency_key: randomUUID(),
    });
    const read = () => api(page, "GET", `/api/social/trades/${sent.id}`);

    const confirm = await askToBlock(page, s);
    await expect(
      page.getByText(
        "Block Misty W? They won't be told. This cancels 1 Trade Proposal.",
        { exact: true }
      )
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByRole("button", { name: MORE })).toBeFocused();
    expect((await read()).state).toBe("proposed");

    await page.getByRole("button", { name: MORE }).click();
    await page.getByRole("menuitem", { name: "Block" }).click();
    await confirm.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Blocked Misty W." })
    ).toHaveText("Blocked Misty W. They aren't told.");
    await expect
      .poll(async () => (await read()).closed_reason)
      .toBe("cancelled");
    expect((await read()).state).toBe("closed");
  });
});

test.describe("phone, Block for strangers", () => {
  test.use(PHONE_SIZE);

  test("the ⋯ menu and the confirmation are touch-sized and Block reads the same at 375 px", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await blockStory(page, collectors, PHONE_SIZE, true);
  });
});
