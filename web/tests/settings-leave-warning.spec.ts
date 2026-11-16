import { randomInt } from "node:crypto";
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
    test("unsaved Settings survive navigation and warn only before reload", async ({
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
      await expect(page).toHaveURL(/\/collection$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goBack();
      await expect(name).toHaveValue("Ash K");
      const warning = page.waitForEvent("dialog");
      void page.reload().catch(() => {});
      const prompt = await warning;
      expect(prompt.type()).toBe("beforeunload");
      await prompt.dismiss();
      await expect(name).toHaveValue("Ash K");
      await name.fill(original);
      for (const [label, value] of [
        ["Handle", "ash_changed"],
        ["Zip code", "10001"],
      ]) {
        const field = page.getByRole("textbox", { name: label, exact: true });
        const saved = await field.inputValue();
        await field.fill(value);
        await leave();
        await expect(page).toHaveURL(/\/collection$/);
        await expect(page.getByRole("dialog")).toHaveCount(0);
        const warning = page.waitForEvent("dialog");
        void page.reload().catch(() => {});
        const prompt = await warning;
        expect(prompt.type()).toBe("beforeunload");
        await prompt.dismiss();
        await page.goBack();
        await expect(field).toHaveValue(value);
        await field.fill(saved);
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
    for (const field of ["Display Name", "Handle", "Zip code"] as const) {
      for (const editAgain of [false, true]) {
        test(`${field}: delayed save across navigation ${editAgain ? "preserves a subsequent edit" : "returns clean"}`, async ({
          page,
        }) => {
          const pool = new Pool({ connectionString: process.env.DATABASE_URL });
          try {
            await startAsNewOwner(pool);
          } finally {
            await pool.end();
          }
          await signInAsOwner(page, "/settings");
          const input = page.getByRole("textbox", { name: field, exact: true });
          await expect(input).toBeVisible();
          const tail = Array.from(
            { length: 10 },
            () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
          ).join("");
          const value =
            field === "Display Name"
              ? "Ash K"
              : field === "Handle"
                ? `ash_${tail}`
                : "10001";
          const newer =
            field === "Zip code"
              ? "10002"
              : field === "Handle"
                ? `ash_${tail}x`
                : "Misty W";
          const button = page.getByRole("button", {
            name:
              field === "Display Name"
                ? "Save name"
                : field === "Handle"
                  ? "Save Handle"
                  : "Save zip code",
            exact: true,
          });
          const endpoint =
            field === "Zip code"
              ? "/api/social/discovery"
              : field === "Handle"
                ? "/api/profile/handle"
                : "/api/profile/display-name";
          let release!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let captured!: () => void;
          const held = new Promise<void>((resolve) => {
            captured = resolve;
          });
          const pattern = `**${endpoint}`;
          await page.route(pattern, async (route) => {
            if (route.request().method() !== "PUT") {
              await route.continue();
              return;
            }
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            captured();
            await released;
            await route.fulfill({ response });
          });
          const leave = () =>
            page
              .getByRole("navigation", { name: "Main views" })
              .getByRole("link", { name: "Collection", exact: true })
              .click();
          try {
            await input.fill(value);
            await button.click();
            await held;
            await leave();
            await expect(page).toHaveURL(/\/collection$/);
            await expect(page.getByRole("dialog")).toHaveCount(0);
            const warning = page.waitForEvent("dialog");
            void page.reload().catch(() => {});
            const prompt = await warning;
            expect(prompt.type()).toBe("beforeunload");
            await prompt.dismiss();
            await page.goBack();
            await expect(input).toHaveValue(value);
            if (editAgain) await input.fill(newer);
            const received = page.waitForResponse(
              (response) =>
                response.url().endsWith(endpoint) &&
                response.request().method() === "PUT"
            );
            release();
            await received;
            await expect(
              page.getByRole("status").filter({
                hasText:
                  field === "Display Name"
                    ? "Display Name saved."
                    : field === "Handle"
                      ? "Handle saved."
                      : "Zip code saved.",
              })
            ).toBeVisible();
            await expect(input).toHaveValue(editAgain ? newer : value);
            if (editAgain) await expect(button).toBeEnabled();
            else await expect(button).toBeDisabled();
            await leave();
            await expect(page).toHaveURL(/\/collection$/);
            await expect(page.getByRole("dialog")).toHaveCount(0);
            await page.goBack();
            await expect(input).toHaveValue(editAgain ? newer : value);
            if (editAgain) {
              await input.fill(value);
              await expect(button).toBeDisabled();
            }
          } finally {
            release();
            await page.unroute(pattern);
          }
        });
      }
    }
  });
}
