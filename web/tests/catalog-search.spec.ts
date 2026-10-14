import { test, expect } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";

test("collector searches a promoted generation and chooses an exact Edition", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({**{f'card-{i}': f'Pikachu {i:02d}' for i in range(1, 66)}, 'card-99': 'Énergie'})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  await page.route("https://assets.tcgdex.net/**", async (route) => {
    if (route.request().url().endsWith("/high.webp"))
      await route.fulfill({ status: 404 });
    else
      await route.fulfill({
        status: 200,
        contentType: "image/png",
        body: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
          "base64"
        ),
      });
  });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("DELETE FROM auth_send_event");
  try {
    await signInAsOwner(page, "/collection");
    await page.getByRole("button", { name: "Catalog", exact: true }).click();
    // Catalog is an Edition gallery (#173): one smart search box, tiles of Card Editions, more tiles load as you scroll past 60.
    const search = page.getByRole("searchbox", { name: "Search the catalog" });
    const results = page.getByRole("region", { name: "Catalog results" });
    const tiles = results.getByRole("listitem");
    await search.fill("Pik");
    await expect(results).toContainText("Showing 60 of 66 cards");
    await expect(tiles).toHaveCount(60);
    await expect(
      results.getByRole("button", {
        name: /^Pikachu 01, fixture 1, Fixture Set, Normal/,
      })
    ).toBeVisible();
    // The gallery loads its next page as its end comes near (#173).
    await tiles.last().scrollIntoViewIfNeeded();
    await expect(tiles).toHaveCount(66);
    // Pikachu 01 has two Editions, so two tiles; either opens the Printing's details.
    await search.fill("Pikachu 01");
    await expect(tiles).toHaveCount(2);
    await results
      .getByRole("button", {
        name: /^Pikachu 01, fixture 1, Fixture Set, Reverse Holo/,
      })
      .click();
    const details = page.getByRole("dialog", { name: "Pikachu 01" });
    await expect(
      details.getByRole("img", { name: "Artwork unavailable for Pikachu 01" })
    ).toBeVisible();
    await expect(
      details.getByText("Artwork belongs to the Printing")
    ).toBeVisible();
    // Each Card Edition is listed by its Variant.
    await expect(details.getByRole("listitem")).toHaveText([
      /^Normal · TCGdex Edition/,
      /^Reverse Holo · TCGdex Edition/,
    ]);
    await details.getByRole("button", { name: "Close card details" }).click();
    await search.fill("Pikachu 02");
    await expect(tiles).toHaveCount(1);
    await expect(tiles).toContainText("Artwork unavailable");
    await tiles.getByRole("button").click();
    await expect(
      page
        .getByRole("dialog", { name: "Pikachu 02" })
        .getByRole("img", { name: "Artwork unavailable for Pikachu 02" })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await search.fill("NoSuchCard");
    await expect(results).toContainText("No cards match this search.");
    await search.fill("Pik");
    await expect(tiles).toHaveCount(60);
    await pool.query("UPDATE catalog_state SET revision=revision+1");
    await tiles.last().scrollIntoViewIfNeeded();
    await expect(page.getByRole("main").getByRole("status")).toContainText(
      "Results refreshed from page one"
    );
    // Page one again, and the next page as the end is still near.
    await expect(tiles).toHaveCount(66);
  } finally {
    await pool.end();
  }
});
