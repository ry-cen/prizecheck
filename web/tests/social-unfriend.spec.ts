// Ticket #260: Ending a friendship with open Loans (spec "Friendship and Block", "Inbox derivation"). Misty W. lends
// Ash K. one Iono that both sides confirmed handed over, and accepted his request for another nobody has handed over
// yet (all through the API, as #252's and #253's specs cover). Ash removes Misty as a Friend in the Friends drawer,
// whose question says it cancels that one Loan: it is cancelled, it no longer offers Edit and resend, and Misty's bell
// tells her only that Ash cancelled it, and when; the one handed over stays out on both sides, and Ash can still give
// the card back. (Owner's decisions, 2026-10-16.)
// Ticket #274 (Trading spec "Unfriend, Block and half-confirmed Trades"): with a Trade Proposal, a Trade nobody has
// confirmed and a Trade only Misty confirmed open too, the question counts them in the prototype's Proposed wording;
// Remove cancels the proposal and the unconfirmed Trade, which move to Ash's History while his Trades list is open,
// and the half-confirmed one stays for him to finish. Misty is told only that Ash cancelled each. At desktop width and
// at 375 px.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  accountId,
  api,
  befriend,
  hold,
  lendHandedOver,
  loanStep,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import {
  DESKTOP_SIZE,
  PHONE_SIZE,
  forTradeLeaf,
  propose,
  tradeStep,
} from "./support/trades";

const title = (on: Page) => on.getByRole("heading", { level: 1 });
const friends = (on: Page) => on.getByRole("dialog", { name: "Friends" });
const inbox = (on: Page) => on.getByRole("dialog", { name: "Inbox" });
const tradesTab = (on: Page) =>
  on
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Trades/ });

