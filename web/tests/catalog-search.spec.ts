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
promote({**{f'card-{i}': f'Pikachu {i:02d}' for i in range(1, 33)}, 'card-99': 'Énergie'})`,
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
    await page.getByLabel("English name").fill("Pik");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".catalog-results > li")).toHaveCount(30);
    await expect(
      page.getByRole("img", { name: "Pikachu 01 card art" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator(".catalog-results > li")).toHaveCount(2);
    await page.getByLabel("English name").fill("Pikachu 01");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".catalog-results > li")).toHaveCount(1);
    await page.getByRole("button", { name: "View Editions" }).click();
    await expect(
      page.getByRole("img", { name: "Artwork unavailable for Pikachu 01" })
    ).toBeVisible();
    await expect(
      page.getByText("Artwork belongs to the Printing")
    ).toBeVisible();
    await page.getByRole("button", { name: "finish: normal" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Selected Edition: finish: normal"
    );
    await page.getByRole("button", { name: "Back to results" }).click();
    await page.getByLabel("English name").fill("Pikachu 02");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(
      page.getByRole("img", { name: "Artwork unavailable for Pikachu 02" })
    ).toBeVisible();
    await page.getByLabel("English name").fill("NoSuchCard");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.getByText("No matching Printings.")).toBeVisible();
    await page.getByLabel("English name").fill("Pik");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".catalog-results > li")).toHaveCount(30);
    await pool.query("UPDATE catalog_state SET revision=revision+1");
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Results refreshed from page one"
    );
    await expect(page.locator(".catalog-results > li")).toHaveCount(30);
  } finally {
    await pool.end();
  }
});
