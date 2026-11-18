import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { test, artUpstream } from "./support/art-upstream";

// A pasted list that hasn't been applied isn't lost without a word (hill-climb m13 s1). The Replace list… page
// (/decks/<id>/replace, #215) and Import a decklist (/decks/import, #212) keep the pasted text in the page, so leaving
// them through the in-app back link, the shell's tabs or the browser's Back dropped it silently, and reopening showed
// an empty text box. They now use the app's leave guard (the Trade Proposal builder's): once there is pasted text,
// leaving by any in-app route asks "Discard this pasted list?" with Keep editing (the default) or Discard; a reload or
// a closed tab gets the browser's own warning. A list with no text, a list that has been applied, and a Deck name
// alone leave silently, as before. Checked at 1280×800 and 375×812.
//
// The catalog is api/tests/deck_import_fixtures.py's OWNED_CARDS, as replace-list.spec.ts.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const PASTE = "4 Iono PAL 185\n";
const TWO_LINES = "4 Bulbasaur MEG1\n4 Ivysaur MEG2\n";
const DECK = "Garden practice";

function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from deck_import_fixtures import seed_import_owned_catalog\nseed_import_owned_catalog()",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function signIn(page: Page) {
  (await artUpstream()).reset();
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("heading", { name: "Decks", level: 1, exact: true })
  ).toBeVisible();
}

