import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

// Hill-climb m13 s2 (Sol m12 B-03): coming back to a Want List whose prices, Friends' cards and Trade Wants arrive
// after the restore's usual wait still lands on the place that was left.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function python(code: string, argument: object = {}): string {
  const path = `${process.env.TMPDIR || "/tmp"}/deck-view-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

/** The price spec's catalog with a fresh $0.25 quote on its normal and reverse Editions. */
function editions(): { iono: string; other: string } {
  const out = python(`import json
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(0)))`);
  const ids = JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5)) as {
    normal: string;
    "reverse-holofoil": string;
  };
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  python(
    `import json, sys
from test_prices import ui_apply
ui_apply(json.load(open(sys.argv[1])))`,
    [ids.normal, ids["reverse-holofoil"]].map((edition) => ({
      op: "quote",
      edition,
      amount: "0.25",
      updated: ago(1),
      checked: ago(0.1),
    }))
  );
  return { iono: ids.normal, other: ids["reverse-holofoil"] };
}

async function api(
  page: Page,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function createDeck(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  return created.location.id as string;
}

async function setLine(
  page: Page,
  deckId: string,
  edition: string,
  quantity: number
) {
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  await api(page, "POST", `/api/decks/${deckId}/deck-list/changes`, {
    revision: detail.deck_list.revision,
    idempotency_key: randomUUID(),
    changes: [{ edition_id: edition, quantity: String(quantity) }],
  });
}

test.afterEach(async () => {
  // ui_world activates a matching rule that verifies new Editions' mappings; later specs on this stack seed their own.
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 800, phone: false },
  { name: "phone", width: 375, height: 812, phone: true },
]) {
  test(`${viewport.name}: Back to a Want List whose Trade Wants come late keeps the place left`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.abort()
    );
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
    await signInAsOwner(page, "/decks");
    await page.clock.install();
    const { iono, other } = editions();
    for (const name of ["Practice", "Weekend"]) {
      const deck = await createDeck(page, name);
      await setLine(page, deck, iono, 4);
      await setLine(page, deck, other, 3);
    }
    await api(page, "PUT", `/api/trade-wants/${iono}`, { quantity: "2" });
    await api(page, "PUT", `/api/trade-wants/${other}`, { quantity: "1" });
    let returning = false;
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldSeen = new Promise<void>((resolve) => {
      held = resolve;
    });
    // The Trade Wants stay unanswered past the restore's wait (RESTORE_WINDOW_MS), which the page clock jumps over.
    await page.route("**/api/trade-wants", async (route) => {
      if (returning && route.request().method() === "GET") {
        held();
        await gate;
      }
      await route.continue();
    });
    try {
      const firstCost = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/want-list/cost"
      );
      await page.goto(`${ORIGIN}/decks/want-list`);
      await firstCost;
      const wants = page.getByRole("region", {
        name: "Trade Wants",
        exact: true,
      });
      await expect(
        wants.getByRole("list", { name: "Your Trade Wants" })
      ).toBeVisible();
      await expect(page.getByText(/\$0\.25 each/).first()).toBeVisible();
      await wants.scrollIntoViewIfNeeded();
      await page.evaluate(() => window.scrollBy(0, 200));
      const saved = await page.evaluate(() => window.scrollY);
      expect(saved).toBeGreaterThan(viewport.height);
      await page
        .getByRole("navigation", { name: "Main views" })
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(page).toHaveURL(/\/catalog/);
      returning = true;
      await page.goBack();
      await expect(page).toHaveURL(/\/decks\/want-list/);
      await heldSeen;
      // Prices are in, so no price timer is left to jump over; only the Trade Wants are missing.
      await expect(page.getByText(/\$0\.25 each/).first()).toBeVisible();
      await page.clock.fastForward(6000);
      release();
      await expect(
        wants.getByRole("list", { name: "Your Trade Wants" })
      ).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(saved);
    } finally {
      release();
    }
  });
}
