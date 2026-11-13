import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { test, artUpstream } from "./support/art-upstream";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

async function prepare(page: Page) {
  (await artUpstream()).reset();
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/catalog?mode=add");
}
for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`${viewport.width}px failures`, () => {
    test.use({ viewport });
    for (const committed of [false, true]) {
      test(`Add survives reload with response lost, committed=${committed}`, async ({
        page,
      }) => {
        await prepare(page);
        const main = page.locator("main:visible");
        const plus = main
          .getByRole("button", { name: /^One more Bulbasaur/ })
          .first();
        if (viewport.width === 375) await expectTouchTarget(plus);
        await plus.click();
        await plus.click();
        await expect(
          main
            .getByRole("list", { name: "Cards to add" })
            .getByRole("listitem")
            .first()
        ).toHaveCSS("white-space", "normal");
        const requests: {
          idempotency_key: string;
          items: { edition_id: string }[];
        }[] = [];
        await page.route("**/api/holdings/batch", async (route) => {
          requests.push(route.request().postDataJSON());
          if (committed) await route.fetch();
          await route.abort();
        });
        await main
          .getByRole("button", { name: "Add 2 cards", exact: true })
          .click();
        await expect(main).toContainText("Press Add again to check safely");
        await page.unroute("**/api/holdings/batch");
        page.on("dialog", (dialog) => dialog.accept());
        await page.reload();
        await expect(
          main.getByRole("button", { name: "Add 2 cards", exact: true })
        ).toBeEnabled();
        await page.route("**/api/holdings/batch", async (route) => {
          requests.push(route.request().postDataJSON());
          await route.continue();
        });
        await main
          .getByRole("button", { name: "Add 2 cards", exact: true })
          .click();
        await expect(
          main.getByRole("list", { name: "Cards to add" })
        ).toHaveCount(0);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        const response = await page.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/catalog/editions?q=Bulbasaur`
        );
        const body = await response.json();
        expect(
          body.editions.find(
            (e: { edition_id: string }) =>
              e.edition_id === requests[0].items[0].edition_id
          ).owned
        ).toBe(2);
      });
    }
    test("Discard abandons a failed restored Add before adding a different Edition", async ({
      page,
    }) => {
      await prepare(page);
      const main = page.locator("main:visible");
      await main
        .getByRole("button", { name: /^One more Bulbasaur/ })
        .first()
        .click();
      await page.route("**/api/holdings/batch", (route) => route.abort());
      await main
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      await expect(main).toContainText("Press Add again to check safely");
      await page.route("**/api/catalog/editions?*", (route) =>
        new URL(route.request().url()).searchParams.has("printing_id")
          ? route.abort()
          : route.continue()
      );
      page.on("dialog", (dialog) => dialog.accept());
      await page.reload();
      await main
        .getByRole("button", { name: "Discard queue", exact: true })
        .click();
      await expect(main).toContainText("Your earlier add may have finished.");
      await page.unroute("**/api/catalog/editions?*");
      await page.unroute("**/api/holdings/batch");
      await main
        .getByRole("button", { name: /^One more Rare Candy/ })
        .first()
        .click();
      const request = page.waitForRequest(
        (r) =>
          new URL(r.url()).pathname === "/api/holdings/batch" &&
          r.method() === "POST"
      );
      const editionId = await main
        .locator("li[data-edition-id]")
        .filter({
          has: page.getByRole("button", { name: /^One more Rare Candy/ }),
        })
        .first()
        .getAttribute("data-edition-id");
      await main
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      expect((await request).postDataJSON().items).toEqual([
        { edition_id: editionId, quantity: "1" },
      ]);
      await expect(
        main.getByRole("list", { name: "Cards to add" })
      ).toHaveCount(0);
    });
    test("an abandoned Add warning survives another failed Add and its replay", async ({
      page,
    }) => {
      await prepare(page);
      const main = page.locator("main:visible");
      const warning = "Your earlier add may have finished.";
      page.on("dialog", (dialog) => dialog.accept());
      await main
        .getByRole("button", { name: /^One more Bulbasaur/ })
        .first()
        .click();
      await page.reload();
      await page.route("**/api/holdings/batch", async (route) => {
        await route.fetch();
        await route.abort();
      });
      await main
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      await expect(main).toContainText("Press Add again to check safely");
      await page.unroute("**/api/holdings/batch");
      await page.reload();
      await main
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
      await expect(main).toContainText(warning);
      await page.reload();
      await expect(main).toContainText(warning);
      await main
        .getByRole("button", { name: /^One more Rare Candy/ })
        .first()
        .click();
      await page.reload();
      await expect(main).toContainText(warning);
      await page.route("**/api/holdings/batch", async (route) => {
        await route.fetch();
        await route.abort();
      });
      await main
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      await expect(main).toContainText("Press Add again to check safely");
      await page.unroute("**/api/holdings/batch");
      await page.reload();
      await expect(main).toContainText(warning);
      await main
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      await expect(
        main.getByRole("list", { name: "Cards to add" })
      ).toHaveCount(0);
      await expect(main).toContainText(warning);
      await page.reload();
      await expect(main).toContainText(warning);
      await main.getByRole("button", { name: "Dismiss", exact: true }).click();
      await page.reload();
      await expect(main).not.toContainText(warning);
    });
    for (const pending of [false, 0, "", [], { key: "partial" }]) {
      test(`malformed pending ${JSON.stringify(pending)} does not block a new Add`, async ({
        page,
      }) => {
        await prepare(page);
        const main = page.locator("main:visible");
        await main
          .getByRole("button", { name: /^One more Bulbasaur/ })
          .first()
          .click();
        await page.evaluate((value) => {
          const key = Object.keys(sessionStorage).find(
            (k) => k.startsWith("prizecheck:add-queue:") && k.endsWith(":page")
          )!;
          const draft = JSON.parse(sessionStorage.getItem(key)!);
          sessionStorage.setItem(
            key,
            JSON.stringify({ ...draft, pending: value })
          );
        }, pending);
        page.on("dialog", (dialog) => dialog.accept());
        await page.reload();
        await expect(
          main.getByRole("list", { name: "Cards to add" })
        ).toHaveCount(0);
        await main
          .getByRole("button", { name: /^One more Rare Candy/ })
          .first()
          .click();
        await main
          .getByRole("button", { name: "Add 1 card", exact: true })
          .click();
        await expect(
          main.getByRole("list", { name: "Cards to add" })
        ).toHaveCount(0);
      });
    }
    test("search error replaces empty results and recovers", async ({
      page,
    }) => {
      await prepare(page);
      const main = page.locator("main:visible");
      const search = main.getByRole("searchbox", {
        name: "Search the catalog",
      });
      await search.fill("no-card-review-xyz");
      await expect(main).toContainText("No cards match this search.");
      await page.route("**/api/catalog/editions?*", (route) => route.abort());
      await search.fill("Pikachu");
      await expect(main).toContainText(
        "Catalog search is temporarily unavailable"
      );
      await expect(main).not.toContainText("No cards match this search.");
      await expect(main).not.toContainText("no-card-review-xyz");
      await page.unroute("**/api/catalog/editions?*");
      await main.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(main).not.toContainText(
        "Catalog search is temporarily unavailable"
      );
      await expect(main).toContainText("No cards match this search.");
    });
  });
}
