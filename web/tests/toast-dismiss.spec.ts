import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, expect } from "./support/collectors";
import {
  api,
  accountId,
  befriend,
  hold,
  nameCollector,
  seedCatalog,
  unsorted,
  ORIGIN,
} from "./support/loans";
import { signInAsOwner } from "./support/sign-in";

// Confirmation toasts with no Undo (or other action) fade after about 5 s and clear on a new page, so they stop
// covering the next button (m10 finding M10A-1). A toast with Undo keeps its timing. A phone: 375×812, touch.

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

const LIFETIME = 5000;

test("Borrow Request accepted fades after about 5 s and no longer covers Mark as handed over", async ({
  page,
  collectors,
}) => {
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
  await page.clock.install();
  await page.goto(`${ORIGIN}/loans/${sent.id}`);
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications).toContainText("Borrow Request accepted.");
  await page.clock.fastForward(LIFETIME - 1000);
  await expect(notifications).toContainText("Borrow Request accepted.");
  await page.clock.fastForward(1000);
  await expect(notifications).toBeEmpty();
  // The tap lands on the button: nothing is drawn over it any more.
  await page
    .getByRole("button", { name: "Mark as handed over", exact: true })
    .click();
  await expect(notifications).toContainText("Marked as handed over.");
});

test("a confirmation clears when the page changes, and one shown with its own page stays", async ({
  page,
}) => {
  await page.addInitScript(() => {
    sessionStorage.setItem(
      "prizecheck:scanner:landing",
      JSON.stringify({ message: "Cards added.", at: Date.now() })
    );
  });
  await page.clock.install();
  await signInAsOwner(page, "/catalog");
  const notifications = page.getByRole("region", { name: "Notifications" });
  // The landing toast is shown as the page opens, and stays for its own page.
  await expect(notifications).toContainText("Cards added.");
  await page.clock.fastForward(LIFETIME - 1000);
  await expect(notifications).toContainText("Cards added.");
  await page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("link", { name: "Decks" })
    .click();
  await expect(page).toHaveURL(/\/decks/);
  await expect(notifications).toBeEmpty();
});

test("a toast with Undo is still up after 5 s, once its popup has closed", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  await page.clock.install();
  await signInAsOwner(page, "/catalog");
  await page
    .getByRole("region", { name: "Catalog results" })
    .getByRole("button", { name: /^Switch,/ })
    .click();
  const popup = page.getByRole("dialog");
  await popup.getByRole("button", { name: "Add 1", exact: true }).click();
  await expect(
    popup.getByRole("button", { name: "Undo", exact: true })
  ).toBeVisible();
  // The popup's own Undo asks whether the toast is still up, so the toast outlasts its time while the popup owns it.
  await page.clock.fastForward(LIFETIME * 2);
  await expect(
    popup.getByRole("button", { name: "Undo", exact: true })
  ).toBeVisible();
  await popup.getByRole("button", { name: /^Close/ }).click();
  const notifications = page.getByRole("region", { name: "Notifications" });
  await expect(notifications).toContainText("Added 1 card to Unsorted.");
  await page.clock.fastForward(LIFETIME * 2);
  await expect(
    notifications.getByRole("button", { name: "Undo", exact: true })
  ).toBeVisible();
});
