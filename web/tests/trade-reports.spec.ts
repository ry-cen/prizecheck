// Ticket #303 (Trading Stage 2, "Reports and the owner review queue"): Misty (zip 00010) and Ash (00011) are strangers in
// reach. Ash Reports Misty from their conversation, from a Near you row or from a Trade; a Report Blocks her and she is
// told nothing. The owner reviews the snapshot in Owner controls' Trade reports, suspends Misty, and lifts the suspension.
// Ash is the test's page and Misty signs in first, except in the owner's test, where both sign in through `collectors`
// and the test's page signs in last as the owner.
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
  befriend,
  hold,
  loanStep,
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
  proposeToTrader,
} from "./support/trades";

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const NO_SOURCES = /refresh|poll|updated \d|TCGdex|TCGplayer/i;
const SUSPENDED_NOTE = "Your account can't trade or message right now.";
const REPORTED = "Reported Misty W. They're blocked and aren't told.";
const MORE = "More for Misty W";
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
  mistyTrader: string;
  ash: Page;
  ashTrader: string;
};

/** Misty and Ash, not Friends, both in open discovery: Misty at 00010 holding an Iono and wanting an Arven, Ash at 00011
 * holding three Arven. Ash is the test's page unless `ashAs` signs him in as another collector. */
async function strangers(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  ashAs: "page" | "collector" = "page"
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
  let ash = page;
  if (ashAs === "collector")
    ash = (await collectors.signIn({ contextOptions })).page;
  else await signInAsOwner(page, "/collection");
  await nameCollector(ash, "Ash K");
  await hold(ash, await forTradeLeaf(ash, "Ash Shelf"), ids["SVI 166"], 3);
  await seedZips();
  await discoverable(misty, "00010");
  await discoverable(ash, "00011");
  for (const on of [ash, misty]) await noArtwork(on);
  return {
    ids,
    misty,
    mistyTrader: await traderIdOf(misty),
    ash,
    ashTrader: await traderIdOf(ash),
  };
}

/** Nothing on Ash's screen names a zip code or a data source. */
async function expectNoLeaks(page: Page) {
  const text = (await page.locator("body").innerText()) ?? "";
  expect(text).not.toMatch(/\b0001[01]\b/);
  expect(text).not.toMatch(NO_SOURCES);
}

const say = (from: Page, to: string, body: string) =>
  api(from, "POST", `/api/social/traders/${to}/messages`, {
    body,
    idempotency_key: randomUUID(),
  });

const reasonLabel = (page: Page, name: string) =>
  page.locator("label").filter({ hasText: new RegExp(`^${name}$`) });

/** The form opened from a ⋯ menu: chooses `reason`, optionally types a note, and returns the Report button. */
async function fillReport(page: Page, reason: string, note?: string) {
  await reasonLabel(page, reason).click();
  if (note !== undefined)
    await page
      .getByRole("textbox", { name: "Add a note (optional)" })
      .fill(note);
  return page.getByRole("button", { name: "Report", exact: true });
}

/** Ash reports Misty from their conversation and sees her Blocked; Misty hears nothing. */
async function conversationStory(
  page: Page,
  collectors: Collectors,
  contextOptions: BrowserContextOptions,
  phone: boolean
) {
  const s = await strangers(page, collectors, contextOptions);
  const { misty } = s;

  // 1. Ash and Misty exchange hellos; Misty keeps the conversation open.
  await say(page, s.mistyTrader, "Hi Misty");
  await say(misty, s.ashTrader, "Hi Ash");
  if (!phone) {
    await misty.goto(`${ORIGIN}/trades/with/${s.ashTrader}`);
    await expect(misty.getByRole("textbox", { name: "Message" })).toBeVisible();
  }

  // 2. Report is in the ⋯ menu; the form asks about Misty and focuses its first reason.
  await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
  const more = page.getByRole("button", { name: MORE });
  if (phone) await expectTouchTarget(more);
  await more.click();
  await page.getByRole("menuitem", { name: "Report" }).click();
  await expect(
    page.getByText("Report Misty W?", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Scam or no-show" })
  ).toBeFocused();
  await expectPageChecks(
    page,
    `a conversation's Report form, ${phone ? "375" : "1280"}`
  );

  // 3. Harassment with a note: Misty is Blocked, and Report stays offered.
  const submit = await fillReport(page, "Harassment", "Kept pestering me");
  if (phone) {
    await expectTouchTarget(submit);
    for (const name of [
      "Scam or no-show",
      "Harassment",
      "Inappropriate content",
      "Other",
    ])
      await expectTouchTarget(reasonLabel(page, name));
  }
  await submit.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Reported Misty W." })
  ).toHaveText(REPORTED);
  await expect(
    page.getByRole("link", { name: "You blocked Misty W." })
  ).toBeVisible();
  // The form is gone, so the conversation's heading takes focus.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
  await expect(more).toBeVisible();
  await more.click();
  await expect(page.getByRole("menuitem")).toHaveText(["Report"]);
  await page.keyboard.press("Escape");
  if (phone) return;

  // 4. Misty's open page turns read-only on the pulse, with no reload and no word about a Report or a Block.
  await focusPulse(misty);
  await expect(
    misty.getByText("This collector is no longer available")
  ).toBeVisible();
  const mistyText = await misty.locator("body").innerText();
  expect(mistyText).not.toMatch(/report/i);
  expect(mistyText).not.toMatch(/block/i);

  // 5. Ash's screen leaks nothing.
  await expectNoLeaks(page);
}

