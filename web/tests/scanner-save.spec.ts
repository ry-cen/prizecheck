import { test } from "./support/art-upstream";
// Ticket #318: Confirm in the scanner's tray. It adds the tray to one Storage Leaf in one step and lands on Collection with
// the toast and no Undo (a full navigation); the server's EDITIONS_CHANGED marks exactly the rows whose finish is gone;
// DESTINATION_CHANGED reopens the picker with the rows kept; a response lost on the way freezes the tray with Retry, and the
// retry replays the same save, so the cards are added once; an unanswered save past 29 days is dropped with a note.
import { expect, type Page } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";
import {
  createLeaf,
  deleteLocation,
  held,
  installScript,
  locationIds,
  openScanner,
  pickFinish,
  placements,
  printingIds,
  retireBulbasaurNormal,
  reviewTray,
  seedPopup,
  signInFresh,
  trayOpen,
  trayPeek,
} from "./support/scanner";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

const confirmButton = (page: Page, name: string | RegExp) =>
  trayOpen(page).getByRole("button", { name });

async function unsortedId(page: Page): Promise<string> {
  const leaf = (await locationIds(page)).find(
    (n) => n.name === "Unsorted" && n.parent_id === null
  );
  expect(leaf, "the owner has Unsorted").toBeTruthy();
  return leaf!.id;
}

