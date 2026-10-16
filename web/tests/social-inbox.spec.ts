// Ticket #259: the inbox (spec "Inbox derivation", "Web screens"). Ash K. sends Misty W. two Borrow Requests through
// the API. Misty's bell and Loans tab count both; the bell's drawer lists one line per Loan, she opens one from it and
// declines it, and both badges count one. Ash's bell lists the decline under Earlier; he opens the Loan from it, and
// Clear empties Earlier for good. Collection's phone header still fits its Search with the bell in it.
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
  await ask();
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
  await lender.setViewportSize(DESKTOP);

  // She opens the newer one from the inbox and declines it: one Loan waits on her now.
  await waiting.first().click();
  await expect(drawer(lender)).toBeHidden();
  await expect(lender).toHaveURL(`${ORIGIN}/loans/${newer}`);
  await expect(title(lender)).toHaveText("Ash K wants to borrow 1 card");
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

  // Ash: nothing waits on him; the decline is under Earlier, and opens its Loan.
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
    "New: Misty W declined your request",
  ]);
  await marked;
  await earlier.getByRole("link").click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${newer}`);
  await expect(title(page)).toHaveText(
    "Misty W declined your request for 1 card"
  );

  // The drawer marked it read; Clear empties Earlier, and it stays empty.
  await bell(page).click();
  await expect(earlier.getByRole("link")).toHaveText([
    "Misty W declined your request",
  ]);
  await earlier.getByRole("button", { name: "Clear" }).click();
  await expect(earlier).toContainText("No updates.");
  await expect(drawer(page).getByRole("status")).toHaveText("Cleared.");
  await expect(earlier.getByRole("heading", { name: "Earlier" })).toBeFocused();
  await drawer(page).getByRole("button", { name: "Close Inbox" }).click();
  await expect(bell(page)).toBeFocused();
  await page.reload();
  await bell(page).click();
  await expect(earlier).toContainText("No updates.");
});
