// Ticket #182: Discover on the kit (spec "Published Deck and Discover"). A grid of deck cards, newest first, listing
// only the Listed Published Decks that are legal in their Target Format today, with a search box and the format chips,
// and each card's cost in its three states. The decks come from api/tests/test_discover_listing.py's listing_world on
// this worker's stack: real catalog cards judged by the real rules files, and nothing exempt from Discover's filter.
// Discover has no dialogs; every state runs the shared page check at 1280×800 and 375×812, signed out and signed in.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type World = { prefix: string; tokens: Record<string, string> };

/** Replaces the catalog and lists four decks titled `<prefix> Full|Partial|Bare|Over` (listing_world). */
function listingWorld(): World {
  const prefix = `Discover ${randomUUID().slice(0, 8)}`;
  const output = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
from test_discover_listing import listing_world
print(json.dumps(listing_world(sys.argv[1])))`,
      prefix,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  return {
    prefix,
    tokens: JSON.parse(output.toString().trim().split("\n").at(-1)!),
  };
}

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
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(`${ORIGIN}/collection`);
  await page.getByLabel("Email").fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
  await page
    .getByLabel("Six-digit code")
    .fill(JSON.parse(messages(mail).at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const search = (page: Page) =>
  page.getByRole("searchbox", { name: "Search decks" });
const chips = (page: Page) => page.getByRole("group", { name: "Format" });
const grid = (page: Page) => page.getByRole("list", { name: "Decks" });
const deckCard = (page: Page, title: string) =>
  grid(page).getByRole("link", { name: title, exact: true });

async function openDiscover(page: Page, world: World) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  await page.goto(`${ORIGIN}/discover`);
  await expect(heading(page)).toHaveText("Discover decks");
  await search(page).fill(world.prefix);
  await expect(grid(page).getByRole("link")).toHaveCount(3);
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("signed out, Discover lists only legal decks, newest first, with their pill, count, date and cost", async ({
      page,
    }) => {
      const world = listingWorld();
      await openDiscover(page, world);
      const { prefix } = world;
      // Newest first; the deck that isn't legal is never listed.
      await expect(grid(page).getByRole("heading", { level: 2 })).toHaveText([
        `${prefix} Bare`,
        `${prefix} Partial`,
        `${prefix} Full`,
      ]);
      await expect(page.getByRole("status")).toHaveText("Showing 3 decks");
      const full = deckCard(page, `${prefix} Full`);
      await expect(full).toHaveAttribute(
        "href",
        `/published/${world.tokens.Full}`
      );
      await expect(full).toContainText("✓ Standard");
      await expect(full).toContainText("60 cards");
      await expect(full).toContainText(
        /Published [A-Z][a-z]{2} \d{1,2}, \d{4}/
      );
      await expect(full).toContainText("$67");
      await expect(full).toHaveAccessibleDescription(/Standard legal/);
      await expect(full.getByRole("img")).toHaveAccessibleName("Bulbasaur");
      // Some copies have no cached quote: a plus, and the count in a tooltip and for screen readers.
      const partial = deckCard(page, `${prefix} Partial`);
      await expect(partial).toContainText("$66+");
      await expect(partial.getByTitle("2 cards not priced yet")).toHaveText(
        /^\$66\+/
      );
      await expect(partial).toHaveAccessibleDescription(
        /\$66\+ \(2 cards not priced yet\)/
      );
      await expect(partial.getByRole("img")).toHaveAccessibleName(
        "Fixture Sprout ex"
      );
      // No copy priced: Price on page.
      const bare = deckCard(page, `${prefix} Bare`);
      await expect(bare).toContainText("✓ Expanded");
      await expect(bare).toContainText("Price on page");
      await expectPageChecks(page, "Discover results, signed out");

      // A card opens its Published Deck without a page load.
      await full.click();
      await expect(page).toHaveURL(`${ORIGIN}/published/${world.tokens.Full}`);
      await expect(
        page.getByRole("heading", { name: `${prefix} Full`, exact: true })
      ).toBeVisible();
    });

    test("the format chips filter by Target Format and the search narrows by title", async ({
      page,
    }) => {
      const world = listingWorld();
      await openDiscover(page, world);
      const { prefix } = world;
      await chips(page).getByRole("button", { name: "Expanded" }).click();
      await expect(
        chips(page).getByRole("button", { name: "Expanded" })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(grid(page).getByRole("link")).toHaveText([
        new RegExp(`^${prefix} Bare`),
      ]);
      await chips(page).getByRole("button", { name: "Standard" }).click();
      await expect(grid(page).getByRole("heading", { level: 2 })).toHaveText([
        `${prefix} Partial`,
        `${prefix} Full`,
      ]);
      await chips(page).getByRole("button", { name: "GLC" }).click();
      await expect(page.getByRole("status")).toHaveText(
        "No legal decks match this search."
      );
      await expect(grid(page)).toHaveCount(0);
      await expectPageChecks(page, "Discover with no matching deck");
      await chips(page).getByRole("button", { name: "Any" }).click();
      await expect(grid(page).getByRole("link")).toHaveCount(3);
      await search(page).fill(`${prefix} Partial`);
      await expect(grid(page).getByRole("heading", { level: 2 })).toHaveText([
        `${prefix} Partial`,
      ]);
    });

    test("an unavailable listing says so and Retry loads it", async ({
      page,
    }) => {
      const world = listingWorld();
      let fail = true;
      await page.route("**/api/public/discovery**", (route) =>
        fail
          ? route.fulfill({
              status: 503,
              json: { detail: { code: "PUBLIC_PROJECTION_UNAVAILABLE" } },
            })
          : route.continue()
      );
      await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
        route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
      );
      await page.goto(`${ORIGIN}/discover`);
      const alert = page.getByRole("alert");
      await expect(alert).toContainText(
        "Discover is unavailable right now. Please retry."
      );
      await expectPageChecks(page, "Discover unavailable");
      fail = false;
      await search(page).fill(world.prefix);
      await expect(grid(page).getByRole("link")).toHaveCount(3);
      await expect(alert).toHaveCount(0);
      fail = true;
      await search(page).fill(`${world.prefix} Full`);
      await expect(alert).toBeVisible();
      fail = false;
      await alert.getByRole("button", { name: "Retry" }).click();
      await expect(grid(page).getByRole("link")).toHaveText([
        new RegExp(`^${world.prefix} Full`),
      ]);
    });

    test("a later page whose cursor is refused restarts at page one with a notice", async ({
      page,
    }) => {
      const world = listingWorld();
      // Every first page claims another page exists; the cursor it names is refused as an old one.
      await page.route("**/api/public/discovery**", async (route) => {
        if (new URL(route.request().url()).searchParams.has("cursor"))
          return route.fulfill({
            status: 400,
            json: { detail: { code: "INVALID_CURSOR" } },
          });
        const real = await route.fetch();
        await route.fulfill({
          response: real,
          json: { ...(await real.json()), next_cursor: "an-old-cursor" },
        });
      });
      await openDiscover(page, world);
      await page.getByRole("button", { name: "More decks" }).click();
      await expect(page.getByRole("status")).toContainText(
        "Published decks changed. Showing the first page."
      );
      await expect(grid(page).getByRole("link")).toHaveCount(3);
    });

    test("signed in, Discover opens inside the shell with the same listing", async ({
      page,
    }) => {
      const world = listingWorld();
      await signIn(page);
      await openDiscover(page, world);
      await expect(
        page.getByRole("navigation", { name: "Main views" }).first()
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Public pages" })
      ).toHaveCount(0);
      await expect(grid(page).getByRole("heading", { level: 2 })).toHaveText([
        `${world.prefix} Bare`,
        `${world.prefix} Partial`,
        `${world.prefix} Full`,
      ]);
      await expectPageChecks(page, "Discover results inside the shell");
    });
  });
}
