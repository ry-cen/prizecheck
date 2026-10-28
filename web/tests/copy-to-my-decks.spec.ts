import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner, signInWithButton } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import { artUpstream } from "./support/art-upstream";

// Copy to my Decks (decklist import #216). A Published Deck's Copy to my Decks opens the import's paste screen with the
// snapshot's cards in place of the text box, the new Deck named after the Published Deck and set to its Target Format
// (both editable), then the same review and owned-cards setting, and lands in the new Deck's builder with an Undo that
// deletes it. Signed out, the button asks the visitor to sign in first and continues to the copy. The decks come from
// api/tests/test_deck_import_copy.py's copy_world on this worker's stack: another owner's "<prefix> Lost Box" (Expanded:
// 2 Nest Ball SVI 181 Reverse Holo, 3 Iono PAL 185, and 1 Iono PAL 254 whose card has since been withdrawn) and a
// revoked "<prefix> Gone". No prices are stored, so new copies take the first Edition in catalog order.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
);

type World = { prefix: string; copy: string; gone: string };

/** Replaces the catalog and publishes copy_world's two decks for another owner. */
function copyWorld(): World {
  const prefix = `Copy ${randomUUID().slice(0, 8)}`;
  const output = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
from test_deck_import_copy import copy_world
print(json.dumps(copy_world(sys.argv[1])))`,
      prefix,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  return {
    prefix,
    ...JSON.parse(output.toString().trim().split("\n").at(-1)!),
  };
}

async function edition(sourceId: string, finish: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=$1 AND e.descriptor->>'finish'=$2",
    [sourceId, finish]
  );
  return rows[0].id;
}

async function stubArt(page: Page) {
  // The Published Deck page is anonymous and loads the art host directly; the signed-in pages use the art route, whose
  // fetcher reads the art stub.
  (await artUpstream()).reset();
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
}

async function signIn(page: Page) {
  await stubArt(page);
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("heading", { name: "Decks", level: 1, exact: true })
  ).toBeVisible();
}

const copyButton = (page: Page) =>
  page.getByRole("button", { name: "Copy to my Decks", exact: true });
const snapshotList = (page: Page) =>
  page.getByRole("region", { name: "Published Deck" });
const lineItem = (page: Page, text: string) =>
  page.getByRole("listitem").filter({ hasText: text });
const setting = (page: Page) =>
  page.getByRole("radiogroup", { name: "Owned cards" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

/** On the copy's paste screen: the snapshot's three cards, the defaults, and no text box. */
async function expectCopyScreen(page: Page, world: World) {
  await expect(page).toHaveURL(
    `${ORIGIN}/decks/import?publication=${world.copy}`
  );
  await expect(
    page.getByRole("heading", { name: "Copy to my Decks", level: 1 })
  ).toBeVisible();
  await expect(snapshotList(page)).toContainText(`${world.prefix} Lost Box`);
  await expect(snapshotList(page).getByRole("listitem")).toHaveText([
    "3 Iono PAL 185",
    "1 Iono PAL 254",
    "2 Nest Ball SVI 181",
  ]);
  await expect(snapshotList(page)).toContainText("3 card lines · 6 cards");
  await expect(page.getByLabel("Decklist")).toBeHidden();
  await expect(page.getByLabel("Deck name")).toHaveValue(
    `${world.prefix} Lost Box`
  );
  await expect(page.getByLabel("Target Format")).toHaveValue("expanded");
}

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("copies another collector's Published Deck: the snapshot on the paste screen, its title and Target Format as editable defaults, the review under Exact printings keeping the published Editions, and Undo removing the new Deck", async ({
    page,
  }) => {
    const world = copyWorld();
    await signIn(page);
    await page.goto(`${ORIGIN}/published/${world.copy}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      `${world.prefix} Lost Box`
    );
    await copyButton(page).click();
    await expectCopyScreen(page, world);
    await expectPageChecks(page, "copy paste screen");

    // Both defaults are editable.
    const name = `${world.prefix} mine`;
    await page.getByLabel("Deck name").fill(name);
    await page.getByRole("button", { name: "Review 3 lines" }).click();
    await expect(
      page.getByRole("heading", { name: "Check the list", level: 1 })
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Import summary" })
    ).toContainText(`New Deck ${name} · Target Format Expanded`);

    // The withdrawn card is Not found with its name, set and number; dropping it enables Create Deck.
    const gone = lineItem(page, "1 Iono PAL 254");
    await expect(gone).toContainText("Not found");
    await gone.getByRole("button", { name: "Fix" }).click();
    await page.getByRole("button", { name: "Drop line" }).click();

    // Use cards I own (the default) gives Nest Ball the first Edition in catalog order; Exact printings keeps the
    // Published Deck's Reverse Holo.
    await page.getByRole("button", { name: /^All \d+$/ }).click();
    const nest = lineItem(page, "2 Nest Ball SVI 181");
    await expect(nest).toContainText("2 SVI 181 · no Edition priced");
    await setting(page).getByRole("radio", { name: "Exact printings" }).click();
    await expect(nest).toContainText(
      "2 SVI 181 · Reverse Holo · as published · no price"
    );
    await expect(
      page.getByRole("region", { name: "Save" }).getByRole("status").first()
    ).toHaveText("Ready · 5 cards · 2 Deck List lines");

    await page.getByRole("button", { name: "Create Deck" }).click();
    await expect(page).toHaveURL(/\/decks\/[0-9a-f-]{36}$/);
    await expect(
      page.getByRole("heading", { level: 1, name, exact: true })
    ).toBeVisible();
    await expect(notifications(page)).toContainText(
      `Created ${name} with 5 cards.`
    );
    const id = page.url().split("/").pop()!;
    const response = await page.request.get(`${ORIGIN}/api/decks/${id}`);
    expect(response.status()).toBe(200);
    const deck = (await response.json()) as {
      target_format: string;
      deck_list: { lines: { edition_id: string; quantity: string }[] };
    };
    expect(deck.target_format).toBe("expanded");
    expect(
      Object.fromEntries(
        deck.deck_list.lines.map((l) => [l.edition_id, l.quantity])
      )
    ).toEqual({
      [await edition("sv01-181", "reverse")]: "2",
      [await edition("sv02-185", "normal")]: "3",
    });

    await notifications(page).getByRole("button", { name: "Undo" }).click();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(notifications(page)).toContainText(`Removed ${name}.`);
    expect((await page.request.get(`${ORIGIN}/api/decks/${id}`)).status()).toBe(
      404
    );
  });

  test("a revoked Published Deck can't be copied", async ({ page }) => {
    const world = copyWorld();
    await signIn(page);
    await page.goto(`${ORIGIN}/decks/import?publication=${world.gone}`);
    await expect(
      page.getByRole("heading", { name: "Copy to my Decks", level: 1 })
    ).toBeVisible();
    await expect(snapshotList(page)).toContainText(
      "This Published Deck is no longer published, so it can't be copied."
    );
    await expect(
      snapshotList(page).getByRole("button", { name: "Retry" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Review", exact: true })
    ).toHaveAttribute("aria-disabled", "true");
  });

  test("signed out, Copy to my Decks asks the visitor to sign in and then continues to the copy", async ({
    page,
  }) => {
    const world = copyWorld();
    await stubArt(page);
    await page.goto(`${ORIGIN}/published/${world.copy}`);
    await copyButton(page).click();
    await expect(page).toHaveURL(
      `${ORIGIN}/decks/import?publication=${world.copy}`
    );
    await expect(page.getByRole("main")).toContainText(
      "Sign in to continue where you left off."
    );
    await startAsNewOwner(pool);
    await signInWithButton(page);
    await expectCopyScreen(page, world);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Published Deck's Copy to my Decks and the copy's paste screen fit a phone with 44 px controls", async ({
    page,
  }) => {
    const world = copyWorld();
    await signIn(page);
    await page.goto(`${ORIGIN}/published/${world.copy}`);
    await expectTouchTarget(copyButton(page));
    await copyButton(page).tap();
    await expectCopyScreen(page, world);
    await expectPageChecks(page, "copy paste screen on a phone");
  });
});
