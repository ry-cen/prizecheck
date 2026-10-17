// Ticket #259: the inbox (spec "Inbox derivation", "Web screens"). Ash K. sends Misty W. two Borrow Requests through
// the API. Misty's bell and Loans tab count both; the bell's drawer lists one line per Loan, she opens one from it and
// declines it, and both badges count one. Ash's bell lists the decline under Earlier; he opens the Loan from it, and
// Clear empties Earlier for good. Collection's phone header still fits its Search with the bell in it. Each update says
// when it happened (owner's decision, 2026-10-16), read on a clock fixed after it, so the words never depend on how long
// the test took; Ash then withdraws his other request, and Misty's bell says he withdrew it. A Loan opened from the
// bell in Collection's phone header takes focus on its heading, and a Clear that got no answer keeps focus on Clear.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  accountId,
  api,
  befriend,
  hold,
  loanStep,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const bell = (on: Page) => on.getByRole("button", { name: /^Inbox/ });
const loansTab = (on: Page) =>
  on
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: /^Loans/ });
const drawer = (on: Page) => on.getByRole("dialog", { name: "Inbox" });
const title = (on: Page) => on.getByRole("heading", { level: 1 });
const HOUR = 3_600_000;

/** Fixes `on`'s clock `ms` after the time of the reader's newest update, as the API says it happened. */
async function fixClockAfterNewestUpdate(on: Page, ms: number) {
  const { updates } = await api(on, "GET", "/api/social/inbox");
  await on.clock.setFixedTime(
    new Date(
      Math.max(...updates.map((u: { at: string }) => Date.parse(u.at))) + ms
    )
  );
}

test("the bell lists the Loans waiting on you, opens one, and Clear empties Earlier", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
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
  const mistyId = await accountId(lender);
  const ask = async () =>
    (
      await api(page, "POST", "/api/loans", {
        lender_id: mistyId,
        lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
        deck_id: null,
        idempotency_key: randomUUID(),
      })
    ).id as string;
  const older = await ask();
  const newer = await ask();

  // Misty: both requests wait on her, on the bell and on the Loans tab.
  await lender.goto(`${ORIGIN}/collection`);
  await expect(bell(lender)).toHaveAccessibleName("Inbox, 2 waiting");
  await expect(loansTab(lender)).toHaveAccessibleName("Loans, 2 need you");
  await bell(lender).click();
  const waiting = drawer(lender)
    .getByRole("region", { name: "Waiting on you" })
    .getByRole("link");
  await expect(waiting).toHaveCount(2);
  await expect(waiting.first()).toContainText("Ash K · Answer");
  await expect(waiting.first()).toContainText("Iono");
  await expect(
    drawer(lender).getByRole("region", { name: "Earlier" })
  ).toContainText("No updates.");
  await expectPageChecks(lender, "the inbox");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "the inbox on a phone");

  // She opens the newer one from the bell in Collection's phone header and declines it: one Loan waits on her now.
  // That bell is hidden once the Loan is drawn, so the Loan's heading takes focus.
  await drawer(lender).getByRole("button", { name: "Close Inbox" }).click();
  await bell(lender).click();
  await waiting.first().click();
  await expect(drawer(lender)).toBeHidden();
  await expect(lender).toHaveURL(`${ORIGIN}/loans/${newer}`);
  await expect(title(lender)).toHaveText("Ash K wants to borrow 1 card");
  await expect(title(lender)).toBeFocused();
  await lender.setViewportSize(DESKTOP);
  await lender.getByRole("button", { name: "Decline", exact: true }).click();
  await lender
    .getByRole("group", { name: "Decline" })
    .getByRole("button", { name: "Decline", exact: true })
    .click();
  await expect(title(lender)).toHaveText(
    "You declined Ash K's request for 1 card"
  );
  await expect(bell(lender)).toHaveAccessibleName("Inbox, 1 waiting");
  await expect(loansTab(lender)).toHaveAccessibleName("Loans, 1 needs you");

  // Collection's phone header holds the bell and still fits Search.
  await lender.setViewportSize(PHONE);
  await lender.goto(`${ORIGIN}/collection`);
  await expect(bell(lender)).toBeVisible();
  await expect(loansTab(lender)).toHaveAccessibleName("Loans, 1 needs you");
  await expectPageChecks(lender, "Collection on a phone with the bell");

  // Ash: nothing waits on him; the decline is under Earlier, three hours ago by his clock, and opens its Loan.
  await fixClockAfterNewestUpdate(page, 3 * HOUR);
  await page.goto(`${ORIGIN}/loans`);
  await expect(bell(page)).toHaveAccessibleName("Inbox");
  await expect(loansTab(page)).toHaveAccessibleName("Loans");
  // The drawer marks what it shows read; wait for that before reading the inbox again.
  const marked = page.waitForResponse(/\/api\/social\/inbox\/read$/);
  await bell(page).click();
  await expect(
    drawer(page).getByRole("region", { name: "Waiting on you" })
  ).toContainText("Nothing is waiting on you.");
  const earlier = drawer(page).getByRole("region", { name: "Earlier" });
  await expect(earlier.getByRole("link")).toHaveText([
    "New: Misty W declined your request 3 hours ago",
  ]);
  await marked;
  await earlier.getByRole("link").click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${newer}`);
  await expect(title(page)).toHaveText(
    "Misty W declined your request for 1 card"
  );

  // The drawer marked it read; Clear empties Earlier, and it stays empty. A Clear that got no answer says so, and
  // focus stays on Clear, which stays enabled while it is out.
  await bell(page).click();
  await expect(earlier.getByRole("link")).toHaveText([
    "Misty W declined your request 3 hours ago",
  ]);
  const clear = earlier.getByRole("button", { name: "Clear" });
  await page.route("**/api/social/inbox/clear", (route) => route.abort(), {
    times: 1,
  });
  await clear.click();
  await expect(drawer(page).getByRole("alert")).toHaveText(
    "Couldn't clear. Check your connection and try again."
  );
  await expect(clear).toBeFocused();
  await clear.click();
  await expect(earlier).toContainText("No updates.");
  await expect(drawer(page).getByRole("status")).toHaveText("Cleared.");
  await expect(earlier.getByRole("heading", { name: "Earlier" })).toBeFocused();
  await drawer(page).getByRole("button", { name: "Close Inbox" }).click();
  await expect(bell(page)).toBeFocused();
  await page.reload();
  await bell(page).click();
  await expect(earlier).toContainText("No updates.");

  // Ash withdraws his other request: Misty's bell says he withdrew it, two days ago by her clock, and nothing waits.
  await loanStep(page, older, `/api/social/loans/${older}/withdraw`);
  await fixClockAfterNewestUpdate(lender, 48 * HOUR);
  await lender.goto(`${ORIGIN}/loans`);
  await expect(bell(lender)).toHaveAccessibleName("Inbox");
  await bell(lender).click();
  await expect(
    drawer(lender).getByRole("region", { name: "Earlier" }).getByRole("link")
  ).toHaveText(["New: Ash K withdrew their request 2 days ago"]);
});
