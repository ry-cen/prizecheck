import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type World = {
  prefix: string;
  tokens: { Legal: string; Over: string; Orphan: string; deck: string };
};

/** Replaces the catalog and publishes `<prefix> Legal|Over|Orphan` for `owner` (page_world). */
function pageWorld(owner: string): World {
  const prefix = `Page ${randomUUID().slice(0, 8)}`;
  const output = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
from test_published_deck_page import page_world
print(json.dumps(page_world(sys.argv[1], sys.argv[2])))`,
      owner,
      prefix,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  return {
    prefix,
    tokens: JSON.parse(output.toString().trim().split("\n").at(-1)!),
  };
}

/** Signs in as a new owner and returns their user id. */
async function signIn(page: Page): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
    await signInAsOwner(page, "/collection");
    await expect(
      page.getByRole("navigation", { name: "Main views" })
    ).toBeVisible();
    return (
      await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL])
    ).rows[0].id as string;
  } finally {
    await pool.end();
  }
}

async function open(page: Page, token: string) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  await page.goto(`${ORIGIN}/published/${token}`);
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  for (const signedIn of [false, true]) {
    test(`headings at ${viewport.width}, signed ${signedIn ? "in" : "out"}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const owner = signedIn
        ? await signIn(page)
        : `visitor-owner-${randomUUID()}`;
      const world = pageWorld(owner);
      await open(page, world.tokens.Legal);
      const panel = page.getByRole("region", {
        name: "Deck List",
        exact: true,
      });
      await expect(panel.getByRole("heading", { level: 2 })).toHaveCount(3);
      await testInfo.attach("section-headings", {
        body: await panel.screenshot({ animations: "disabled" }),
        contentType: "image/png",
      });
      for (const name of [
        "Pokémon, 1 card",
        "Other Trainers, 8 cards",
        "Energy, 51 cards",
      ]) {
        await expect(
          panel.getByRole("heading", { name, exact: true })
        ).toBeVisible();
      }
    });
  }
}
