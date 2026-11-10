import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { test, artUpstream } from "./support/art-upstream";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { expectPageChecks } from "./support/page-check";

const EMAIL = `${"collector".repeat(8)}@example.test`;
const NAME = "Alexandria".repeat(8);

async function signIn(page: Page, next: string) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, next);
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width}px layout regressions`, () => {
    test.use({ viewport });

    test("friend names stay readable and disabled Add cards uses neutral colours", async ({
      page,
    }) => {
      (await artUpstream()).reset();
      execFileSync(
        ".venv/bin/python",
        ["-c", "from test_catalog_browse import seed_popup; seed_popup()"],
        {
          env: { ...process.env, PYTHONPATH: "api:api/tests" },
        }
      );
      const friend = {
        collector_id: "layout-friend",
        handle: "sam_okafor",
        display_name: "Sam Okafor",
        edition_id: "layout-edition",
        name: "Bulbasaur",
        set_code: "MEG",
        set_name: "Mega Evolution",
        collector_number: "001",
        descriptor: { finish: "normal" },
        other_printing: false,
        spare: "2",
        in_deck: "1",
        copies: "2",
        image_url: null,
      };
      await page.route("**/api/social/card-matches?*", (route) =>
        route.fulfill({ json: { has_friends: true, copies: [friend] } })
      );
      await page.route("**/api/social/trade-card-matches?*", (route) =>
        route.fulfill({ json: { has_friends: true, offers: [friend] } })
      );
      await page.route("**/api/catalog/editions**", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        if (Array.isArray(body.editions)) {
          body.editions = body.editions.map(
            (edition: Record<string, unknown>) => ({
              ...edition,
              regulation_mark: null,
              standing: {
                standard: {
                  status: "unknown",
                  reasons: ["regulation mark not recorded"],
                },
                expanded: {
                  status: "unknown",
                  reasons: ["regulation mark not recorded"],
                },
                glc: { status: "legal", reasons: [] },
              },
            })
          );
        }
        await route.fulfill({ response, json: body });
      });
      await signIn(page, "/catalog");
      const results = page.getByRole("region", { name: "Catalog results" });
      await results
        .getByRole("button", {
          name: /^Bulbasaur, MEG 001, Mega Evolution, Normal/,
        })
        .click();
      const popup = page.getByRole("dialog", { name: "Bulbasaur" });
      for (const label of [
        "Friends who have this",
        "Friends with this on their Trade List",
      ]) {
        const name = popup
          .getByRole("list", { name: label, exact: true })
          .locator("li > span")
          .first();
        await expect(name).toContainText("Sam Okafor");
        await expect
          .poll(
            () =>
              name.evaluate((element) => element.getBoundingClientRect().width),
            `${label}: name has room to read`
          )
          .toBeGreaterThanOrEqual(100);
      }
      await expect(
        popup.getByText("Standard and Expanded legality unknown", {
          exact: true,
        })
      ).toHaveCount(1);
      await expect(popup).toContainText("GLC: Legal");
      await expect(popup).not.toContainText("regulation mark not recorded");
      await expect(popup).not.toContainText("No regulation mark recorded");
      await expectPageChecks(page, "Catalog popup with Friend actions");
      await popup
        .getByRole("button", { name: "Close card details", exact: true })
        .click();
      await page
        .getByRole("radio", { name: "Add to a Location", exact: true })
        .click();
      const bar = page.getByRole("region", {
        name: "Add to a Location",
        exact: true,
      });
      const disabled = bar.getByRole("button", {
        name: "Add cards",
        exact: true,
        includeHidden: true,
      });
      await expect(disabled).toBeDisabled();
      await expect(disabled).toHaveCSS("opacity", "1");
      const neutral = await disabled.evaluate((element) => {
        const style = getComputedStyle(element);
        const linear = (v: number) => {
          const n = v / 255;
          return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
        };
        const luminance = (colour: string) => {
          const values = colour
            .match(/[\d.]+/g)!
            .map(Number)
            .map(linear);
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
        };
        const fg = luminance(style.color),
          bg = luminance(style.backgroundColor);
        return {
          background: style.backgroundColor,
          contrast: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05),
        };
      });
      expect(neutral.contrast).toBeGreaterThanOrEqual(4.5);
      await results
        .getByRole("button", {
          name: "One more Bulbasaur MEG 001 Normal",
          exact: true,
        })
        .click();
      const enabled = bar.getByRole("button", {
        name: "Add 1 card",
        exact: true,
      });
      await expect(enabled).toBeEnabled();
      await expect(enabled).not.toHaveCSS(
        "background-color",
        neutral.background
      );
      await expectPageChecks(page, "Catalog Add mode");
    });

    test("long account email and Display Name stay within Settings and Account", async ({
      page,
    }) => {
      await signIn(page, "/settings");
      await page.route("**/auth/session", async (route) => {
        const response = await route.fetch();
        await route.fulfill({
          response,
          json: { ...(await response.json()), email: EMAIL, name: NAME },
        });
      });
      await page.reload();
      await expect(
        page.getByRole("region", { name: "Your sign-ins" })
      ).toContainText(EMAIL);
      await expectPageChecks(page, "Settings with long account email");
      if (viewport.width === 375) {
        await page
          .getByRole("button", { name: "Account", exact: true })
          .click();
        const sheet = page.getByRole("dialog", {
          name: "Account",
          exact: true,
        });
        await expect(sheet).toContainText(EMAIL);
        await expect(sheet).toContainText(NAME);
        await expect
          .poll(() =>
            sheet.evaluate(
              (element) => element.scrollWidth - element.clientWidth
            )
          )
          .toBeLessThanOrEqual(0);
        await expectPageChecks(page, "Account sheet with long email and name");
      }
    });
  });
}
