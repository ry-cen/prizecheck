// Ticket #260: Ending a friendship with open Loans (spec "Friendship and Block", "Inbox derivation"). Misty W. lends
// Ash K. one Iono that both sides confirmed handed over, and accepted his request for another nobody has handed over
// yet (all through the API, as #252's and #253's specs cover). Ash removes Misty as a Friend in the Friends drawer:
// the Loan not yet handed over is cancelled, and Misty's bell tells her only that Ash cancelled it; the one handed over
// stays out on both sides, and Ash can still give the card back.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import {
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

const title = (on: Page) => on.getByRole("heading", { level: 1 });
const friends = (on: Page) => on.getByRole("dialog", { name: "Friends" });
const inbox = (on: Page) => on.getByRole("dialog", { name: "Inbox" });

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
  await yours.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(friends(page).getByRole("status")).toHaveText(
    "Misty W is no longer a Friend."
  );
  await friends(page).getByRole("button", { name: "Close Friends" }).click();

  // His Loans: the one nobody handed over is cancelled; the one handed over is still out, and he can give it back.
  await page.reload();
  await expect(page.getByRole("region", { name: "Pending" })).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Out now" }).getByRole("link")
  ).toHaveText(/You have 1 card of Misty W's/);
  await page.locator("summary", { hasText: "History" }).click();
  await page.getByRole("link", { name: /You cancelled this Loan/ }).click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${pending}`);
  await page.goto(`${ORIGIN}/loans/${out}`);
  await expect(title(page)).toHaveText("You have 1 card of Misty W's");
  await expect(
    page.getByRole("button", { name: "Give cards back" })
  ).toBeVisible();

  // Misty: her bell says only that Ash cancelled it, and opens it; the Loan handed over is still out.
  await lender.goto(`${ORIGIN}/loans`);
  await expect(
    lender.getByRole("region", { name: "Out now" }).getByRole("link")
  ).toHaveText(/Ash K has 1 card of yours/);
  await lender.setViewportSize(PHONE);
  await lender.getByRole("button", { name: /^Inbox/ }).click();
  const earlier = inbox(lender).getByRole("region", { name: "Earlier" });
  await expect(earlier.getByRole("link").first()).toHaveText(
    "New: Ash K cancelled this Loan"
  );
  await expectPageChecks(lender, "a cancel in the inbox on a phone");
  await earlier.getByRole("link").first().click();
  await expect(lender).toHaveURL(`${ORIGIN}/loans/${pending}`);
  await expect(title(lender)).toHaveText("Ash K cancelled this Loan");
});
