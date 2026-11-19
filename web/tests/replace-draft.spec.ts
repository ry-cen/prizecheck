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

/**
 * Holds a save at the network until `release()`, then lets it through, or answers `status` (with the API's error code)
 * instead. The Replace save by default; `url` picks another, such as Create Deck's.
 */
async function holdSave(
  page: Page,
  {
    status,
    code,
    url = SAVE,
  }: { status?: number; code?: string; url?: RegExp } = {}
) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  releases.push(() => release());
  const keys: string[] = [];
  await page.route(url, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    keys.push(route.request().postDataJSON().idempotency_key);
    await gate;
    if (status)
      await route.fulfill({
        status,
        json: { detail: code ? { code } : "down" },
      });
    else await route.continue();
  });
  return { release, keys };
}

const failed = (page: Page) =>
  page.getByRole("dialog", { name: "Your list didn't save" });
const SAVED = `Replaced ${DECK}'s Deck List.`;
/** The question the browser's Back or a tab raises while the save is held. */
async function leaveWhileSaving(page: Page, via: "browser Back" | "shell tab") {
  // The review step has no back link: the page behind it is reached by the browser's Back or a tab.
  if (via === "browser Back") await page.goBack();
  else
    await tabs(page)
      .getByRole("link", { name: "Catalog", exact: true })
      .click();
  await expect(saving(page)).toBeVisible();
}
const landedResponse = (page: Page) =>
  page.waitForResponse((response) => SAVE.test(response.url()));

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

    test("B1: a Replace that is still saving asks before leaving and warns that a failure loses the paste; Stay keeps the page, and the save then lands in the Deck", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page);
      await startSave(page, id);
      expect(await warns(page)).toBe(true);

      await leaveWhileSaving(page, "browser Back");
      await expect(saving(page)).toContainText(
        `If you leave and it doesn't save, your pasted list for ${DECK} is lost.`
      );
      await expectPageChecks(page, "the still-saving question");
      await expect(
        saving(page).getByRole("button", { name: "Stay" })
      ).toBeFocused();
      await saving(page).getByRole("button", { name: "Stay" }).click();
      await expect(saving(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      hold.release();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(notifications(page)).toContainText(SAVED);
      await expect(
        notifications(page).getByRole("button", { name: "Undo" })
      ).toBeVisible();
      await expect(saving(page)).toHaveCount(0);
    });

    test("B2: a save that lands while the question is open doesn't take the page away; Stay then opens the saved Deck", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page);
      await startSave(page, id);
      await leaveWhileSaving(page, "browser Back");
      const answered = landedResponse(page);
      hold.release();
      await answered;
      // The Undo toast is offered just before the page would have moved on, so once it shows, the move has been decided.
      await expect(notifications(page)).toContainText(SAVED);
      await expect(saving(page)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await saving(page).getByRole("button", { name: "Stay" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(saving(page)).toHaveCount(0);
    });

    for (const via of ["browser Back", "shell tab"] as const)
      test(`B3: Leave on a question the save landed under goes where the ${via} went, with no second question`, async ({
        page,
      }) => {
        seedCatalog();
        await signIn(page);
        const id = await deckBuilder(page);
        const hold = await holdSave(page);
        await startSave(page, id);
        await leaveWhileSaving(page, via);
        const answered = landedResponse(page);
        hold.release();
        await answered;
        await expect(notifications(page)).toContainText(SAVED);
        await expect(saving(page)).toBeVisible();
        await saving(page).getByRole("button", { name: "Leave" }).click();
        await expect(page).toHaveURL(
          via === "browser Back" ? new RegExp(`/decks/${id}$`) : /\/catalog/
        );
        await expect(saving(page)).toHaveCount(0);
        await expect(asking(page)).toHaveCount(0);
      });

    test("B4: a save that fails under the question says so; Keep editing keeps the review, and the retry sends the same key", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, { status: 500 });
      await startSave(page, id);
      await leaveWhileSaving(page, "shell tab");
      hold.release();
      await expect(failed(page)).toBeVisible();
      await expect(failed(page)).toContainText(
        "Replacing may have completed. Press Replace Deck List again to check safely."
      );
      await expect(failed(page)).toContainText(
        "Discard your pasted list, or keep editing to try again."
      );
      await expectPageChecks(page, "the didn't-save question");
      await expect(
        failed(page).getByRole("button", { name: "Keep editing" })
      ).toBeFocused();
      await failed(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(failed(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();

      await page.unroute(SAVE);
      const retry = page.waitForRequest((request) => SAVE.test(request.url()));
      await page.getByRole("button", { name: "Replace Deck List" }).click();
      expect((await retry).postDataJSON().idempotency_key).toBe(hold.keys[0]);
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
    });

    test("B5: a save the catalog refuses under the question says so; Discard goes on, and Replace list… opens empty", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, {
        status: 409,
        code: "STALE_DECK_LIST",
      });
      await startSave(page, id);
      await leaveWhileSaving(page, "browser Back");
      hold.release();
      await expect(failed(page)).toBeVisible();
      await expect(failed(page)).toContainText(
        "This Deck's list changed after you checked it."
      );
      await failed(page).getByRole("button", { name: "Discard" }).click();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(failed(page)).toHaveCount(0);
      await page.unroute(SAVE);
      await replaceList(page, id);
      await expect(decklist(page)).toHaveValue("");
    });

    test("B6: a save that fails after the collector left shows a toast that stays, and doesn't move them", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, { status: 500 });
      await startSave(page, id);
      await page.clock.install();
      await leaveWhileSaving(page, "shell tab");
      await saving(page).getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(/\/catalog/);
      hold.release();
      const sticky = notifications(page).getByText(
        `Replacing ${DECK}'s Deck List may not have finished. Open ${DECK} to check.`
      );
      await expect(sticky).toBeVisible();
      await page.clock.runFor(6_000);
      await expect(sticky).toBeVisible();
      await expect(page).toHaveURL(/\/catalog/);
    });

    test("B7: a save that lands after the collector left shows the Undo toast and doesn't move them", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page);
      await startSave(page, id);
      await leaveWhileSaving(page, "shell tab");
      await saving(page).getByRole("button", { name: "Leave" }).click();
      await expect(page).toHaveURL(/\/catalog/);
      const answered = landedResponse(page);
      hold.release();
      await answered;
      await expect(notifications(page)).toContainText(SAVED);
      await expect(
        notifications(page).getByRole("button", { name: "Undo" })
      ).toBeVisible();
      await expect(page).toHaveURL(/\/catalog/);
    });

    for (const [status, toast] of [
      [undefined, undefined],
      [
        500,
        `Replacing ${DECK}'s Deck List may not have finished. Open ${DECK} to check.`,
      ],
      [
        404,
        `${DECK}'s Deck List wasn't replaced. Your pasted list wasn't kept.`,
      ],
    ] as const)
      test(`B9: a ${status ?? 200} that arrives after Leave is accepted but before the page goes treats the collector as gone: ${status ? "a toast that stays" : "the Undo toast"}, and no navigation of its own`, async ({
        page,
      }) => {
        seedCatalog();
        await signIn(page);
        const id = await deckBuilder(page);
        const hold = await holdSave(page, { status });
        await startSave(page, id);
        // Hold the router's own step back, so the page is still here when the save settles.
        await page.evaluate(() => {
          const real = window.history.back.bind(window.history);
          (window as unknown as { releaseBack: () => void }).releaseBack = () =>
            real();
          window.history.back = () => undefined;
        });
        await leaveWhileSaving(page, "browser Back");
        await saving(page).getByRole("button", { name: "Leave" }).click();
        await expect(saving(page)).toBeHidden();
        const answered = page.waitForResponse((response) =>
          SAVE.test(response.url())
        );
        hold.release();
        await answered;
        if (toast)
          await expect(notifications(page).getByText(toast)).toBeVisible();
        else await expect(notifications(page)).toContainText(SAVED);
        // Nothing but the collector's own choice moves the page.
        await expect(page).toHaveURL(new RegExp(`/decks/${id}/replace$`));
        await expect(failed(page)).toHaveCount(0);
        await page.evaluate(() =>
          (window as unknown as { releaseBack: () => void }).releaseBack()
        );
        await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
        if (toast)
          await expect(notifications(page).getByText(toast)).toBeVisible();
        else await expect(notifications(page)).toContainText(SAVED);
      });

    test("B10: a Replace that finds the Deck gone opens the Deck for a collector who stayed", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, { status: 404 });
      await startSave(page, id);
      hold.release();
      await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
      await expect(failed(page)).toHaveCount(0);
    });

    test("B11: while a save is in flight everything that changes what is saved is locked, and a failed save unlocks it", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, { status: 500 });
      await replaceList(page, id);
      await decklist(page).fill(`${PASTE}1 Zzyzx ZZZ 1\n`);
      await page.getByRole("button", { name: "Review 2 lines" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
      // The line the catalog doesn't know is dropped, so the review can be saved.
      await page
        .getByRole("listitem")
        .filter({ hasText: "Zzyzx" })
        .getByRole("button", { name: "Fix" })
        .click();
      await page.getByRole("button", { name: "Drop line" }).click();
      await page.getByRole("button", { name: /^All \d+$/ }).click();
      const iono = page.getByRole("listitem").filter({ hasText: "Iono" });
      const stray = page.getByRole("listitem").filter({ hasText: "Zzyzx" });
      const back = page.getByRole("button", { name: "Back to paste" });
      const everything = [
        back,
        iono.getByRole("button", { name: "Edition" }),
        stray.getByRole("button", { name: "Restore" }),
        page.getByRole("radio", { name: "Exact printings" }),
        page.getByRole("radio", { name: "Use cards I own" }),
      ];
      for (const control of everything) await expect(control).toBeEnabled();

      const sent = page.waitForRequest((request) => SAVE.test(request.url()));
      await page.getByRole("button", { name: "Replace Deck List" }).click();
      await sent;
      for (const control of everything) {
        await expect(control).toBeVisible();
        await expect(control).toBeDisabled();
      }
      // What only changes the view stays available.
      await expect(
        page.getByRole("button", { name: /^All \d+$/ })
      ).toBeEnabled();

      hold.release();
      await expect(page.getByRole("region", { name: "Save" })).toContainText(
        "Replacing may have completed. Press Replace Deck List again to check safely."
      );
      for (const control of everything) await expect(control).toBeEnabled();
      await back.click();
      await expect(decklist(page)).toHaveValue(`${PASTE}1 Zzyzx ZZZ 1\n`);
      await expect(decklist(page)).not.toHaveAttribute("readonly", "");
    });

    test("B13: a locked review keeps its text at full strength and passes the page checks: the Edition panel's instruction, the owned-cards explainer, and the controls that are disabled", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page);
      await replaceList(page, id);
      await decklist(page).fill(PASTE);
      await page.getByRole("button", { name: "Review 1 line" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
      await page
        .getByRole("listitem")
        .filter({ hasText: "Iono" })
        .getByRole("button", { name: "Edition" })
        .click();
      const panel = page.getByRole("group", { name: /^Edition for / });
      const instruction = panel.getByText(
        "Choose the Edition for these cards:"
      );
      const explainer = page.getByText(/^Also uses cards you own/);
      await expect(instruction).toBeVisible();

      /** The opacity the text is really drawn at: its own, times every ancestor's. */
      const drawn = (text: typeof instruction) =>
        text.evaluate((element) => {
          let opacity = 1;
          for (
            let node: Element | null = element;
            node;
            node = node.parentElement
          )
            opacity *= Number(getComputedStyle(node).opacity);
          return opacity;
        });
      expect(await drawn(instruction)).toBe(1);
      expect(await drawn(explainer)).toBe(1);

      const sent = page.waitForRequest((request) => SAVE.test(request.url()));
      await page.getByRole("button", { name: "Replace Deck List" }).click();
      await sent;
      // The panel's choices are disabled, and the words around them are not dimmed.
      await expect(panel.getByRole("button").first()).toBeDisabled();
      await expect(
        page.getByRole("radio", { name: "Exact printings" })
      ).toBeDisabled();
      expect(await drawn(instruction)).toBe(1);
      expect(await drawn(explainer)).toBe(1);
      await expectPageChecks(
        page,
        "the locked review with its Edition panel open"
      );
    });

    test("B12: a save that fails under the question moves focus to Keep editing and announces the details once", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, { status: 500 });
      await startSave(page, id);
      await leaveWhileSaving(page, "shell tab");
      const status = saving(page).getByRole("status");
      await expect(status).toHaveText("");
      await page.keyboard.press("Tab");
      await expect(
        saving(page).getByRole("button", { name: "Leave" })
      ).toBeFocused();
      hold.release();
      await expect(failed(page)).toBeVisible();
      await expect(
        failed(page).getByRole("button", { name: "Keep editing" })
      ).toBeFocused();
      await expect(failed(page).getByRole("status")).toContainText(
        "Replacing may have completed. Press Replace Deck List again to check safely."
      );
    });

    test("a save that fails with no question open keeps the message and the review, and the guard asks about the paste again", async ({
      page,
    }) => {
      seedCatalog();
      await signIn(page);
      const id = await deckBuilder(page);
      const hold = await holdSave(page, { status: 500 });
      await startSave(page, id);
      hold.release();
      await expect(page.getByRole("region", { name: "Save" })).toContainText(
        "Replacing may have completed. Press Replace Deck List again to check safely."
      );
      await expect(failed(page)).toHaveCount(0);
      await tabs(page)
        .getByRole("link", { name: "Catalog", exact: true })
        .click();
      await expect(asking(page)).toBeVisible();
      await asking(page).getByRole("button", { name: "Keep editing" }).click();
      await expect(
        page.getByRole("heading", { name: "Check the list", level: 1 })
      ).toBeVisible();
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

    for (const [status, code, toast] of [
      [
        409,
        "CATALOG_CHANGED",
        "Your Deck wasn't created. Your review changes weren't kept.",
      ],
      [
        500,
        undefined,
        "Creating your Deck may not have finished. Check All Decks.",
      ],
    ] as const)
      test(`B8: Create Deck from a copy that is still saving warns that the review changes are lost, and a ${status} after Leave shows a toast that stays, without a word about pasting`, async ({
        page,
      }) => {
        const world = copyWorld();
        await signIn(page);
        await page.goto(`${ORIGIN}/decks/import?publication=${world.copy}`);
        await page.getByRole("button", { name: "Review 3 lines" }).click();
        await page.getByRole("button", { name: "Fix" }).click();
        await page.getByRole("button", { name: "Drop line" }).click();
        const create = /\/api\/decks\/import$/;
        const hold = await holdSave(page, { status, code, url: create });
        const sent = page.waitForRequest(
          (request) => create.test(request.url()) && request.method() === "POST"
        );
        await page.getByRole("button", { name: "Create Deck" }).click();
        await sent;
        await tabs(page)
          .getByRole("link", { name: "Catalog", exact: true })
          .click();
        await expect(saving(page)).toContainText(
          "If you leave and it doesn't save, your review changes are lost."
        );
        await saving(page).getByRole("button", { name: "Leave" }).click();
        await expect(page).toHaveURL(/\/catalog/);
        hold.release();
        const sticky = notifications(page).getByText(toast);
        await expect(sticky).toBeVisible();
        await expect(sticky).not.toContainText(/paste/i);
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
