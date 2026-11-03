// #512–514: compact terms and transaction-scoped informational success; persistent Undo is covered by trade-deck-switch.
import { randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import {
  api,
  accountId,
  befriend,
  hold,
  loanStep,
  nameCollector,
  seedCatalog,
  unsorted,
  ORIGIN,
  DESKTOP,
  PHONE,
} from "./support/loans";
import { forTradeLeaf, propose, tradeStep } from "./support/trades";
import { signInAsOwner } from "./support/sign-in";
import { expectPageChecks } from "./support/page-check";

const notice = (page: import("@playwright/test").Page) =>
  page.getByRole("region", { name: "Notifications" });

for (const viewport of [DESKTOP, PHONE]) {
  test(`compact terms and swap feedback stay relevant after navigating to a Loan at ${viewport.width}`, async ({
    page,
    collectors,
  }) => {
    // Two collectors, migrated catalog and several physical-event steps with accessibility checks.
    test.slow();
    await page.setViewportSize(viewport);
    const ids = seedCatalog();
    const friend = await collectors.signIn();
    await nameCollector(friend.page, "Ash K");
    const theirs = await forTradeLeaf(friend.page, "Trade Binder");
    await hold(friend.page, theirs, ids["SVI 166"], 3);
    await signInAsOwner(page, "/trades");
    await nameCollector(page, "Misty W");
    await hold(page, await forTradeLeaf(page, "My Binder"), ids["PAL 185"], 2);
    await befriend(page, friend.page);
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    const swap = await propose(
      page,
      await accountId(friend.page),
      [[ids["PAL 185"], 1]],
      [[ids["SVI 166"], 1]]
    );
    await tradeStep(friend.page, swap, "accept");
    await tradeStep(friend.page, swap, "confirm-swap");
    const loan = await api(page, "POST", "/api/loans", {
      lender_id: await accountId(friend.page),
      lines: [{ edition_id: ids["SVI 166"], quantity: "1" }],
      idempotency_key: randomUUID(),
    });
    await loanStep(friend.page, loan.id, `/api/loans/${loan.id}/accept`, {
      lines: [{ edition_id: ids["SVI 166"], promised: "1" }],
    });
    await loanStep(friend.page, loan.id, `/api/loans/${loan.id}/handover`);

    await page.goto(`${ORIGIN}/trades/${swap}`);
    const main = page.getByRole("main");
    const give = main.getByRole("list", { name: "You give", exact: true });
    const get = main.getByRole("list", { name: "You get", exact: true });
    await expect(give).toContainText("Iono");
    await expect(get).toContainText("Arven");
    await expect(give.getByText("×1", { exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(get.getByText("×1", { exact: true })).toBeInViewport({
      ratio: 1,
    });
    await expect(
      main.getByRole("button", { name: "Confirm swap", exact: true })
    ).toBeInViewport({ ratio: 1 });
    const card = get.getByRole("button", {
      name: "Arven SVI 166 · Normal",
      exact: true,
    });
    await card.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("dialog", { name: "Arven", exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toBeFocused();
    await expectPageChecks(page, "compact one-for-one terms");
    await main
      .getByRole("button", { name: "Confirm swap", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Confirm swap with Ash K?",
    });
    await expect(dialog).toContainText("The swap can't be undone.");
    await expect(
      dialog.getByRole("combobox", { name: "Put the cards you get in" })
    ).toHaveValue("");
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      main.getByRole("button", { name: "Confirm swap", exact: true })
    ).toBeFocused();
    await main
      .getByRole("button", { name: "Confirm swap", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirm swap", exact: true })
      .click();
    await expect(notice(page)).toContainText("Swapped.");
    await expect(notice(page)).toHaveAttribute("aria-live", "polite");
    await expect(
      notice(page).getByRole("button", { name: "Dismiss", exact: true })
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Main views" })
      .getByRole("button", { name: /^Loans/ })
      .click();
    await page.locator(`a[href="/loans/${loan.id}"]`).click();
    await expect(page).toHaveURL(`${ORIGIN}/loans/${loan.id}`);
    await expect(notice(page)).not.toContainText("Swapped.");
    await page
      .getByRole("button", { name: "Yes, I have them", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Give cards back", exact: true })
    ).toBeVisible();
    await expect(notice(page)).not.toContainText("Swapped.");
    await page
      .getByRole("button", { name: "Give cards back", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Give these back", exact: true })
      .click();
    await expect(main).toContainText("Waiting for Ash K to confirm");
    await expect(notice(page)).not.toContainText("Swapped.");

    // A two-for-one with a long name keeps the full identity and Edition at 200% text.
    await hold(friend.page, theirs, ids["PAL 172"], 1);
    const larger = await propose(
      friend.page,
      await accountId(page),
      [
        [ids["SVI 166"], 1],
        [ids["PAL 172"], 1],
      ],
      [[ids["PAL 185"], 1]]
    );
    const longName = "Professor's Research (Professor Sada and Professor Turo)";
    await page.route(`**/api/social/trades/${larger}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.you_get.find(
        (card: { edition_id: string }) => card.edition_id === ids["SVI 166"]
      ).name = longName;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${ORIGIN}/trades/${larger}`);
    await expect(
      main.getByRole("button", {
        name: `${longName} SVI 166 · Normal`,
        exact: true,
      })
    ).toBeVisible();
    await expect(
      main
        .getByRole("list", { name: "You get", exact: true })
        .getByRole("listitem")
    ).toHaveCount(2);
    await page.evaluate(() => {
      for (const name of ["2xs", "xs", "sm", "control", "md", "lg", "xl"]) {
        const key = `--font-size-${name}`;
        const px = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(key)
        );
        document.documentElement.style.setProperty(key, `${px * 2}px`);
      }
    });
    await expectPageChecks(page, "long-name two-for-one at 200% text");
  });
}