test.describe("desktop, Report", () => {
  test.use(DESKTOP_SIZE);

  test("Report from a conversation blocks, keeps Report offered, and tells Misty nothing", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await conversationStory(page, collectors, DESKTOP_SIZE, false);
  });

  test("Report from a Near you row removes the row and says so", async ({
    page,
    collectors,
  }) => {
    await strangers(page, collectors, DESKTOP_SIZE);
    await page.goto(`${ORIGIN}/trades/find`);
    const near = page
      .getByRole("main")
      .getByRole("region", { name: "Near you", exact: true });
    const rows = near
      .getByRole("list", { name: "Matches near you" })
      .locator("> li");
    await expect(rows).toHaveCount(1);
    const row = rows.first();
    await row.getByRole("button", { name: /Misty W/ }).click();
    await row.getByRole("button", { name: MORE }).click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    await expect(
      row.getByText("Report Misty W?", { exact: true })
    ).toBeVisible();
    const submit = await fillReport(page, "Scam or no-show");
    await submit.click();
    await expect(rows).toHaveCount(0);
    await expect(
      near.getByRole("status").filter({ hasText: "Reported Misty W." })
    ).toHaveText(REPORTED);
    await expectNoLeaks(page);
  });

  test("Report's Cancel closes the form and returns focus to the ⋯ menu", async ({
    page,
    collectors,
  }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
    const more = page.getByRole("button", { name: MORE });
    await more.click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    await expect(
      page.getByText("Report Misty W?", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Report Misty W?")).toHaveCount(0);
    await expect(more).toBeFocused();
  });

  test("A failed Report keeps the form, shows the alert and refocuses Report", async ({
    page,
    collectors,
  }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
    await page.getByRole("button", { name: MORE }).click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    const submit = await fillReport(page, "Other");
    await page.route("**/api/social/reports", (route) =>
      route.fulfill({ status: 500, json: { detail: "boom" } })
    );
    await submit.click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(submit).toBeFocused();
    await expect(
      page.getByText("Report Misty W?", { exact: true })
    ).toBeVisible();
  });

  test("Reporting a Friend shows what the Block would end, as Block does", async ({
    page,
    collectors,
  }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    await befriend(page, s.misty);
    const mistyId = await accountId(s.misty);
    // A Trade Proposal waiting, and a Loan Misty accepted that nobody has handed over.
    await proposeToTrader(
      page,
      s.mistyTrader,
      [[s.ids["SVI 166"], 1]],
      [[s.ids["PAL 185"], 1]]
    );
    const loan = (
      await api(page, "POST", "/api/loans", {
        lender_id: mistyId,
        lines: [{ edition_id: s.ids["PAL 185"], quantity: "1" }],
        deck_id: null,
        idempotency_key: randomUUID(),
      })
    ).id as string;
    await loanStep(s.misty, loan, `/api/loans/${loan}/accept`, {
      lines: [{ edition_id: s.ids["PAL 185"], promised: "1" }],
    });
    await page.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
    await page.getByRole("button", { name: MORE }).click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    await expect(
      page.getByText("Report Misty W?", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: /Report Misty W/ })
    ).toContainText(
      "This cancels 1 open Loan that hasn't been handed over and 1 Trade Proposal."
    );
  });

  test("Report from a Trade cancels it", async ({ page, collectors }) => {
    const s = await strangers(page, collectors, DESKTOP_SIZE);
    const trade = await proposeToTrader(
      page,
      s.mistyTrader,
      [[s.ids["SVI 166"], 1]],
      [[s.ids["PAL 185"], 1]]
    );
    await page.goto(`${ORIGIN}/trades/${trade}`);
    await page.getByRole("button", { name: "More for this Trade" }).click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    await expect(
      page.getByText("Report Misty W?", { exact: true })
    ).toBeVisible();
    const submit = await fillReport(page, "Other");
    await submit.click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      /cancelled this Trade/
    );
    // The form is gone, so the heading takes focus once the Trade is read again.
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(
      page.getByRole("button", { name: "More for this Trade" })
    ).toBeVisible();
  });

  test("The owner reviews the snapshot, suspends, and lifts the suspension", async ({
    page,
    collectors,
  }) => {
    test.slow();
    // Reports other tests of this stack left would count in the tab. Safe: each Playwright worker has its own stack
    // (docs/agents/verification.md:47).
    await collectors.pool.query("DELETE FROM trade_report");
    const s = await strangers(page, collectors, DESKTOP_SIZE, "collector");

    // 1. Two messages, then Ash Reports Misty through the API; the test's page then signs in as the owner.
    await say(s.ash, s.mistyTrader, "Hi Misty");
    await say(s.misty, s.ashTrader, "Hi Ash");
    await api(s.ash, "POST", "/api/social/reports", {
      trader_id: s.mistyTrader,
      reason: "harassment",
      note: "Kept pestering me",
      source: "conversation",
      idempotency_key: randomUUID(),
    });
    await signInAsOwner(page, "/collection");
    await collectors.pool.query(
      'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
      [OWNER_EMAIL]
    );

    // 2. The tab counts the open report and the queue lists it.
    await page.goto(`${ORIGIN}/owner`);
    const tab = page
      .getByRole("tablist", { name: "Owner controls sections" })
      .getByRole("tab", { name: /^Trade reports/ });
    await expect(tab).toHaveAccessibleName("Trade reports 1");
    await page.goto(`${ORIGIN}/owner/trade-reports`);
    const table = page.getByRole("region", { name: "Trade reports table" });
    const row = table.getByRole("row").filter({ hasText: "Misty W" });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Harassment");
    await expect(row).toContainText("Conversation");

    // 3. Review shows the snapshot; Suspend account decides it.
    await row.getByRole("button", { name: "Review report on Misty W" }).click();
    const review = page.getByText("Report on Misty W", { exact: true });
    await expect(review).toBeVisible();
    await expect(table).toContainText("Hi Misty");
    await expect(table).toContainText("Hi Ash");
    await expect(
      page.getByRole("textbox", { name: "Note (optional)" })
    ).toBeFocused();
    await expectPageChecks(page, "a Trade report's review, 1280");
    await page.getByRole("button", { name: "Suspend account" }).click();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Account suspended.");
    await expect(tab).toHaveAccessibleName("Trade reports 0");

    // 4. Misty reads the note where she would trade; Ash, who unblocks first, finds her unavailable.
    await s.misty.goto(`${ORIGIN}/trades`);
    await expect(
      s.misty.getByText(SUSPENDED_NOTE, { exact: true })
    ).toBeVisible();
    await s.misty.goto(`${ORIGIN}/settings`);
    await expect(
      s.misty.getByText(SUSPENDED_NOTE, { exact: true })
    ).toBeVisible();
    await api(s.ash, "POST", `/api/social/traders/${s.mistyTrader}/unblock`, {
      idempotency_key: randomUUID(),
    });
    await s.ash.goto(`${ORIGIN}/trades/with/${s.mistyTrader}`);
    await expect(
      s.ash.getByText("This collector is no longer available")
    ).toBeVisible();

    // 5. The owner finds the decided report under Actioned and lifts the suspension.
    await page.getByLabel("Status").selectOption("actioned");
    const decided = table.getByRole("row").filter({ hasText: "Misty W" });
    await expect(decided).toHaveCount(1);
    await decided
      .getByRole("button", { name: "Review report on Misty W" })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Note (optional)" })
    ).toBeFocused();
    await page.getByRole("button", { name: "Lift suspension" }).click();
    await expect(
      page.getByRole("region", { name: "Notifications" })
    ).toContainText("Suspension lifted.");
    await expect(
      page.getByRole("textbox", { name: "Note (optional)" })
    ).toBeFocused();
    await s.misty.goto(`${ORIGIN}/trades`);
    await expect(
      s.misty.getByRole("heading", { level: 1, name: "Trades" })
    ).toBeVisible();
    await expect(
      s.misty.getByText(SUSPENDED_NOTE, { exact: true })
    ).toHaveCount(0);
  });
});

test.describe("phone, Report", () => {
  test.use(PHONE_SIZE);

  test("the ⋯ menu, the reasons and the Report button are touch-sized and read the same at 375 px", async ({
    page,
    collectors,
  }) => {
    test.slow();
    await conversationStory(page, collectors, PHONE_SIZE, true);
  });
});
