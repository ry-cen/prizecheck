import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";

test("catalog review compares manual Printings and incoming variant descriptors", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'comparison-1':'Incoming Pikachu','comparison-2':'Variant Pikachu'})`,
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
    }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await signInAsOwner(page, "/collection");
    await expect(
      page.getByRole("navigation", { name: "Main views" })
    ).toBeVisible();
    const user = (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [
        process.env.OWNER_EMAIL || "owner@example.test",
      ])
    ).rows[0].id;
    await pool.query(
      "INSERT INTO inventory_owner(user_id) VALUES($1) ON CONFLICT DO NOTHING",
      [user]
    );
    await pool.query(
      "INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET user_id=$1",
      [user]
    );
    for (const [source, kind, candidate] of [
      [
        "comparison-1",
        "source_match",
        {
          name: "Incoming Pikachu",
          set_id: "fixture",
          set_name: "Fixture Set",
          collector_number: "1",
          manual_printings: [
            null,
            false,
            7,
            "invalid",
            [],
            {
              id: "manual",
              name: "Manual Pikachu",
              set_name: "Fixture Set",
              collector_number: { malformed: true },
            },
          ],
        },
      ],
      [
        "comparison-2",
        "variant_ambiguity",
        {
          name: "Variant Pikachu",
          descriptors: [
            null,
            false,
            7,
            "invalid",
            [],
            { finish: "holo", stamp: ["first-edition"] },
          ],
          metadata: {
            unknown_fields: { variants: [{ unclassifiedFacet: "galaxy" }] },
          },
        },
      ],
    ] as const) {
      await pool.query(
        "INSERT INTO catalog_review(printing_id,source_id,kind,source_fingerprint,detail,candidate) SELECT id,source_id,$2,'comparison-review','Compare incoming evidence',$3 FROM catalog_printing WHERE source_id=$1",
        [source, kind, JSON.stringify(candidate)]
      );
    }
    await page.reload();
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Owner controls" }).click();
    await page.getByRole("tab", { name: /^Catalog/ }).click();
    await expect(page).toHaveURL(/\/owner\/catalog$/);
    const queue = page.getByRole("region", {
      name: "Catalog reconciliation",
      exact: true,
    });
    await queue
      .getByRole("button", { name: /^Review .* · comparison-1$/ })
      .click();
    const manual = queue.getByRole("region", {
      name: "Manual Printing",
      exact: true,
    });
    await expect(
      manual.getByRole("cell", { name: "Manual Pikachu", exact: true })
    ).toBeVisible();
    await expect(
      manual.getByRole("cell", { name: "Incoming Pikachu", exact: true })
    ).toBeVisible();
    await expect(
      manual
        .getByRole("row")
        .filter({ hasText: "Manual Pikachu" })
        .getByText("Differs", { exact: true })
    ).toBeVisible();
    await expect(
      manual
        .getByRole("row")
        .filter({ hasText: "Collector number" })
        .getByRole("cell", { name: "—", exact: true })
    ).toBeVisible();
    await expect(
      manual.getByText("[object Object]", { exact: true })
    ).toHaveCount(0);
    await expect(
      manual.getByRole("cell", { name: "Set ID", exact: true })
    ).toHaveCount(0);
    await expect(
      queue.getByRole("region", { name: "Incoming change", exact: true })
    ).toHaveCount(0);
    await queue
      .getByRole("button", { name: /^Review .* · comparison-2$/ })
      .click();
    const variants = queue.getByRole("region", {
      name: "Variants",
      exact: true,
    });
    await expect(
      variants.getByRole("columnheader", { name: "Recorded", exact: true })
    ).toBeVisible();
    await expect(
      variants.getByRole("columnheader", { name: "Incoming", exact: true })
    ).toBeVisible();
    await expect(
      variants.getByRole("cell", { name: "Normal", exact: true })
    ).toBeVisible();
    await expect(
      variants.getByRole("cell", { name: "Holo, First Edition", exact: true })
    ).toBeVisible();
    await expect(
      queue.getByText("The incoming record has unclassified variant fields.", {
        exact: true,
      })
    ).toBeVisible();
  } finally {
    await pool.end();
  }
});
