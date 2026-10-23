import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

// Settings › Open discovery (Trading #297, Stage 2 spec "Open discovery switch"): the switch, the collector's own zip
// code, the zip changes left, the removed and suspended sentences and the GeoNames credit. Each test starts as a new
// owner, so the setting is off with no zip. The zips are seeded here with upserts (00009 is deleted, so it is
// unknown): no test depends on the generated zip data.

const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const PHONE = {
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
};
const CREDIT =
  "Zip code locations include data from GeoNames (geonames.org), CC BY 4.0.";

async function signIn(page: Page, next = "/collection") {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, next);
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

/** Runs `work` against the test database, closing the pool after it. */
async function withPool<T>(work: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

async function seedZips() {
  await withPool(async (pool) => {
    await pool.query(
      `INSERT INTO zip_centroid (zip, lat, lon, source) VALUES
         ('00010', 40.0, -100.0, 'census'),
         ('00011', 40.1, -100.0, 'census'),
         ('00012', 40.2, -100.0, 'census')
       ON CONFLICT (zip) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, source = EXCLUDED.source`
    );
    await pool.query("DELETE FROM zip_centroid WHERE zip = '00009'");
  });
}

async function ownerId(pool: Pool): Promise<string> {
  const { rows } = await pool.query('SELECT id FROM "user" WHERE email=$1', [
    OWNER_EMAIL,
  ]);
  return rows[0].id;
}

const section = (page: Page) =>
  page.getByRole("region", { name: "Open discovery" });
const toggle = (page: Page) =>
  section(page).getByRole("switch", { name: "Open discovery" });
const zipField = (page: Page) => section(page).getByLabel("Zip code");
const saveZip = (page: Page) =>
  section(page).getByRole("button", { name: "Save zip code" });

/** Seeds the zips, signs in on Settings and switches open discovery on with zip 00010. */
async function switchOn(page: Page) {
  await seedZips();
  await signIn(page, "/settings");
  await zipField(page).fill("00010");
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(section(page).getByRole("status")).toHaveText(
    "Open discovery is on."
  );
}

async function openDiscovery(page: Page, phone: boolean) {
  await seedZips();
  await signIn(page, "/settings");
  await expect(toggle(page)).not.toBeChecked();
  await expect(section(page).getByText(CREDIT)).toBeVisible();
  await zipField(page).fill("00010");
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(section(page).getByRole("status")).toHaveText(
    "Open discovery is on."
  );
  await expect(section(page)).toContainText("Zip code changes left: 3");
  await zipField(page).fill("00011");
  await saveZip(page).click();
  await expect(section(page)).toContainText("Zip code changes left: 2");
  await page.reload();
  await expect(zipField(page)).toHaveValue("00011");
  await expect(toggle(page)).toBeChecked();
  await expect(section(page)).toContainText("Zip code changes left: 2");
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(zipField(page)).toHaveValue("00011");
  await expect(section(page)).toContainText("Zip code changes left: 2");
  await expect(section(page)).not.toContainText(/\bmi\b|\bmiles?\b|radius/i);
  if (phone) await expectTouchTarget(saveZip(page));
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth)
  ).toBeLessThanOrEqual(page.viewportSize()!.width);
}

test("Settings › Open discovery switches on with a zip, counts changes and credits the zip data", async ({
  page,
}) => {
  await openDiscovery(page, false);
  await expectPageChecks(page, "Settings with Open discovery");
});

test.describe("phone, Open discovery", () => {
  test.use(PHONE);

  test("the same at 375 px", async ({ page }) => {
    await openDiscovery(page, true);
  });
});

test("Settings refuses an unknown zip code and a fourth zip change", async ({
  page,
}) => {
  await switchOn(page);
  await zipField(page).fill("00009");
  await saveZip(page).click();
  await expect(section(page).getByRole("alert")).toHaveText(
    "We couldn't find that zip code. Try the zip code where you'd meet."
  );
  await withPool(async (pool) => {
    const id = await ownerId(pool);
    await pool.query(
      `INSERT INTO handle_lookup_event (user_id, kind, created_at)
       SELECT $1, 'zip_change', now() - interval '90 minutes' FROM generate_series(1, 3)`,
      [id]
    );
  });
  await page.reload();
  await expect(section(page)).toContainText("Zip code changes left: 0");
  await zipField(page).fill("00011");
  await saveZip(page).click();
  await expect(section(page).getByRole("alert")).toHaveText(
    "You've changed your zip code 3 times in the last 24 hours. Try again in 23 hours."
  );
});

test("Settings says when open discovery is removed or the account is suspended", async ({
  page,
}) => {
  await switchOn(page);
  const REMOVED = "Open discovery isn't available for your account.";
  await withPool(async (pool) => {
    await pool.query(
      "UPDATE discovery_setting SET enabled=false, removed_at=now() WHERE user_id=$1",
      [await ownerId(pool)]
    );
  });
  await page.reload();
  await expect(section(page)).toContainText(REMOVED);
  await expect(toggle(page)).toBeDisabled();
  await expect(zipField(page)).toHaveCount(0);
  await withPool(async (pool) => {
    await pool.query(
      "UPDATE collector_profile SET suspended_at=now() WHERE user_id=$1",
      [await ownerId(pool)]
    );
  });
  await page.reload();
  await expect(section(page)).toContainText(
    "Your account can't trade or message right now."
  );
  await expect(section(page)).not.toContainText(REMOVED);
  await expect(section(page).getByText(CREDIT)).toBeVisible();
});
