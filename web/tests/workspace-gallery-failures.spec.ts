import { test, expect, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

// The listing endpoint is faked here: these tests are about how the gallery reacts to failures,
// so no catalog or Holdings are seeded.

const LISTING = /\/api\/collection\/holdings(\?|$)/;

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await page
    .getByLabel("Email")
    .fill(process.env.OWNER_EMAIL || "owner@example.test");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
  await page
    .getByLabel("Six-digit code")
    .fill(JSON.parse(messages(mail).at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

const LEAF = "00000000-0000-4000-8000-0000000000a1";

/** A listing row for a fake Holding of `quantity` copies. */
const row = (n: number, quantity: number) => ({
  edition_id: `00000000-0000-4000-8000-00000000000${n}`,
  quantity: String(quantity),
  version: 1,
  printing_id: `00000000-0000-4000-8000-0000000001${n}0`,
  printing_name: `Fake Card ${n}`,
  set_id: "fake",
  set_name: "Fake Set",
  collector_number: String(n),
  descriptor: { finish: "normal" },
  image_url: null,
  location_id: LEAF,
  location_name: "Fake Binder",
  location_path: "Fake Shelf / Fake Binder",
});

/** One page of the listing. The first page carries the totals for the whole listing, which
 * size the grid, so `totalCopies` counts the copies on all pages. */
const pageBody = (
  rows: ReturnType<typeof row>[],
  nextCursor: string | null,
  totalCopies: number | null
) => ({
  holdings: rows,
  owner_revision: 1,
  catalog_revision: 1,
  next_cursor: nextCursor,
  totals:
    totalCopies === null
      ? null
      : { holdings: 2, editions: 2, copies: String(totalCopies) },
});

const ok = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: "application/json", json: body });
const fail = (route: Route, status: number, detail: unknown = {}) =>
  route.fulfill({
    status,
    contentType: "application/json",
    json: { detail },
  });

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) =>
  cards(page).getByRole("button", { name: /^Fake Card/ });

test("a failed first page shows the unavailable message, and Retry loads the tiles", async ({
  page,
}) => {
  await signIn(page);
  let requests = 0;
  await page.route(LISTING, (route) =>
    ++requests === 1
      ? fail(route, 500)
      : ok(route, pageBody([row(1, 2)], null, 2))
  );
  await page.reload();

  await expect(
    page.getByText("Cards are temporarily unavailable.")
  ).toBeVisible();
  await expect(tiles(page)).toHaveCount(0);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(tiles(page)).toHaveCount(2);
  await expect(
    page.getByText("Cards are temporarily unavailable.")
  ).toHaveCount(0);
});

test("a stale cursor restarts the walk from the first page", async ({
  page,
}) => {
  await signIn(page);
  let firstPages = 0;
  let conflicts = 0;
  await page.route(LISTING, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (!cursor) {
      firstPages++;
      // Page 1 always points at a page 2; only the first page 2 reports the change.
      return ok(
        route,
        pageBody([row(1, 1)], conflicts === 0 ? "cursor-1" : "cursor-2", 3)
      );
    }
    if (cursor === "cursor-1") {
      conflicts++;
      return fail(route, 409, { code: "INVENTORY_CHANGED" });
    }
    return ok(route, pageBody([row(2, 2)], null, null));
  });
  await page.reload();

  await expect(tiles(page)).toHaveCount(3);
  expect(conflicts).toBe(1);
  expect(firstPages).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed later page keeps the loaded tiles and says some cards couldn't be loaded", async ({
  page,
}) => {
  await signIn(page);
  await page.route(LISTING, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return cursor
      ? fail(route, 500)
      : ok(route, pageBody([row(1, 2)], "cursor-1", 4));
  });
  await page.reload();

  await expect(page.getByText("Some cards couldn't be loaded.")).toBeVisible();
  await expect(tiles(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
});
