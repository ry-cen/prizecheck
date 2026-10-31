import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  ORIGIN,
  PHONE,
  api,
  accountId,
  befriend,
  createDeck,
  hold,
  lendHandedOver,
  loanStep,
  nameCollector,
  seedCatalog,
  unsorted,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";
import { expectPageChecks } from "./support/page-check";

test("Loans keep a stable queue, canonical selection and open forms across widths", async ({
  page,
  collectors,
}, testInfo) => {
  test.slow();
  // Role locators omit hidden kept pages; raw selectors must start from this main.
  const main = page.getByRole("main");
  const ids = seedCatalog();
  const borrower = (await collectors.signIn({ next: "/loans" })).page;
  await nameCollector(borrower, "Ash K");
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Misty W");
  await hold(page, await unsorted(page), ids["PAL 185"], 20);
  await befriend(page, borrower);
  const deckName = "Charizard tournament Deck";
  const deck = await createDeck(borrower, deckName);
  await lendHandedOver(
    page,
    borrower,
    [[ids["PAL 185"], 3]],
    deck,
    "2099-01-31"
  );
  const request = () =>
    api(borrower, "POST", "/api/loans", {
      lender_id: account,
      lines: [{ edition_id: ids["PAL 185"], quantity: "3" }],
      deck_id: deck,
      idempotency_key: randomUUID(),
    });
  const account = await accountId(page);
  const selected = await request();
  const pending = await request();
  await loanStep(page, pending.id, `/api/loans/${pending.id}/accept`, {
    lines: [{ edition_id: ids["PAL 185"], promised: "3" }],
  });
  const history = await request();
  await loanStep(page, history.id, `/api/social/loans/${history.id}/decline`);
  // Enough real requests to exercise the queue's independent scroll region.
  for (const _ of Array.from({ length: 6 })) await request();
  let listReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/social/loans") listReads++;
  });
  await page.goto(`${ORIGIN}/loans`);
  await expect(page.getByRole("region", { name: "Needs you" })).toBeVisible();
  const initialReads = listReads;
  const phase = "after";
  const dir = testInfo.outputPath("screenshots");
  mkdirSync(dir, { recursive: true });
  for (const width of [1280, 1440, 1920, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Loans");
    await expect(page.getByRole("main")).toHaveCount(1);
    if (width >= 1440)
      await expect(page.getByText("Choose a Loan…")).toBeVisible();
    await expect(page).toHaveURL(`${ORIGIN}/loans`);
    await page.screenshot({
      path: `${dir}/${phase}-root-${width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1600, height: 650 });
  const row = main.locator(`a[href="/loans/${selected.id}"]`);
  await main.locator("summary", { hasText: "History" }).click();
  const queueViewport = main.locator(".list-detail-viewport");
  await row.scrollIntoViewIfNeeded();
  const shortWindowScroll = await queueViewport.evaluate(
    (element) => element.scrollTop
  );
  expect(shortWindowScroll).toBeGreaterThan(0);
  await row.click();
  await expect
    .poll(() => queueViewport.evaluate((element) => element.scrollTop))
    .toBe(shortWindowScroll);
  await expectPageChecks(page, "Loan detail in a short desktop window");
  await page.goBack();
  await expect(row).toBeFocused();
  await expect
    .poll(() => queueViewport.evaluate((element) => element.scrollTop))
    .toBe(shortWindowScroll);
  await row.click();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await queueViewport.evaluate((element) => element.scrollTo(0, 120));
  await expect
    .poll(() => queueViewport.evaluate((element) => element.scrollTop))
    .toBe(120);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Ash K wants to borrow 3 cards");
  await expect(heading).toBeFocused();
  await expect(row).toHaveAttribute("aria-current", "page");
  expect(listReads).toBe(initialReads);
  const quantity = page.getByRole("group", { name: /^Copies of Iono,/ });
  await quantity.getByRole("button", { name: /^Decrease/ }).click();
  await expect(quantity.locator("output")).toHaveText("2");
  for (const width of [1280, 1440, 1920, 390, 1600]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await expect(quantity.locator("output")).toHaveText("2");
    await expect(heading).toHaveCount(1);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expectPageChecks(page, `Loan form at ${width}`);
    await page.screenshot({
      path: `${dir}/${phase}-detail-form-${width}.png`,
      fullPage: true,
    });
  }
  await queueViewport.evaluate((element) => element.scrollTo(0, 120));
  await page.goBack();
  await expect(row).toBeFocused();
  await expect
    .poll(() => queueViewport.evaluate((element) => element.scrollTop))
    .toBe(120);
  await expect(main.locator("details")).toHaveAttribute("open", "");
  await page.goForward();
  await expect(heading).toHaveText("Ash K wants to borrow 3 cards");
  await expect(heading).not.toBeFocused();
  expect(listReads).toBe(initialReads);
  // Root → A → B → Back to A → Back to root restores A, not the last clicked B.
  const secondRow = main.locator(`a[href="/loans/${pending.id}"]`);
  await secondRow.click();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${pending.id}`);
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/loans/${selected.id}`);
  await expect(row).toHaveAttribute("aria-current", "page");
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/loans`);
  await expect(row).toBeFocused();
  expect(listReads).toBe(initialReads);
  // Modified clicks retain native new-tab navigation without changing this entry.
  await expect(secondRow).toHaveAttribute("href", `/loans/${pending.id}`);
  const newTab = page.context().waitForEvent("page");
  await secondRow.click({ modifiers: ["ControlOrMeta"] });
  const tab = await newTab;
  await expect(tab).toHaveURL(`${ORIGIN}/loans/${pending.id}`);
  await expect(page).toHaveURL(`${ORIGIN}/loans`);
  await tab.close();
  await page.goForward();
  await expect(heading).toHaveText("Ash K wants to borrow 3 cards");
  // 200% zoom at a 1440 physical-pixel window has a 720 CSS-pixel viewport.
  await page.setViewportSize({ width: 720, height: 450 });
  await expect(row).toBeHidden();
  await expect(heading).toBeVisible();
  await page.setViewportSize(PHONE);
  await expect(row).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${ORIGIN}/loans/${pending.id}`);
  await page.getByRole("button", { name: "More for this Loan" }).click();
  await page.getByRole("menuitem", { name: "Change return-by date" }).click();
  const date = page.getByLabel("Return by", { exact: true });
  await date.fill("2099-02-28");
  for (const width of [1440, 1280, 1600]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(date).toHaveValue("2099-02-28");
    await page.screenshot({
      path: `${dir}/after-date-form-${width}.png`,
      fullPage: true,
    });
  }
  // The queue failing on a fresh direct link cannot block the independent detail.
  await page.route("**/api/social/loans", (route) =>
    route.fulfill({ status: 500, body: "{}" })
  );
  await page.goto(`${ORIGIN}/loans/${selected.id}`);
  await expect(heading).toHaveText("Ash K wants to borrow 3 cards");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(page.getByText("Your Loans couldn't be loaded.")).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(deckName);
  await borrower.goto(`${ORIGIN}/loans/${selected.id}`);
  await expect(
    borrower.getByRole("link", { name: deckName, exact: true })
  ).toBeVisible();
  const unrelated = (await collectors.signIn({ next: `/loans/${selected.id}` }))
    .page;
  await expect(unrelated.getByRole("heading", { level: 1 })).toHaveText(
    "Loan not found"
  );
  await expect(unrelated.getByRole("main")).not.toContainText(deckName);
  // A step can move the originating row into History while the detail is open.
  await page.unroute("**/api/social/loans");
  await page.goto(`${ORIGIN}/loans`);
  await row.click();
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  let releaseList = () => {};
  const releasedList = new Promise<void>((resolve) => {
    releaseList = resolve;
  });
  let noteListHeld = () => {};
  const listHeld = new Promise<void>((resolve) => {
    noteListHeld = resolve;
  });
  await page.route("**/api/social/loans", async (route) => {
    const response = await route.fetch();
    noteListHeld();
    await releasedList;
    await route.fulfill({ response });
  });
  await page
    .getByRole("group", { name: "Decline", exact: true })
    .getByRole("button", { name: "Decline", exact: true })
    .click();
  await expect(heading).toHaveText("You declined Ash K's request for 3 cards");
  await listHeld;
  await page.goBack();
  await expect(page).toHaveURL(`${ORIGIN}/loans`);
  await expect(
    page
      .getByRole("region", { name: "Needs you" })
      .locator(`a[href="/loans/${selected.id}"]`)
  ).toBeVisible();
  releaseList();
  await expect(
    main.locator("details").locator(`a[href="/loans/${selected.id}"]`)
  ).toBeFocused();
  await expect(main.locator("details")).toHaveAttribute("open", "");
});
