// Catalog polish (m13 s4): the card dialog and the Catalog page use collector words ("My card reports", "Printing
// details", never "metadata"), and the owned count sits on the tile's Names line, clear of the card's artwork, so it
// can't cover the HP or anything else printed on the card. At 1280×800 and 375×812.
import { expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { startAsNewOwner } from "./support/owner";
import { expectTouchTarget } from "./support/touch-target";
import { test, artUpstream } from "./support/art-upstream";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

function python(code: string) {
  execFileSync(".venv/bin/python", ["-c", code], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
  });
}
/** Bulbasaur Normal and Reverse Holo, Rare Candy, Switch, Professor's Research. */
const seedPopup = () =>
  python("from test_catalog_browse import seed_popup\nseed_popup()");

async function signIn(page: Page) {
  (await artUpstream()).reset();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/catalog");
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Catalog");
}
const results = (page: Page) =>
  page.getByRole("region", { name: "Catalog results" });
const tile = (page: Page, start: string): Locator =>
  results(page).getByRole("button", {
    name: new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
const mode = (page: Page, name: string) =>
  page
    .getByRole("radiogroup", { name: "Catalog mode" })
    .getByRole("radio", { name });
const more = (page: Page, words: string) =>
  results(page).getByRole("button", {
    name: `One more ${words}`,
    exact: true,
  });
const BULBASAUR = "Bulbasaur MEG 001 Normal";
const BULBASAUR_TILE = "Bulbasaur, MEG 001, Mega Evolution, Normal";
const SWITCH_TILE = "Switch, MEG 130";
const card = (page: Page) => page.getByRole("dialog");

for (const viewport of [
  { width: 1280, height: 800, touch: false },
  { width: 375, height: 812, touch: true },
]) {
  test.describe(`catalog polish at ${viewport.width}×${viewport.height}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.touch,
    });
    const press = (locator: Locator) =>
      viewport.touch ? locator.tap() : locator.click();

    test("the Catalog page, its card dialog, the report form and My card reports say nothing about metadata", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      // What a collector can see (innerText leaves out the closed reports dialog's own contents).
      await expect(page.locator("main:visible")).not.toHaveText(/metadata/i, {
        useInnerText: true,
      });
      await expect(
        page.getByRole("button", { name: "My card reports" })
      ).toBeVisible();
      await expect(page.getByRole("button", { name: /metadata/i })).toHaveCount(
        0
      );
      await press(tile(page, SWITCH_TILE));
      const dialog = card(page);
      await expect(dialog).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Report this Edition" })
      ).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: "Report Printing details" })
      ).toBeVisible();
      await expect(dialog).not.toHaveText(/metadata/i, { useInnerText: true });
      await expect(
        dialog.getByRole("button", { name: /metadata/i })
      ).toHaveCount(0);

      // The report form, both kinds.
      await press(dialog.getByRole("button", { name: "Report this Edition" }));
      const form = dialog.getByRole("region", { name: "Report card details" });
      await expect(form).toBeVisible();
      await expect(
        form.getByRole("heading", { name: "Report card details for Switch" })
      ).toBeVisible();
      await press(
        dialog.getByRole("button", { name: "Report Printing details" })
      );
      await expect(form).toBeVisible();
      await expect(dialog).not.toHaveText(/metadata/i, { useInnerText: true });

      // My card reports: its empty state, and the page behind it.
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await press(page.getByRole("button", { name: "My card reports" }));
      const mine = page.getByRole("dialog", { name: "My card reports" });
      await expect(mine).toBeVisible();
      await expect(
        mine.getByRole("region", { name: "My card reports" })
      ).toBeVisible();
      await expect(mine.getByText("No card reports yet.")).toBeVisible();
      await expect(mine).not.toHaveText(/metadata/i, { useInnerText: true });
    });

    test("the owned count sits on the Names line, never on the artwork or the stepper", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      await press(mode(page, "Add to a Location"));
      await press(more(page, BULBASAUR));
      await press(
        page
          .getByRole("region", { name: "Add to a Location" })
          .getByRole("button", { name: "Add 1 card" })
      );
      const owned = tile(page, BULBASAUR_TILE);
      await expect(owned).toHaveAccessibleName(
        "Bulbasaur, MEG 001, Mega Evolution, Normal, 1 owned"
      );
      for (const queued of [false, true]) {
        if (queued) await press(more(page, BULBASAUR));
        const badge = owned.locator("[data-owned-badge]");
        const art = owned.locator("[data-tile-art]");
        await expect(badge).toHaveText(queued ? "×1 owned" : "×1");
        const [b, a, t] = await Promise.all([
          badge.boundingBox(),
          art.boundingBox(),
          owned.boundingBox(),
        ]);
        expect(b && a && t).toBeTruthy();
        // Clear of the whole artwork (so clear of the HP printed in its top right corner), and inside the tile.
        expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height);
        expect(b!.x).toBeGreaterThanOrEqual(t!.x);
        expect(b!.x + b!.width).toBeLessThanOrEqual(t!.x + t!.width);
        expect(b!.y + b!.height).toBeLessThanOrEqual(t!.y + t!.height);
        if (queued)
          for (const control of [
            more(page, BULBASAUR),
            results(page).getByRole("button", {
              name: `One fewer ${BULBASAUR}`,
              exact: true,
            }),
          ]) {
            if (viewport.touch) await expectTouchTarget(control);
            const c = await control.boundingBox();
            expect(c).toBeTruthy();
            expect(
              b!.x + b!.width <= c!.x ||
                c!.x + c!.width <= b!.x ||
                b!.y + b!.height <= c!.y ||
                c!.y + c!.height <= b!.y
            ).toBe(true);
          }
      }
      // Browse mode puts it in the same place: the badge doesn't hop onto the art when the mode changes.
      await press(mode(page, "Browse"));
      const [browseBadge, browseArt] = await Promise.all([
        owned.locator("[data-owned-badge]").boundingBox(),
        owned.locator("[data-tile-art]").boundingBox(),
      ]);
      expect(browseBadge && browseArt).toBeTruthy();
      expect(browseBadge!.y).toBeGreaterThanOrEqual(
        browseArt!.y + browseArt!.height
      );
      // The tile's own size doesn't change with the badge: no horizontal overflow on the page.
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth
        )
      ).toBe(true);
    });
  });
}
