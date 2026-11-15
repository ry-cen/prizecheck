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
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

function watchConfirmations() {
  const messages: string[] = [];
  Object.assign(window, { loanConfirmations: messages });
  const host = document.querySelector("#app-toasts")!;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          const text = node.querySelector("p")?.textContent;
          if (text) messages.push(text);
        }
      }
    }
  }).observe(host, { childList: true });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  for (const lost of [false, true]) {
    test(`Loan confirmations occur once at ${viewport.width} (lost accept=${lost})`, async ({
      page,
      collectors,
    }) => {
      await page.setViewportSize(viewport);
      const ids = seedCatalog();
      const borrower = await collectors.signIn();
      await nameCollector(borrower.page, "Ash K");
      await signInAsOwner(page, "/loans");
      await nameCollector(page, "Misty W");
      await befriend(page, borrower.page);
      await hold(page, await unsorted(page), ids["PAL 185"], 1);
      const sent = await api(borrower.page, "POST", "/api/loans", {
        lender_id: await accountId(page),
        lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
        idempotency_key: randomUUID(),
      });
      await page.goto(`${ORIGIN}/loans/${sent.id}`);
      await expect(
        page.getByRole("button", { name: "Accept", exact: true })
      ).toBeVisible();
      await page.evaluate(watchConfirmations);
      if (lost) {
        await page.route(/\/api\/loans\/[^/]+\/accept$/, async (route) => {
          await route.fetch();
          await route.abort("failed");
          await page.unroute(/\/api\/loans\/[^/]+\/accept$/);
        });
      }
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      const notifications = page.getByRole("region", { name: "Notifications" });
      if (lost) {
        await expect(
          page.getByRole("button", { name: "Retry request", exact: true })
        ).toBeVisible();
        await expect(notifications).not.toContainText(
          "Borrow Request accepted."
        );
        await page
          .getByRole("button", { name: "Retry request", exact: true })
          .click();
      }
      await expect(notifications).toContainText("Borrow Request accepted.");
      await page
        .getByRole("button", { name: "Mark as handed over", exact: true })
        .click();
      await expect(notifications).toContainText("Marked as handed over.");
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, "loanConfirmations"))
        )
        .toEqual(["Borrow Request accepted.", "Marked as handed over."]);
      await loanStep(borrower.page, sent.id, "handover");
      await page.reload();
      await expect(
        page.getByRole("button", { name: "All back", exact: true })
      ).toBeVisible();
      await page.evaluate(watchConfirmations);
      await page.getByRole("button", { name: "All back", exact: true }).click();
      await expect(notifications).toContainText("Return recorded.");
      await expect
        .poll(() =>
          page.evaluate(() => Reflect.get(window, "loanConfirmations"))
        )
        .toEqual(["Return recorded."]);
      await expect(page.getByRole("main")).not.toContainText("It was sent.");
    });
  }
}
