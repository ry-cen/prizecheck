import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  accountId,
  api,
  befriend,
  createDeck,
  DESKTOP,
  hold,
  lendHandedOver,
  loanStep,
  nameCollector,
  ORIGIN,
  PHONE,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import { forTradeLeaf, propose } from "./support/trades";

test.use({ viewport: DESKTOP, hasTouch: true });

test("a lender sees eligibility separately from overlapping own Deck commitments and opens card details", async ({
  page,
  collectors,
}) => {
  test.slow();
  const ids = seedCatalog();
  const edition = ids["PAL 185"];
  const borrower = (await collectors.signIn({ next: "/loans" })).page;
  await nameCollector(borrower, "Sam");
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Alex");
  await hold(page, await unsorted(page), edition, 4);
  await befriend(page, borrower);
  const first = await createDeck(page, "Own private first Deck");
  const second = await createDeck(page, "Own private second Deck");
  await setLine(page, first, edition, 2);
  await setLine(page, second, edition, 2);
  const settings = await api(page, "GET", "/api/settings");
  await api(page, "PUT", "/api/settings/want-list-counting", {
    revision: settings.revision,
    want_list_counting: "one_at_a_time",
    idempotency_key: randomUUID(),
  });
  const borrowerDeck = await createDeck(borrower, "Borrower private Deck");
  const sent = await api(borrower, "POST", "/api/loans", {
    lender_id: await accountId(page),
    lines: [{ edition_id: edition, quantity: "2" }],
    deck_id: borrowerDeck,
    idempotency_key: randomUUID(),
  });
  await page.goto(`${ORIGIN}/loans/${sent.id}`);
  const card = page.getByRole("list", { name: "Cards", exact: true });
  await expect(card).toContainText("4 copies available to lend.");
  // The two Decks reuse the same two loose copies; neither summing demand nor subtracting it is correct.
  await expect(card).toContainText("Your Decks count on 2 copies.");
  const quantity = card.getByRole("group", {
    name: /^Copies of Iono,.*to lend$/,
  });
  await expect(quantity.locator("output")).toHaveText("2");
  await quantity.getByRole("button", { name: /^Decrease/ }).click();
  const details = card.getByRole("button", {
    name: /^Card details for Iono, PAL 185/,
  });
  const popup = page.getByRole("dialog", { name: "Iono", exact: true });
  for (const viewport of [DESKTOP, PHONE]) {
    await page.setViewportSize(viewport);
    await expectTouchTarget(details);
    await details.focus();
    await details.press("Enter");
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("PAL 185");
    await expect(popup).toContainText("Normal");
    await expect(popup).toContainText("2 asked");
    await expect(popup).toContainText("1 selected to lend");
    await expect(popup).toContainText("4 copies available to lend.");
    await expect(popup).toContainText("Your Decks count on 2 copies.");
    await expect(popup).not.toContainText("Borrower private Deck");
    await expectPageChecks(page, `Loan card details at ${viewport.width}`);
    await page.keyboard.press("Escape");
    await expect(popup).toBeHidden();
    await expect(details).toBeFocused();
    await details.tap();
    const close = popup.getByRole("button", { name: "Close card details" });
    if (viewport.width === PHONE.width) await expectTouchTarget(close);
    await close.click();
    await expect(popup).toBeHidden();
    await expect(details).toBeFocused();
    await expect(quantity.locator("output")).toHaveText("1");
  }
  // The borrower gets no lender Deck-use or eligibility context, including in card details.
  await borrower.goto(`${ORIGIN}/loans/${sent.id}`);
  await borrower
    .getByRole("button", { name: /^Card details for Iono,/ })
    .click();
  const theirs = borrower.getByRole("dialog", { name: "Iono", exact: true });
  await expect(theirs).toBeVisible();
  await expect(theirs).not.toContainText("available to lend");
  await expect(theirs).not.toContainText("Your Decks count on");
  await expect(theirs).not.toContainText("Own private");
});

test("eligibility excludes Borrowed Copies and other Loan and Trade promises, including zero", async ({
  page,
  collectors,
}) => {
  test.slow();
  const edition = seedCatalog()["PAL 185"];
  const borrower = (await collectors.signIn({ next: "/loans" })).page;
  await nameCollector(borrower, "Sam");
  await hold(borrower, await unsorted(borrower), edition, 1);
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Alex");
  await hold(page, await forTradeLeaf(page, "Trade Binder"), edition, 4);
  await befriend(page, borrower);
  await lendHandedOver(borrower, page, [[edition, 1]]);
  const request = () =>
    api(borrower, "POST", "/api/loans", {
      lender_id: account,
      lines: [{ edition_id: edition, quantity: "2" }],
      idempotency_key: randomUUID(),
    });
  const account = await accountId(page);
  const incoming = await request();
  const competing = await request();
  await loanStep(page, competing.id, `/api/loans/${competing.id}/accept`, {
    lines: [{ edition_id: edition, promised: "2" }],
  });
  const other = await accountId(borrower);
  const promiseTrade = () => propose(page, other, [[edition, 1]], []);
  await promiseTrade();
  await page.goto(`${ORIGIN}/loans/${incoming.id}`);
  const cards = page.getByRole("list", { name: "Cards", exact: true });
  await expect(cards).toContainText("1 copy available to lend.");
  const quantity = cards.getByRole("group", {
    name: /^Copies of Iono,.*to lend$/,
  });
  await expect(quantity.locator("output")).toHaveText("1");
  await expect(
    quantity.getByRole("button", { name: /^Increase/ })
  ).toBeDisabled();
  await promiseTrade();
  await page.reload();
  await expect(cards).toContainText("0 copies available to lend.");
  await expect(cards).toContainText("Not lent");
  await expect(quantity.locator("output")).toHaveText("0");
  await expect(
    quantity.getByRole("button", { name: /^Increase/ })
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Accept", exact: true })
  ).toBeDisabled();
  await cards.getByRole("button", { name: /^Card details for Iono,/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Iono", exact: true })
  ).toContainText("0 copies available to lend.");
});