test("removing a Friend cancels the Loan nobody handed over and keeps the one handed over", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and a page check: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 2);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const out = await lendHandedOver(lender, page, [[ids["PAL 185"], 1]]);
  const pending = (
    await api(page, "POST", "/api/loans", {
      lender_id: await accountId(lender),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      deck_id: null,
      idempotency_key: randomUUID(),
    })
  ).id as string;
  await loanStep(lender, pending, `/api/loans/${pending}/accept`, {
    lines: [{ edition_id: ids["PAL 185"], promised: "1" }],
  });

  // Ash removes Misty as a Friend.
  await page.goto(`${ORIGIN}/loans`);
  await expect(
    page.getByRole("region", { name: "Pending" }).getByRole("link")
  ).toContainText("Misty W is lending you 1 card");
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  const yours = friends(page).getByRole("region", { name: "Your Friends" });
  await yours.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Remove Friend" }).click();
  await expect(yours).toContainText(
    "Remove Misty W as a Friend? This cancels 1 open Loan that hasn't been handed over."
  );
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "the Remove Friend question on a phone");
  await page.setViewportSize(DESKTOP);
  await yours.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(friends(page).getByRole("status")).toHaveText(
    "Misty W is no longer a Friend."
  );
  await friends(page).getByRole("button", { name: "Close Friends" }).click();

  // His Loans, read again after the command: the one nobody handed over is cancelled; the one handed over is still
  // out, and he can give it back.
  await expect(page.getByRole("region", { name: "Pending" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Out now" }).getByRole("link")
  ).toHaveText(/You have 1 card of Misty W's/);
  await page.locator("summary", { hasText: "History" }).click();
  await page.getByRole("link", { name: /You cancelled this Loan/ }).click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${pending}`);
  // Misty isn't his Friend now, so the request offers no Edit and resend, its menu's only item.
  await expect(title(page)).toHaveText("You cancelled this Loan");
  await expect(
    page.getByRole("button", { name: "More for this Loan" })
  ).toHaveCount(0);
  await page.goto(`${ORIGIN}/loans/${out}`);
  await expect(title(page)).toHaveText("You have 1 card of Misty W's");
  await expect(
    page.getByRole("button", { name: "Give cards back" })
  ).toBeVisible();

  // Misty: her bell says only that Ash cancelled it, five minutes ago by a clock fixed after it, and opens it; the Loan
  // handed over is still out.
  const { updates } = await api(lender, "GET", "/api/social/inbox");
  await lender.clock.setFixedTime(
    new Date(
      Math.max(...updates.map((u: { at: string }) => Date.parse(u.at))) +
        5 * 60_000
    )
  );
  await lender.goto(`${ORIGIN}/loans`);
  await expect(
    lender.getByRole("region", { name: "Out now" }).getByRole("link")
  ).toHaveText(/Ash K has 1 card of yours/);
  await lender.setViewportSize(PHONE);
  await lender.getByRole("button", { name: /^Inbox/ }).click();
  const earlier = inbox(lender).getByRole("region", { name: "Earlier" });
  await expect(earlier.getByRole("link").first()).toHaveText(
    "New: Ash K cancelled this Loan 5 minutes ago"
  );
  await expectPageChecks(lender, "a cancel in the inbox on a phone");
  await earlier.getByRole("link").first().click();
  await expect(lender).toHaveURL(`${ORIGIN}/loans/${pending}`);
  await expect(title(lender)).toHaveText("Ash K cancelled this Loan");
});

test("the Block question says how many open Loans it cancels, and only that it is silent when the Loans can't be read", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts and a catalog import: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const pending = (
    await api(page, "POST", "/api/loans", {
      lender_id: await accountId(lender),
      lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
      deck_id: null,
      idempotency_key: randomUUID(),
    })
  ).id as string;
  await loanStep(lender, pending, `/api/loans/${pending}/accept`, {
    lines: [{ edition_id: ids["PAL 185"], promised: "1" }],
  });

  // Ash chooses Block on Misty: the question counts the one Loan nobody handed over. Cancel leaves it all as it was.
  const openBlock = async () => {
    await page.getByRole("button", { name: "Friends", exact: true }).click();
    const yours = friends(page).getByRole("region", { name: "Your Friends" });
    await yours.getByRole("button", { name: "More for Misty W" }).click();
    await page.getByRole("menuitem", { name: "Block" }).click();
    return yours;
  };
  await page.goto(`${ORIGIN}/loans`);
  const yours = await openBlock();
  await expect(yours.getByText(/^Block Misty W\?/)).toHaveText(
    "Block Misty W? They won't be told. This cancels 1 open Loan that hasn't been handed over."
  );
  await yours.getByRole("button", { name: "Cancel" }).click();

  // With the Loans unreadable, the question says nothing about them.
  await page.route(/\/api\/social\/loans/, (route) => route.abort());
  await page.reload();
  const again = await openBlock();
  await expect(again.getByText(/^Block Misty W\?/)).toHaveText(
    "Block Misty W? They won't be told."
  );
});

/** Ash removes Misty with a Loan, a Trade Proposal, a Trade nobody confirmed and a Trade Misty confirmed open. */
async function tradeStory(
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
  const iono = ids["PAL 185"];
  const arven = ids["SVI 166"];
  const misty = await collectors.signIn({ next: "/trades", contextOptions });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await forTradeLeaf(lender, "Trade Shelf"), iono, 4);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/trades");
  await nameCollector(page, "Ash K");
  await hold(page, await forTradeLeaf(page, "Trade Box"), arven, 2);
  await befriend(page, lender);
  const ashId = await accountId(page);
  // Misty's proposal waits for Ash; he accepted her second; he accepted her gift, and only she confirmed it.
  await propose(lender, ashId, [[iono, 1]], [[arven, 1]]);
  const accepted = await propose(lender, ashId, [[iono, 1]], [[arven, 1]]);
  await tradeStep(page, accepted, "accept");
  const half = await propose(lender, ashId, [[iono, 1]], []);
  await tradeStep(page, half, "accept");
  await tradeStep(lender, half, "confirm-swap");
  // And a Loan Misty accepted that nobody has handed over.
  const loan = (
    await api(page, "POST", "/api/loans", {
      lender_id: await accountId(lender),
      lines: [{ edition_id: iono, quantity: "1" }],
      deck_id: null,
      idempotency_key: randomUUID(),
    })
  ).id as string;
  await loanStep(lender, loan, `/api/loans/${loan}/accept`, {
    lines: [{ edition_id: iono, promised: "1" }],
  });

  // Ash's Trades list: the half-confirmed Trade needs him, the proposal too, and one Trade is to swap.
  await page.goto(`${ORIGIN}/trades`);
  const needsYou = page.getByRole("list", { name: "Needs you" });
  await expect(needsYou.getByRole("link")).toHaveCount(2);
  await expect(
    page.getByRole("list", { name: "To swap" }).getByRole("link")
  ).toHaveText([/Ready to swap with Misty W/]);
  await expect(tradesTab(page)).toHaveAccessibleName("Trades, 2 need you");

  // He removes Misty. The question counts what it cancels, in the prototype's Proposed wording, and what stays.
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  const yours = friends(page).getByRole("region", { name: "Your Friends" });
  await yours.getByRole("button", { name: "More for Misty W" }).click();
  await page.getByRole("menuitem", { name: "Remove Friend" }).click();
  await expect(yours.getByText(/^Remove Misty W as a Friend\?/)).toHaveText(
    "Remove Misty W as a Friend? This cancels 1 open Loan that hasn't been handed over, 1 Trade Proposal and 1 Trade that hasn't been swapped. 1 Trade that one of you has confirmed stays open so it can finish."
  );
  await expectPageChecks(
    page,
    `the Remove Friend question with Trades at ${width}`
  );
  await yours.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(friends(page).getByRole("status")).toHaveText(
    "Misty W is no longer a Friend."
  );
  await friends(page).getByRole("button", { name: "Close Friends" }).click();

  // The list underneath was read again: only the half-confirmed Trade is open, and the two he cancelled are history.
  await expect(needsYou.getByRole("link")).toHaveText([
    /Misty W confirmed the swap/,
  ]);
  await expect(page.getByRole("list", { name: "To swap" })).toHaveCount(0);
  await page.locator("summary", { hasText: "History · 2" }).click();
  await expect(
    page.getByRole("list", { name: "History" }).getByRole("link")
  ).toHaveText([/You cancelled this Trade/, /You cancelled this Trade/]);
  await expect(tradesTab(page)).toHaveAccessibleName("Trades, 1 needs you");

  // Ash finishes the half-confirmed Trade alone: Misty's Iono goes to his Unsorted.
  await needsYou.getByRole("link").click();
  await expect(page).toHaveURL(`${ORIGIN}/trades/${half}`);
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Misty W confirmed the swap"
  );
  await main.getByRole("button", { name: "Confirm swap" }).click();
  await page
    .getByRole("dialog", { name: "Confirm swap with Misty W?" })
    .getByRole("button", { name: "Confirm swap" })
    .click();
  await expect(main.getByRole("heading", { level: 1 })).toHaveText(
    "Swapped with Misty W"
  );

  // Misty's inbox says only that Ash cancelled the Loan and each Trade, and that he confirmed the swap.
  await lender.goto(`${ORIGIN}/trades`);
  await lender.getByRole("button", { name: /^Inbox/ }).click();
  const earlier = inbox(lender).getByRole("region", { name: "Earlier" });
  await expect(
    earlier.getByRole("link", { name: /Ash K cancelled this Trade/ })
  ).toHaveCount(2);
  await expect(
    earlier.getByRole("link", { name: /Ash K cancelled this Loan/ })
  ).toHaveCount(1);
  await expect(
    earlier.getByRole("link", { name: /Ash K confirmed the swap/ })
  ).toHaveCount(1);
  await expectPageChecks(lender, `Trade cancels in the inbox at ${width}`);
}

test.describe("Trades, desktop", () => {
  test.use(DESKTOP_SIZE);

  test("removing a Friend counts and cancels the Trades nobody confirmed, and leaves a half-confirmed one to finish", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog import, many page loads and page checks: well over 30 s on a loaded
    // host.
    test.slow();
    await tradeStory(page, collectors, DESKTOP_SIZE, "desktop width");
  });
});

test.describe("Trades, phone", () => {
  test.use(PHONE_SIZE);

  test("the same at 375 px", async ({ page, collectors }) => {
    // Two collectors in two contexts, a catalog import, many page loads and page checks: well over 30 s on a loaded
    // host.
    test.slow();
    await tradeStory(page, collectors, PHONE_SIZE, "375 px");
  });
});
