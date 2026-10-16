// Ticket #257: Write-off (spec "Write-off", "Web screens"). Misty lends Ash three Iono PAL 185 and two Boss's Orders
// PAL 172 on two Loans (request, accept and both handover confirmations through the API, as #252's and #253's specs
// cover). Misty writes off two Iono with Write off…, which asks once and warns it can't be undone; Ash answers I still
// have them, so they become his. Misty writes off both Boss's Orders; Ash answers They're gone, which ends that Loan.
// Lines tag the copies written off. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { expect, test } from "./support/collectors";
import {
  DESKTOP,
  ORIGIN,
  PHONE,
  api,
  befriend,
  hold,
  lendHandedOver,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

test("the lender writes off copies, and the borrower keeps them or says they're gone", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  const binder = await unsorted(lender);
  await hold(lender, binder, ids["PAL 185"], 3);
  await hold(lender, binder, ids["PAL 172"], 2);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  await befriend(page, lender);
  const ionoLoan = await lendHandedOver(lender, page, [[ids["PAL 185"], 3]]);
  const bossLoan = await lendHandedOver(lender, page, [[ids["PAL 172"], 2]]);
  const title = (on: typeof page) => on.getByRole("heading", { level: 1 });
  const firstLine = (on: typeof page) =>
    on
      .getByRole("list", { name: "Cards", exact: true })
      .getByRole("listitem")
      .first();

  // Misty writes off two Iono: nothing chosen to start with, and one question before it happens.
  await lender.goto(`${ORIGIN}/loans/${ionoLoan}`);
  await expect(title(lender)).toHaveText("Ash K has 3 cards of yours");
  await lender.getByRole("button", { name: "More for this Loan" }).click();
  await lender.getByRole("menuitem", { name: "Write off…" }).click();
  const write = lender.getByRole("button", { name: "Write off", exact: true });
  await expect(write).toBeDisabled();
  const stepper = lender.getByRole("group", {
    name: /^Copies of Iono, .* to write off$/,
  });
  await stepper.getByRole("button", { name: /^Increase/ }).click();
  await stepper.getByRole("button", { name: /^Increase/ }).click();
  await expect(lender.getByRole("main")).toContainText(
    "Write off 2 cards? They leave your Collection, and this can't be undone."
  );
  await expectPageChecks(lender, "choosing the cards to write off");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "choosing the cards to write off on a phone");
  await lender.setViewportSize(DESKTOP);
  await write.click();
  await expect(title(lender)).toHaveText("Ash K has 1 card of yours");
  await expect(firstLine(lender)).toContainText("2 written off");

  // Ash: the Write-off needs him; I still have them makes them his.
  await page.goto(`${ORIGIN}/loans`);
  await expect(
    page.getByRole("region", { name: "Needs you" }).getByRole("link")
  ).toContainText("Misty W wrote off 2 cards you have");
  await page.goto(`${ORIGIN}/loans/${ionoLoan}`);
  await expectPageChecks(page, "a Write-off to answer");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "a Write-off to answer on a phone");
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "I still have them" }).click();
  await expect(title(page)).toHaveText("You have 1 card of Misty W's");
  await expect(firstLine(page)).toContainText("2 written off");
  // One Iono still borrowed, and both Boss's Orders on the other Loan.
  const tree = await api(page, "GET", "/api/location-tree");
  expect(tree.borrowed_copies).toBe("3");

  // Misty writes off both Boss's Orders; Ash says they're gone, which ends that Loan.
  await lender.goto(`${ORIGIN}/loans/${bossLoan}`);
  await lender.getByRole("button", { name: "More for this Loan" }).click();
  await lender.getByRole("menuitem", { name: "Write off…" }).click();
  const boss = lender.getByRole("group", {
    name: /^Copies of Boss's Orders, .* to write off$/,
  });
  await boss.getByRole("button", { name: /^Increase/ }).click();
  await boss.getByRole("button", { name: /^Increase/ }).click();
  await write.click();
  await expect(title(lender)).toHaveText("Ash K has no cards of yours");
  await page.goto(`${ORIGIN}/loans/${bossLoan}`);
  await expect(title(page)).toHaveText("Misty W wrote off 2 cards you have");
  await page.getByRole("button", { name: "They're gone" }).click();
  await expect(title(page)).toHaveText("Your Loan from Misty W ended");
  await expect(firstLine(page)).toContainText("2 written off");
  await lender.reload();
  await expect(title(lender)).toHaveText("Your Loan to Ash K ended");
});
