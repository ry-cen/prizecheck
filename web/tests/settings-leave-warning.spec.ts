import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expect, test } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";

for (const phone of [false, true]) {
  test.describe(phone ? "phone" : "desktop", () => {
    test.use({
      viewport: phone
        ? { width: 375, height: 812 }
        : { width: 1280, height: 800 },
      isMobile: phone,
      hasTouch: phone,
    });
    test("unsaved Settings can be kept, discarded, reverted or saved", async ({
      page,
    }) => {
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        await startAsNewOwner(pool);
      } finally {
        await pool.end();
      }
      await signInAsOwner(page, "/settings");
      const name = page.getByRole("textbox", {
        name: "Display Name",
        exact: true,
      });
      await expect(name).toBeVisible();
      const original = await name.inputValue();
      const leave = () =>
        page
          .getByRole("navigation", { name: "Main views" })
          .getByRole("link", { name: "Collection", exact: true })
          .click();
      await page.reload();
      await expect(name).toHaveValue(original);
      await name.fill("Ash K");
      await leave();
      const dialog = page.getByRole("dialog", {
        name: "Discard these Settings changes?",
      });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Keep editing" }).click();
      await expect(name).toHaveValue("Ash K");
      const warning = page.waitForEvent("dialog");
      void page.reload().catch(() => {});
      const prompt = await warning;
      expect(prompt.type()).toBe("beforeunload");
      await prompt.dismiss();
      await expect(name).toHaveValue("Ash K");
      await leave();
      await dialog
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await expect(page).toHaveURL(/\/collection$/);
      await page.goBack();
      await expect(name).toHaveValue(original);
      for (const [label, value] of [
        ["Handle", "ash_changed"],
        ["Zip code", "10001"],
      ]) {
        const field = page.getByRole("textbox", { name: label, exact: true });
        const saved = await field.inputValue();
        await field.fill(value);
        await leave();
        await expect(dialog).toBeVisible();
        await dialog.getByRole("button", { name: "Keep editing" }).click();
        await expect(field).toHaveValue(value);
        await leave();
        await dialog
          .getByRole("button", { name: "Discard", exact: true })
          .click();
        await expect(page).toHaveURL(/\/collection$/);
        await page.goBack();
        await expect(field).toHaveValue(saved);
      }
      const native: string[] = [];
      page.on("dialog", (d) => {
        native.push(d.type());
        void d.dismiss();
      });
      await name.fill("Ash K");
      await name.fill(original);
      await leave();
      await expect(page).toHaveURL(/\/collection$/);
      await page.goBack();
      await name.fill("Ash K");
      await page
        .getByRole("button", { name: "Save name", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Save name", exact: true })
      ).toBeDisabled();
      await expect(
        page.getByRole("status").filter({ hasText: "Display Name saved." })
      ).toBeVisible();
      await page.reload();
      await expect(name).toHaveValue("Ash K");
      await leave();
      await expect(page).toHaveURL(/\/collection$/);
      expect(native).toEqual([]);
    });
  });
}