/** Makes the Deck and opens its builder, the page Replace list… comes from. */
async function deckBuilder(page: Page): Promise<string> {
  const response = await page.request.fetch(`${ORIGIN}/api/decks`, {
    method: "POST",
    headers: { origin: ORIGIN },
    data: { name: DECK, idempotency_key: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const id = (await response.json()).location.id as string;
  await page.goto(`${ORIGIN}/decks/${id}`);
  await expect(
    page.getByRole("heading", { name: DECK, level: 1 })
  ).toBeVisible();
  return id;
}

const replaceList = async (page: Page, id: string) => {
  await page.getByRole("button", { name: "Replace list…" }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
  await expect(
    page.getByRole("heading", { name: `Replace ${DECK}'s list`, level: 1 })
  ).toBeVisible();
};

/** Replaces the catalog and publishes copy_world's Decks for another owner (copy-to-my-decks.spec.ts). */
function copyWorld(): { prefix: string; copy: string } {
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

const SAVE = /\/api\/decks\/[^/]+\/deck-list\/changes$/;
const saving = (page: Page) =>
  page.getByRole("dialog", { name: "Your list is still saving" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

// A held save is let go when its test ends, pass or fail, so closing the page never waits on it.
const releases: Array<() => void> = [];
test.afterEach(() => {
  for (const release of releases.splice(0)) release();
});

/** Holds the Replace save at the network until `release()`, then lets it through, or answers `status` instead. */
async function holdSave(page: Page, status?: number) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  releases.push(() => release());
  const keys: string[] = [];
  await page.route(SAVE, async (route) => {
    keys.push(route.request().postDataJSON().idempotency_key);
    await gate;
    if (status) await route.fulfill({ status, json: { detail: "down" } });
    else await route.continue();
  });
  return { release, keys };
}

/** Pastes PASTE on the Replace screen, opens the review and presses Replace Deck List. */
async function startSave(page: Page, id: string) {
  await replaceList(page, id);
  await decklist(page).fill(PASTE);
  await page.getByRole("button", { name: "Review 1 line" }).click();
  await expect(
    page.getByRole("heading", { name: "Check the list", level: 1 })
  ).toBeVisible();
  const sent = page.waitForRequest((request) => SAVE.test(request.url()));
  await page.getByRole("button", { name: "Replace Deck List" }).click();
  await sent;
}

const decklist = (page: Page) => page.getByLabel("Decklist");
const asking = (page: Page) =>
  page.getByRole("dialog", { name: "Discard this pasted list?" });
const backLink = (page: Page) =>
  page.getByRole("link", { name: `‹ ${DECK}`, exact: true });
const tabs = (page: Page) =>
  page.locator('nav[aria-label="Main views"]:visible');

/** Whether the page asks before a reload or close (the beforeunload event is cancelled). */
const warns = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test.afterAll(async () => {
  await pool.end();
});

for (const [label, viewport] of [
  ["a desktop", { width: 1280, height: 800 }],
  ["a phone", { width: 375, height: 812 }],
] as const) {
  test.describe(`on ${label}`, () => {
    test.use({ viewport });

    test("the back link asks first with a pasted list: Keep editing keeps the text where it was, Discard leaves and a reopened Replace list… is empty", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      await replaceList(page, id);
      await decklist(page).fill(TWO_LINES);

      await backLink(page).click();
      await expect(asking(page)).toBeVisible();
      await expect(asking(page)).toContainText(
        `Your pasted list will be discarded. ${DECK}'s Deck List stays as it was.`
      );
      await expectPageChecks(page, "the discard question");
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(
        asking(page).getByRole("button", { name: "Keep editing" })
      ).toBeFocused();

      await asking(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(asking(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(decklist(page)).toHaveValue(TWO_LINES);
      await expect(backLink(page)).toBeFocused();

      // Escape is Keep editing as well.
      await backLink(page).click();
      await expect(asking(page)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(asking(page)).toBeHidden();
      await expect(decklist(page)).toHaveValue(TWO_LINES);

      await backLink(page).click();
      await asking(page).getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(
        page.getByRole("heading", { name: DECK, level: 1 })
      ).toBeVisible();
      await expect(asking(page)).toHaveCount(0);

      await replaceList(page, id);
      await expect(decklist(page)).toHaveValue("");
    });

    test("browser Back asks first too: Keep editing stays on the page with its text, and Discard goes back to the Deck", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      await replaceList(page, id);
      await decklist(page).fill(TWO_LINES);

      await page.goBack();
      await expect(asking(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await asking(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(decklist(page)).toHaveValue(TWO_LINES);

      // Dialog → Back: Back with the question open keeps asking, and Discard still lands on the Deck once.
      await backLink(page).click();
      await expect(asking(page)).toBeVisible();
      await page.goBack();
      await expect(asking(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await asking(page).getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);
      // Forward comes back to a Replace list… with nothing pasted, and a clean list needs no question.
      await page.goForward();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(decklist(page)).toHaveValue("");
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);
    });

    test("the shell's tabs ask first as well, and Discard opens the tab that was chosen", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      await replaceList(page, id);
      await decklist(page).fill(TWO_LINES);

      await tabs(page)
        .getByRole("link", { name: "Collection", exact: true })
        .click();
      await expect(asking(page)).toBeVisible();
      await asking(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(decklist(page)).toHaveValue(TWO_LINES);

      await tabs(page)
        .getByRole("link", { name: "Collection", exact: true })
        .click();
      await asking(page).getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(/\/collection/);
      await expect(asking(page)).toHaveCount(0);
    });

    test("a list with no pasted text leaves without a question, and so does one whose text was cleared again", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);

      await replaceList(page, id);
      await backLink(page).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);

      await replaceList(page, id);
      await decklist(page).fill("  \n  ");
      await backLink(page).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));

      await replaceList(page, id);
      await decklist(page).fill(TWO_LINES);
      await decklist(page).fill("");
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);

      // Clean tabs too.
      await replaceList(page, id);
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(page).toHaveURL(/\/catalog/);
      await expect(asking(page)).toHaveCount(0);
    });

    test("a reload or a closed tab gets the browser's warning only while there is pasted text", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      await replaceList(page, id);
      expect(await warns(page)).toBe(false);
      await decklist(page).fill(TWO_LINES);
      expect(await warns(page)).toBe(true);
      await decklist(page).fill("");
      expect(await warns(page)).toBe(false);
    });

    test("on the review step the pasted list is still guarded, going back to the list is not a leave, and a saved Replace leaves with no question", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      await replaceList(page, id);
      await decklist(page).fill(PASTE);
      await page.getByRole("button", { name: "Review 1 line" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();

      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(asking(page)).toBeVisible();
      await asking(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
      expect(await warns(page)).toBe(true);

      // Back to the list is a step within the page: no question, and the paste is as it was.
      await page.getByRole("button", { name: "Back to paste" }).click();
      await expect(asking(page)).toHaveCount(0);
      await expect(decklist(page)).toHaveValue(PASTE);

      await page.getByRole("button", { name: "Review 1 line" }).click();
      await page.getByRole("button", { name: "Replace Deck List" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);
      expect(await warns(page)).toBe(false);
    });

    test("a Replace that is still saving asks before leaving: Stay keeps the page and lands in the Deck, and Leave stays where the collector went when the save lands", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page);
      await startSave(page, id);
      expect(await warns(page)).toBe(true);

      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(saving(page)).toBeVisible();
      await expect(saving(page)).toContainText(
        `Leave now and you won't see whether it replaced ${DECK}'s Deck List.`
      );
      await expectPageChecks(page, "the still-saving question");
      await expect(
        saving(page).getByRole("button", { name: "Stay" })
      ).toBeFocused();
      await saving(page).getByRole("button", { name: "Stay" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      hold.release();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);
      await expect(notifications(page)).toContainText(
        `Replaced ${DECK}'s Deck List.`
      );

      // Leaving anyway: the save lands behind the collector and doesn't pull them back to the Deck.
      await page.unroute(SAVE);
      const second = await holdSave(page);
      await replaceList(page, id);
      await decklist(page).fill("4 Nest Ball SVI 181\n");
      await page.getByRole("button", { name: "Review 1 line" }).click();
      const sent = page.waitForRequest((request) => SAVE.test(request.url()));
      const landed = page.waitForResponse((response) =>
        SAVE.test(response.url())
      );
      await page.getByRole("button", { name: "Replace Deck List" }).click();
      await sent;
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await saving(page).getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(/\/catalog/);
      second.release();
      await landed;
      await expect(notifications(page)).toContainText(
        `Replaced ${DECK}'s Deck List.`
      );
      await expect(page).toHaveURL(/\/catalog/);
    });

    test("a Replace that fails while the collector stays keeps the review, the message and the same retry key", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, 500);
      await startSave(page, id);
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await saving(page).getByRole("button", { name: "Stay" }).click();
      hold.release();
      await expect(page.getByRole("region", { name: "Save" })).toContainText(
        "Replacing may have completed. Press Replace Deck List again to check safely."
      );
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
      // Not saving any more, but the review is still unapplied: leaving still asks.
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(asking(page)).toBeVisible();
      await asking(page).getByRole("button", { name: "Keep editing" }).click();

      await page.unroute(SAVE);
      const retry = page.waitForRequest((request) => SAVE.test(request.url()));
      await page.getByRole("button", { name: "Replace Deck List" }).click();
      const again = (await retry).postDataJSON().idempotency_key;
      expect(again).toBe(hold.keys[0]);
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(asking(page)).toHaveCount(0);
    });

    test("Copy to my Decks names the review changes, and leaves silently until there is one", async ({
      page,
    }) => {
      const world = copyWorld();
      await signIn(page);
      await page.goto(`${ORIGIN}/decks/import?publication=${world.copy}`);
      await expect(
        page.getByRole("heading", { name: "Copy to my Decks", level: 1 })
      ).toBeVisible();
      await page.getByRole("button", { name: "Review 3 lines" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
      expect(await warns(page)).toBe(false);

      // The withdrawn card is the one line that needs the collector: dropping it is a change made in the review.
      await page.getByRole("button", { name: "Fix" }).click();
      await page.getByRole("button", { name: "Drop line" }).click();
      const copyAsking = page.getByRole("dialog", {
        name: "Discard your review changes?",
      });
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(copyAsking).toBeVisible();
      await expect(copyAsking).toContainText(
        "The cards you picked or removed while checking this list won't be kept."
      );
      await expect(copyAsking).not.toContainText(/paste/i);
      await expect(asking(page)).toHaveCount(0);
      await expectPageChecks(page, "the copy's discard question");
      await copyAsking.getByRole("button", { name: "Keep editing" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await copyAsking.getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(/\/catalog/);
    });

    test("Import a decklist asks the same way for a pasted list, and a Deck name alone is not one", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      await page.goto(`${ORIGIN}/decks/import`);
      await expect(
        page.getByRole("heading", { name: "Import a decklist", level: 1 })
      ).toBeVisible();
      await page.getByLabel("Deck name").fill("Garden new");
      await page.getByRole("link", { name: "‹ Decks", exact: true }).click();
      await expect(page).toHaveURL(/\/decks$/);
      await expect(asking(page)).toHaveCount(0);

      await page.goto(`${ORIGIN}/decks/import`);
      await page.getByLabel("Deck name").fill("Garden new");
      await decklist(page).fill(PASTE);
      await page.getByRole("link", { name: "‹ Decks", exact: true }).click();
      await expect(asking(page)).toBeVisible();
      await expect(asking(page)).toContainText(
        "Your pasted list will be discarded."
      );
      await expect(asking(page)).not.toContainText("Deck List stays");
      await asking(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(decklist(page)).toHaveValue(PASTE);
      await expect(page.getByLabel("Deck name")).toHaveValue("Garden new");
      await page.getByRole("link", { name: "‹ Decks", exact: true }).click();
      await asking(page).getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(/\/decks$/);
    });
  });
}