/** Marks this document, so a later check can tell a full load (a new document, no mark) from client routing. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __scannerMark: boolean }).__scannerMark = true;
  });
}
const marked = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __scannerMark?: boolean }).__scannerMark
  );

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, hasTouch: size.phone });
    test.beforeEach(() => seedPopup());

    test("Confirm adds the tray to Unsorted and lands on Collection with a toast and no Undo", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: placements(ids["Bulbasaur"], ids["Switch"], ids["Switch"]),
      });
      await openScanner(page);
      await pickFinish(page, "Normal");
      await expect(trayPeek(page)).toContainText("3 cards");
      await reviewTray(page);
      await expect(
        confirmButton(page, "Add 3 cards to Unsorted")
      ).toBeEnabled();
      await expectPageChecks(page, `${size.name} scanner, tray ready to add`);

      await markDocument(page);
      await confirmButton(page, "Add 3 cards to Unsorted").click();
      await expect(page).toHaveURL(/\/collection(\?.*)?$/);
      await expect(page).not.toHaveURL(/\/scan/);
      expect(
        await marked(page),
        "Collection is a new document"
      ).toBeUndefined();
      const toast = page.getByRole("region", { name: "Notifications" });
      await expect(toast).toContainText("Added 3 cards to Unsorted");
      await expect(toast.getByRole("button", { name: "Undo" })).toHaveCount(0);

      expect(await held(page, await unsortedId(page))).toEqual([
        "1 Bulbasaur",
        "2 Switch",
      ]);
      // The tray is empty again.
      const rows = await page.evaluate(() =>
        Object.entries(localStorage)
          .filter(([k]) => k.startsWith("prizecheck:scanner:tray:v1:"))
          .map(([, v]) => (JSON.parse(v) as { rows: unknown[] }).rows.length)
      );
      expect(rows).toEqual([0]);
    });

    test("when the Locations cannot be read, the tray asks to reconnect and recovers", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await page.route("**/api/location-tree", (route) => route.abort());
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Switch");
      await reviewTray(page);
      await expect(trayOpen(page)).toContainText(
        "Can't load your Locations. Reconnect to add these cards."
      );
      await expect(
        confirmButton(page, /^Add cards|^Add 1 card/)
      ).toBeDisabled();
      await page.unroute("**/api/location-tree");
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(confirmButton(page, "Add 1 card to Unsorted")).toBeEnabled();
    });

    test("Close leaves by a full navigation", async ({ page }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}] });
      await openScanner(page);
      await markDocument(page);
      await page.getByRole("button", { name: "Close scanner" }).click();
      await expect(page).toHaveURL(/\/collection$/);
      expect(await marked(page)).toBeUndefined();
    });

    test("EDITIONS_CHANGED marks exactly the rows whose finish was withdrawn", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: placements(ids["Bulbasaur"], ids["Switch"]),
      });
      await openScanner(page);
      await pickFinish(page, "Normal");
      await expect(trayPeek(page)).toContainText("2 cards");
      // Opening the tray reads the printings once; the finish is withdrawn after that, so only the save finds out.
      const read = page.waitForResponse("**/api/scanner/printings");
      await reviewTray(page);
      await read;
      await retireBulbasaurNormal();
      await confirmButton(page, "Add 2 cards to Unsorted").click();

      const tray = trayOpen(page);
      await expect(tray).toContainText(
        "Nothing was added yet. Pick a finish for the marked cards, then add them."
      );
      const bulbasaur = tray.getByRole("listitem", { name: /^Bulbasaur/ });
      const switchRow = tray.getByRole("listitem", { name: /^Switch/ });
      await expect(bulbasaur).toContainText("Pick a finish");
      await expect(switchRow).not.toContainText("Pick a finish");
      await expect(tray).toContainText("1 row needs a finish.");
      await expect(tray).toContainText(
        "1 row needs a finish before you can add it."
      );
      await expect(confirmButton(page, /^Add 2 cards/)).toBeDisabled();
      // No chip is selected on the marked row.
      await expect(
        bulbasaur.getByRole("button", { pressed: true })
      ).toHaveCount(0);
      await expectPageChecks(page, `${size.name} scanner, rows need a finish`);
      expect(await held(page, await unsortedId(page))).toEqual([]);

      // Show jumps to the row; one tap on a finish clears it.
      await tray.getByRole("button", { name: "Show" }).click();
      await expect(bulbasaur).toBeFocused();
      await bulbasaur.getByRole("button", { name: "Reverse Holo" }).click();
      await expect(
        confirmButton(page, "Add 2 cards to Unsorted")
      ).toBeEnabled();
      await confirmButton(page, "Add 2 cards to Unsorted").click();
      await expect(page).toHaveURL(/\/collection(\?.*)?$/);
      expect(await held(page, await unsortedId(page))).toEqual([
        "1 Bulbasaur",
        "1 Switch",
      ]);
    });

    test("DESTINATION_CHANGED reopens the picker and keeps the rows", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const binder = await createLeaf(page, "Binder");
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Switch");
      await reviewTray(page);

      await trayOpen(page)
        .getByRole("button", { name: /Put cards in/ })
        .click();
      const picker = page.getByRole("dialog", { name: "Put cards in" });
      // Storage Leaves only, Unsorted among them.
      await expect(
        picker.getByRole("radio", { name: "Unsorted" })
      ).toBeVisible();
      await picker.getByRole("radio", { name: "Binder" }).click();
      await expect(picker).toBeHidden();
      await expect(confirmButton(page, "Add 1 card to Binder")).toBeEnabled();

      await deleteLocation(page, binder);
      await confirmButton(page, "Add 1 card to Binder").click();
      await expect(picker).toBeVisible();
      await expect(picker).toContainText(
        "Choose where to put these cards. Nothing was added yet."
      );
      await expectPageChecks(page, `${size.name} scanner, picker reopened`);
      await picker.getByRole("radio", { name: "Unsorted" }).click();
      await expect(trayOpen(page)).toContainText("Switch");
      await confirmButton(page, "Add 1 card to Unsorted").click();
      await expect(page).toHaveURL(/\/collection(\?.*)?$/);
      expect(await held(page, await unsortedId(page))).toEqual(["1 Switch"]);
    });

    test("a response lost on the way freezes the tray, and Retry replays the same save", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const keys: string[] = [];
      let calls = 0;
      await page.route("**/api/scanner/save", async (route) => {
        keys.push(
          (route.request().postDataJSON() as { idempotency_key: string })
            .idempotency_key
        );
        calls += 1;
        if (calls === 1) {
          // The server saves, and the answer never reaches the page.
          await route.fetch();
          await route.abort("connectionreset");
        } else await route.continue();
      });
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Switch");
      await reviewTray(page);
      await confirmButton(page, "Add 1 card to Unsorted").click();

      const tray = trayOpen(page);
      await expect(tray).toContainText(
        "The tray is locked until this finishes."
      );
      await expect(tray).toContainText(
        "The save didn't finish. Try again; your cards won't be added twice."
      );
      // Read-only while pending.
      await expect(
        tray.getByRole("button", { name: "Change card" })
      ).toBeDisabled();
      await expect(
        tray.getByRole("button", { name: "Clear tray" })
      ).toBeDisabled();
      await expect(
        tray.getByRole("button", { name: "One more Switch" })
      ).toBeDisabled();
      await expect(
        tray.getByRole("button", { name: "Remove Switch from the tray" })
      ).toBeDisabled();
      await expectPageChecks(page, `${size.name} scanner, save pending`);

      await tray.getByRole("button", { name: "Retry" }).click();
      await expect(page).toHaveURL(/\/collection(\?.*)?$/);
      expect(keys).toHaveLength(2);
      expect(keys[1], "Retry uses the same key").toBe(keys[0]);
      expect(await held(page, await unsortedId(page))).toEqual(["1 Switch"]);
      await expect(
        page.getByRole("region", { name: "Notifications" })
      ).toContainText("Added 1 card to Unsorted");
    });

    test("an unanswered save past 29 days is dropped with a note", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const session = await page.request.get("/auth/session").catch(() => null);
      void session;
      const { userId } = (await (
        await page.request.get(new URL("/auth/session", page.url()).href)
      ).json()) as { userId: string };
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await page.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [
          `prizecheck:scanner:tray:v1:${userId}`,
          JSON.stringify({
            v: 1,
            location_id: null,
            rows: [],
            pending_save: {
              key: "00000000-0000-4000-8000-000000000000",
              location_id: "00000000-0000-4000-8000-000000000001",
              items: [["e", "1"]],
              started_at: old,
            },
            updated_at: old,
          }),
        ] as const
      );
      await installScript(page, { frames: [{}] });
      void ids;
      await openScanner(page);
      await reviewTray(page);
      await expect(trayOpen(page)).toContainText(
        "This tray may already be in your Collection. Check before confirming again."
      );
      await expectPageChecks(page, `${size.name} scanner, old save note`);
    });
  });
}
