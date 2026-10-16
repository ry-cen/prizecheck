// Ticket #255: Returns (spec "Loan steps", "Web screens"). Misty lends Ash three Iono PAL 185 (request, accept and
// both handover confirmations through the API, as #252's and #253's specs cover). Ash gives two back with Give cards
// back, and Misty confirms with Yes, they're back; then Misty records the last one with Record a return, and Ash
// confirms with Yes, I gave them back, which ends the Loan. Each line tags the copies returned and those coming back.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  befriend,
  hold,
  lendHandedOver,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

test("a return started by either side moves on once the other side confirms, and the last one ends the Loan", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 3);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const loanId = await lendHandedOver(lender, page, [[ids["PAL 185"], 3]]);
  const title = (on: typeof page) => on.getByRole("heading", { level: 1 });
  const iono = (on: typeof page) =>
    on
      .getByRole("list", { name: "Cards", exact: true })
      .getByRole("listitem")
      .first();

  // Ash gives two back: every copy out to start with, one taken off.
  await page.goto(`${ORIGIN}/loans/${loanId}`);
  await expect(title(page)).toHaveText("You have 3 cards of Misty W's");
  await page.getByRole("button", { name: "Give cards back" }).click();
  const stepper = page.getByRole("group", {
    name: /^Copies of Iono, .* to return$/,
  });
  await expect(stepper).toContainText("3");
  await stepper.getByRole("button", { name: /^Decrease/ }).click();
  await expectPageChecks(page, "choosing the cards to give back");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "choosing the cards to give back on a phone");
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Give these back" }).click();
  await expect(page.getByRole("main")).toContainText(
    "Waiting for Misty W to confirm"
  );
  await expect(iono(page)).toContainText("2 coming back");

  // Misty: the return needs her; Yes, they're back.
  await lender.goto(`${ORIGIN}/loans`);
  await expect(
    lender.getByRole("region", { name: "Needs you" }).getByRole("link")
  ).toContainText("Ash K says they gave back 2 cards");
  await lender.goto(`${ORIGIN}/loans/${loanId}`);
  await expectPageChecks(lender, "a return to confirm");
  await lender.getByRole("button", { name: "Yes, they're back" }).click();
  await expect(title(lender)).toHaveText("Ash K has 1 card of yours");
  await expect(iono(lender)).toContainText("2 returned");

  // Misty records the last one, and Ash confirms it: the Loan ends.
  await lender.getByRole("button", { name: "Record a return" }).click();
  await lender.getByRole("button", { name: "Record return" }).click();
  await expect(lender.getByRole("main")).toContainText(
    "Waiting for Ash K to confirm"
  );
  await page.reload();
  await expect(title(page)).toHaveText("Misty W says they got 1 card back");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "a return to confirm on a phone");
  await page.getByRole("button", { name: "Yes, I gave them back" }).click();
  await expect(title(page)).toHaveText("Your Loan from Misty W ended");
  await expect(iono(page)).toContainText("3 returned");
  await page.setViewportSize(DESKTOP);
  await lender.reload();
  await expect(title(lender)).toHaveText("Your Loan to Ash K ended");
});
