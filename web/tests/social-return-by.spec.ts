// Ticket #256: Return-by date and overdue (spec "Return-by date and overdue", "Web screens"). Misty lends Ash one Iono
// PAL 185 due back in 10 days (request, accept and both handover confirmations through the API, as #252's and #253's
// specs cover). Misty extends the date with Change return-by date; Ash asks for more time, and Misty approves it with
// one tap. The API tests cover the date rules, overdue and the 14-day nudge. The catalog is the Swap catalog
// (api/tests/want_list_swap_fixtures.py).
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

/** The local calendar day `days` from today, as a date input's value and as the Loan screen writes it. */
function inDays(days: number): { value: string; text: string } {
  const now = new Date();
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    value: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`,
    text: new Intl.DateTimeFormat("en", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(day),
  };
}

test("the lender extends the return-by date, and approves the borrower's request for more time", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
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
  const [due, later, latest] = [inDays(10), inDays(20), inDays(30)];
  const loanId = await lendHandedOver(
    lender,
    page,
    [[ids["PAL 185"], 1]],
    null,
    due.value
  );
  const main = (on: typeof page) => on.getByRole("main");

  // Misty extends the date: the field starts at the current one.
  await lender.goto(`${ORIGIN}/loans/${loanId}`);
  await expect(main(lender)).toContainText(`Due back ${due.text}`);
  await lender.getByRole("button", { name: "More for this Loan" }).click();
  await lender.getByRole("menuitem", { name: "Change return-by date" }).click();
  const field = lender.getByLabel("Return by", { exact: true });
  await expect(field).toHaveValue(due.value);
  await field.fill(later.value);
  await expectPageChecks(lender, "changing the return-by date");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "changing the return-by date on a phone");
  await lender.setViewportSize(DESKTOP);
  await lender.getByRole("button", { name: "Save" }).click();
  await expect(main(lender)).toContainText(`Due back ${later.text}`);

  // Ash asks for more time.
  await page.goto(`${ORIGIN}/loans/${loanId}`);
  await expect(main(page)).toContainText(`Due back ${later.text}`);
  await page.getByRole("button", { name: "More for this Loan" }).click();
  await page.getByRole("menuitem", { name: "Ask for more time" }).click();
  await page.getByLabel("New return-by date").fill(latest.value);
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "asking for more time on a phone");
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(main(page)).toContainText(
    `You asked for more time, until ${latest.text}`
  );

  // Misty: the request needs her, and one tap approves it.
  await lender.goto(`${ORIGIN}/loans`);
  await expect(
    lender.getByRole("region", { name: "Needs you" }).getByRole("link")
  ).toContainText("Ash K asked for more time");
  await lender.goto(`${ORIGIN}/loans/${loanId}`);
  const request = lender.getByRole("group", { name: "More time" });
  await expect(request).toContainText(
    `Ash K asked for more time, until ${latest.text}.`
  );
  await expectPageChecks(lender, "a request for more time");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "a request for more time on a phone");
  await lender.setViewportSize(DESKTOP);
  await request.getByRole("button", { name: "Approve" }).click();
  await expect(main(lender)).toContainText(`Due back ${latest.text}`);
  await expect(request).toHaveCount(0);
  await page.reload();
  await expect(main(page)).toContainText(`Due back ${latest.text}`);
  await expect(main(page)).not.toContainText("You asked for more time");
});
