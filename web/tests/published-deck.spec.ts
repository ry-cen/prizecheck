// Ticket #183: the Published Deck page on the kit (spec "Published Deck and Discover"). The header with the snapshot
// date, the Target Format result pill and its dialog, the total and priced-copy count, Copy for TCG Live, Buy on
// TCGplayer and Share; the read-only deck panel in Spread, Stacked and List with one card's price on tiles and that
// many copies' price on List lines; a card-level issue outlining its tiles; the read-only card popup stepping through
// the deck; and, signed in, the owner bar. The decks come from api/tests/test_published_deck_page.py's page_world on
// this worker's stack: real catalog cards judged by the real rules files. Every state runs the shared page check at
// 1280×800 and 375×812, with each dialog open as well as closed.
import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/** Replace the clipboard: writeText records its argument. */
async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    const texts: string[] = [];
    (window as unknown as { __clip: string[] }).__clip = texts;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          texts.push(text);
          return Promise.resolve();
        },
      },
    });
  });
}

async function open(page: Page, token: string) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  await page.goto(`${ORIGIN}/published/${token}`);
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const deckList = (page: Page) =>
  page.getByRole("region", { name: "Deck List" });
const views = (page: Page) =>
  page.getByRole("radiogroup", { name: "Deck List view" });
const resultPill = (page: Page) =>
  page.getByRole("button", { name: /Show the Standard result$/ });

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  const phone = viewport.width <= 760;
  test.describe(`at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("signed out, a visitor reads the header, the priced deck panel in its three views, the card popup, the result and the exports", async ({
      page,
    }) => {
      const world = pageWorld(`visitor-owner-${randomUUID()}`);
      await stubClipboard(page);
      await open(page, world.tokens.Legal);
      await expect(heading(page)).toHaveText(`${world.prefix} Legal`);
      await expect(
        page.getByRole("navigation", { name: "Public pages" })
      ).toBeVisible();
      await expect(page.getByRole("main")).toContainText(
        /The card list is a snapshot from [A-Z][a-z]{2} \d{1,2}, \d{4}; format results update automatically/
      );
      await expect(resultPill(page)).toHaveAccessibleName(
        "Standard: Legal. Show the Standard result"
      );
      await expect(page.getByRole("main")).toContainText(
        "60 cards · $66.55 · 60/60 copies priced"
      );
      // No price age and no ownership anywhere.
      await expect(page.getByRole("main")).not.toContainText(
        /stale|48 hours|owned|not owned/i
      );
      // The builder's defaults: Spread on a desktop, Stacked on a phone.
      await expect(
        views(page).getByRole("radio", { name: phone ? "Stacked" : "Spread" })
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        deckList(page).getByRole("heading", { level: 3 })
      ).toHaveText([
        "Other Pokémon, 1 card",
        "Other Trainers, 8 cards",
        "Energy, 51 cards",
      ]);
      await expectPageChecks(page, "Published Deck, signed out");

      // Spread: one plain tile per copy, each with one card's price.
      await views(page).getByRole("radio", { name: "Spread" }).click();
      const candy = deckList(page).getByRole("button", {
        name: /^Rare Candy, .*, copy 1 of 4, \$10\.00$/,
      });
      await expect(candy).toBeVisible();
      await expect(candy).toContainText("$10.00");
      await expect(
        deckList(page).getByRole("button", { name: /^Rare Candy, / })
      ).toHaveCount(4);
      // Stacked: one pile per Edition, with one card's price.
      await views(page).getByRole("radio", { name: "Stacked" }).click();
      const pile = deckList(page).getByRole("button", {
        name: /^Rare Candy, .*: 4 copies, \$10\.00 each$/,
      });
      await expect(pile).toContainText("×4");
      await expectPageChecks(page, "Published Deck in Stacked");
      // List: the quantity, the Edition and the price for that many copies.
      await views(page).getByRole("radio", { name: "List" }).click();
      const row = deckList(page)
        .getByRole("listitem")
        .filter({ hasText: "Rare Candy" });
      await expect(row).toContainText("4");
      await expect(row).toContainText("$40.00");
      await expect(
        deckList(page)
          .getByRole("listitem")
          .filter({ hasText: "Basic Grass Energy" })
      ).toContainText("$15.30");
      await expectPageChecks(page, "Published Deck in List");

      // The read-only card popup: the art, the Edition, one card's price and its standing, with ‹ ›.
      await row.getByRole("button").click();
      const popup = page.getByRole("dialog", { name: "Rare Candy" });
      await expect(popup).toContainText("Mega Evolution (me01) · #125");
      await expect(popup).toContainText("$10.00 each");
      await expect(popup).toContainText("4 copies");
      await expect(popup).toContainText("Legal");
      await expect(popup.getByRole("button", { name: /^(−|\+)/ })).toHaveCount(
        0
      );
      await expectPageChecks(page, "Published Deck card popup");
      await popup.getByRole("button", { name: "Next card" }).click();
      await expect(page.getByRole("dialog", { name: "Switch" })).toContainText(
        "$2.50 each"
      );
      await page.keyboard.press("ArrowLeft");
      await expect(
        page.getByRole("dialog", { name: "Rare Candy" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(row.getByRole("button")).toBeFocused();

      // The result pill opens the results dialog.
      await resultPill(page).click();
      const results = page.getByRole("dialog", { name: "Standard result" });
      await expect(results).toContainText("No issues found.");
      await expect(results).toContainText(/Rules version/);
      await expectPageChecks(page, "Published Deck result dialog");
      // Another "as of" date asks the public result for this snapshot on that day.
      const asOf = page.waitForRequest((request) =>
        request.url().includes("/format-checks?as_of=2026-04-09")
      );
      await results.getByLabel("As of").fill("2026-04-09");
      await asOf;
      await expect(results).toContainText("as of Apr 9, 2026");
      await page.keyboard.press("Escape");
      await expect(results).toHaveCount(0);
      await expect(resultPill(page)).toBeFocused();

      // Copy for TCG Live prepares the Live export of this snapshot as it opens.
      await page.getByRole("button", { name: "Copy for TCG Live" }).click();
      const live = page.getByRole("dialog", { name: "Copy for TCG Live" });
      const livePanel = live.getByRole("region", {
        name: "Pokémon TCG Live export",
      });
      await expect(
        livePanel.getByRole("button", { name: "Export to Live" })
      ).toBeEnabled();
      await expect(
        livePanel.getByRole("region", { name: /^Live export( blockers)?$/ })
      ).toBeVisible();
      await expectPageChecks(page, "Published Deck Live export");
      await live.getByRole("button", { name: "Close Live export" }).click();

      // Buy on TCGplayer prepares Mass Entry for the whole list as it opens.
      await page.getByRole("button", { name: "Buy on TCGplayer" }).click();
      const buy = page.getByRole("dialog", { name: "Buy on TCGplayer" });
      const massPanel = buy.getByRole("region", { name: "TCGplayer export" });
      await expect(
        massPanel.getByRole("button", { name: "Prepare TCGplayer export" })
      ).toBeEnabled();
      await expect(massPanel).toContainText("60 copies");
      await expectPageChecks(page, "Published Deck TCGplayer export");
      await buy.getByRole("button", { name: "Close TCGplayer export" }).click();

      // Share copies the page's link.
      await page.getByRole("button", { name: "Share" }).click();
      await expect(page.getByRole("main")).toContainText("Link copied.");
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { __clip: string[] }).__clip
          )
        )
        .toEqual([`${ORIGIN}/published/${world.tokens.Legal}`]);
    });

    test("a card-level issue outlines its tiles, and the popup and the result say why", async ({
      page,
    }) => {
      const world = pageWorld(`visitor-owner-${randomUUID()}`);
      await open(page, world.tokens.Over);
      await expect(heading(page)).toHaveText(`${world.prefix} Over`);
      await expect(resultPill(page)).toHaveAccessibleName(
        /^Standard: Not legal, \d+ issues?\. Show the Standard result$/
      );
      const research = deckList(page).getByRole("button", {
        name: /^Professor's Research \(Professor Juniper\), /,
      });
      await expect(research.first()).toHaveAccessibleDescription(
        "Has a format issue: see the Standard result."
      );
      await expect(
        deckList(page)
          .getByRole("button", { name: /^Bulbasaur, / })
          .first()
      ).not.toHaveAccessibleDescription(/format issue/);
      await expectPageChecks(page, "Published Deck with a card-level issue");
      await research.first().click();
      const popup = page.getByRole("dialog", {
        name: "Professor's Research (Professor Juniper)",
      });
      await expect(popup).toContainText("Not legal");
      await expect(popup).toContainText(
        "more than 4 copies of Professor's Research (5)"
      );
      await page.keyboard.press("Escape");
      await resultPill(page).click();
      const results = page.getByRole("dialog", { name: "Standard result" });
      await expect(
        results.getByRole("region", { name: "Card issues" })
      ).toContainText("Professor's Research (Professor Juniper)");
      await expectPageChecks(page, "Published Deck result dialog with issues");
    });

    test("signed in inside the shell, the owner manages the Published Deck from its owner bar", async ({
      page,
    }) => {
      const owner = await signIn(page);
      const world = pageWorld(owner);
      await open(page, world.tokens.Legal);
      await expect(heading(page)).toHaveText(`${world.prefix} Legal`);
      await expect(
        page.getByRole("navigation", { name: "Main views" })
      ).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Public pages" })
      ).toHaveCount(0);
      const bar = page.getByRole("region", { name: /^Your Published Deck/ });
      await expect(bar.getByRole("heading", { level: 2 })).toHaveText(
        "Your Published Deck · Listed · v1"
      );
      await expect(bar).not.toContainText("Hidden from Discover");
      await expect(bar.getByRole("link", { name: "Open Deck" })).toBeVisible();
      await expectPageChecks(page, "Published Deck with the owner bar");
      await bar.getByRole("button", { name: "Make Unlisted" }).click();
      await expect(bar.getByRole("heading", { level: 2 })).toHaveText(
        "Your Published Deck · Unlisted · v1"
      );
      await expect(bar.getByRole("status")).toHaveText(
        `${world.prefix} Legal is Unlisted now.`
      );
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
        "content",
        "noindex, nofollow"
      );
      await bar.getByRole("button", { name: "Make Listed" }).click();
      await expect(bar.getByRole("heading", { level: 2 })).toHaveText(
        "Your Published Deck · Listed · v1"
      );

      // Listed but not legal: hidden from Discover, and the bar says so.
      await page.goto(`${ORIGIN}/published/${world.tokens.Over}`);
      await expect(heading(page)).toHaveText(`${world.prefix} Over`);
      await expect(bar).toContainText(
        "Hidden from Discover: not legal in Standard"
      );

      // An orphan: its Deck is gone, so there is no Open Deck. Revoke takes two steps.
      await page.goto(`${ORIGIN}/published/${world.tokens.Orphan}`);
      await expect(heading(page)).toHaveText(`${world.prefix} Orphan`);
      await expect(bar.getByRole("heading", { level: 2 })).toHaveText(
        "Your Published Deck · Unlisted · v1"
      );
      await expect(bar).toContainText("Deck deleted");
      await expect(bar.getByRole("link", { name: "Open Deck" })).toHaveCount(0);
      await expectPageChecks(page, "orphan Published Deck with the owner bar");
      await bar
        .getByRole("button", { name: `Revoke: ${world.prefix} Orphan` })
        .click();
      await expectPageChecks(page, "owner bar confirming Revoke");
      await bar.getByRole("button", { name: "Revoke for good" }).click();
      await expect(heading(page)).toHaveText(
        "This deck isn't published anymore"
      );

      // Open Deck goes to the deck builder without a page load.
      await page.goto(`${ORIGIN}/published/${world.tokens.Legal}`);
      await bar.getByRole("link", { name: "Open Deck" }).click();
      await expect(page).toHaveURL(`${ORIGIN}/decks/${world.tokens.deck}`);
    });
  });
}
