import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";

for (const width of [375, 1280]) {
  for (const message of [
    "Cards added.",
    "Cards added to the Collection. You can now find all of these copies in Unsorted and move them to a Location when you are ready.",
  ]) {
    test(`last Catalog row clears ${message.length > 30 ? "wrapped" : "short"} feedback at ${width}`, async ({
      browser,
    }) => {
      const context = await browser.newContext({
        viewport: { width, height: 812 },
        hasTouch: width === 375,
      });
      const page = await context.newPage();
      try {
        execFileSync(
          ".venv/bin/python",
          ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
          {
            env: { ...process.env, PYTHONPATH: "api:api/tests" },
          }
        );
        await page.addInitScript((text) => {
          sessionStorage.setItem(
            "prizecheck:scanner:landing",
            JSON.stringify({ message: text, at: Date.now() })
          );
        }, message);
        await signInAsOwner(page, "/catalog");
        const toast = page.getByRole("region", { name: "Notifications" });
        await expect(toast).toContainText(message);
        if (width === 375 && message.length > 30) {
          const lines = await toast.locator("p").evaluate((el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return range.getClientRects().length;
          });
          expect(lines).toBeGreaterThanOrEqual(2);
        }
        const last = page
          .getByRole("region", { name: "Catalog results" })
          .locator("li[data-edition-id]")
          .last();
        await expect(last).toBeVisible();
        const padding = () =>
          page
            .locator("div[data-app-shell]")
            .evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom));
        const shownPadding = await padding();
        if (width === 375) {
          await expect
            .poll(async () => {
              await page.evaluate(() =>
                window.scrollTo(0, document.documentElement.scrollHeight)
              );
              return (
                (await last.boundingBox())!.y +
                (await last.boundingBox())!.height -
                (await toast.boundingBox())!.y
              );
            })
            .toBeLessThanOrEqual(0);
        } else {
          expect(shownPadding).toBe(0);
        }
        await toast
          .getByRole("button", { name: "Dismiss", exact: true })
          .click();
        await expect(toast).toBeEmpty();
        if (width === 375)
          await expect.poll(padding).toBeLessThan(shownPadding);
        else expect(await padding()).toBe(shownPadding);
      } finally {
        await context.close();
      }
    });
  }
}
