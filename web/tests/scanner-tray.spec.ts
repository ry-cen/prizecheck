// Ticket #318: the scanner screen and its tray, driven by the stub recognizer (frame injection). A lock adds a row with its
// default finish selected; a second placement counts it; a shutter with no candidate opens search; an unreachable printings
// route adds no row and says so; the tray survives a reload and belongs to its account; no image bytes leave the page.
// Every state runs the shared page check (axe, no horizontal scroll, 44 px targets on a phone) at 1280×800 and 375×812.
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { retireOwnerSeat } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";
import {
  empty,
  framesPlayed,
  hintPill,
  holding,
  installScript,
  openScanner,
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

const shutter = (page: Page) =>
  page.getByRole("button", { name: "Scan this card", exact: true });

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({
      viewport: size.viewport,
      hasTouch: size.phone,
    });
    test.beforeEach(() => seedPopup());

    test("a lock adds a row with its default finish selected, and a second placement counts it", async ({
      page,
    }) => {
      const bodies: { type: string | undefined; size: number }[] = [];
      page.on("request", (request) => {
        const data = request.postDataBuffer();
        if (request.method() !== "GET" && data)
          bodies.push({
            type: request.headers()["content-type"],
            size: data.length,
          });
      });
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: placements(ids["Bulbasaur"], ids["Bulbasaur"]),
      });
      await openScanner(page);

      // Nothing is said on the guide, and the page has no app header or tab bar.
      await expect(page.getByTestId("scanner-guide")).toBeVisible();
      await expect(page.getByRole("navigation")).toHaveCount(0);
      await expect(hintPill(page)).toHaveText("");

      const peek = trayPeek(page);
      await expect(peek).toContainText("Bulbasaur");
      await expect(peek).toContainText("×2");
      await expect(peek).toContainText("2 cards");
      await expectPageChecks(page, `${size.name} scanner, one row in the peek`);

      await reviewTray(page);
      // The tray is a sheet over a paused camera: scanning stops while it is open.
      await expect(
        trayOpen(page).getByRole("button", { name: "Keep scanning" })
      ).toBeFocused();
      const finishes = trayOpen(page).getByRole("group", {
        name: "Finish of Bulbasaur",
      });
      await expect(
        finishes.getByRole("button", { name: "Normal", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(
        finishes.getByRole("button", { name: "Reverse Holo", exact: true })
      ).toHaveAttribute("aria-pressed", "false");
      await expect(trayOpen(page)).not.toContainText("$");
      // Every image carries crossorigin="anonymous": the page is cross-origin isolated.
      expect(
        await page.evaluate(
          () =>
            [...document.images].filter((i) => i.crossOrigin !== "anonymous")
              .length
        )
      ).toBe(0);
      await expectPageChecks(page, `${size.name} scanner, tray open`);

      // One tap changes the finish; a tap on the selected one does nothing.
      await finishes.getByRole("button", { name: "Reverse Holo" }).click();
      await expect(
        finishes.getByRole("button", { name: "Reverse Holo" })
      ).toHaveAttribute("aria-pressed", "true");
      await finishes.getByRole("button", { name: "Reverse Holo" }).click();
      await expect(
        finishes.getByRole("button", { name: "Reverse Holo" })
      ).toHaveAttribute("aria-pressed", "true");

      // Back to the camera: focus returns to Review.
      await trayOpen(page)
        .getByRole("button", { name: "Keep scanning" })
        .click();
      await expect(trayOpen(page)).toBeHidden();
      await expect(peek.getByRole("button", { name: "Review" })).toBeFocused();

      // Nothing but small JSON ever left the page: no photo, no thumbnail.
      expect(bodies.length).toBeGreaterThan(0);
      for (const body of bodies) {
        expect(body.type).toContain("application/json");
        expect(body.size).toBeLessThan(4096);
      }
    });

    test("the shutter with no card opens search, and a pick adds the card", async ({
      page,
    }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}], shutter: "miss" });
      await openScanner(page);
      if (size.phone) await expectTouchTarget(shutter(page));
      await shutter(page).click();

      const search = page.getByRole("dialog", { name: "Find this card" });
      await expect(search).toBeVisible();
      await expect(search).toContainText("This card wasn't recognized.");
      const field = search.getByRole("searchbox", {
        name: "Search the catalog",
      });
      await expect(field).toBeFocused();
      if (size.phone)
        expect(await field.evaluate((e) => getComputedStyle(e).fontSize)).toBe(
          "16px"
        );
      await field.fill("Rare Candy");
      await expect(
        search.getByRole("button", { name: /^Rare Candy/ }).first()
      ).toBeVisible();
      await expectPageChecks(page, `${size.name} scanner, search`);
      await search
        .getByRole("button", { name: /^Rare Candy/ })
        .first()
        .click();

      await expect(search).toBeHidden();
      await expect(shutter(page)).toBeFocused();
      await expect(trayPeek(page)).toContainText("Rare Candy");
      await expect(trayPeek(page)).toContainText("×1");
    });

    test("a lock whose printings cannot be reached adds no row and says so", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await page.route("**/api/scanner/printings", (route) => route.abort());
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(hintPill(page)).toHaveText(
        "Can't reach PrizeCheck. Check your connection and scan again."
      );
      await expectPageChecks(page, `${size.name} scanner, offline hint`);
      await expect(trayPeek(page)).toContainText("Empty");
      await expect(trayPeek(page)).not.toContainText("Switch");
    });

    test("a lock no candidate of which can be added says to use the shutter", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await page.route("**/api/scanner/printings", (route) =>
        route.fulfill({
          json: {
            catalog_revision: 1,
            printings: [],
            missing: [ids["Switch"]],
          },
        })
      );
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(hintPill(page)).toHaveText(
        "Couldn't add this card. Tap the shutter to search."
      );
      await expect(trayPeek(page)).toContainText("Empty");
    });

    test("the tray survives a reload, and a second account on this device does not see it", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Switch");

      await page.reload();
      await expect(trayPeek(page)).toContainText("Switch");
      await expect(trayPeek(page)).toContainText("×1");
      const keys = await page.evaluate(() =>
        Object.keys(localStorage).filter((k) =>
          k.startsWith("prizecheck:scanner:tray:v1:")
        )
      );
      expect(keys).toHaveLength(1);

      // Another collector signs in on the same device.
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      try {
        await retireOwnerSeat(pool);
      } finally {
        await pool.end();
      }
      await page.context().clearCookies();
      await signInAsOwner(page, "/collection");
      await installScript(page, { frames: [{}] });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Empty");
      await expect(trayPeek(page)).not.toContainText("Switch");
      const after = await page.evaluate(() =>
        Object.keys(localStorage).filter((k) =>
          k.startsWith("prizecheck:scanner:tray:v1:")
        )
      );
      expect(
        after,
        "the first account's tray is still on the device"
      ).toContain(keys[0]);
    });

    test("an offline tray keeps its rows, disables finishes and Confirm, and recovers when the connection returns", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, { frames: placements(ids["Bulbasaur"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Bulbasaur");

      await page.route("**/api/scanner/printings", (route) => route.abort());
      await reviewTray(page);
      const tray = trayOpen(page);
      await expect(tray).toContainText(
        "You're offline. Reconnect to add these cards."
      );
      await expect(
        tray.getByRole("listitem", { name: /^Bulbasaur/ })
      ).toBeVisible();
      await expect(
        tray.getByRole("button", { name: "Normal", exact: true })
      ).toBeDisabled();
      await expect(
        tray.getByRole("button", { name: /^Add 1 card/ })
      ).toBeDisabled();
      await expectPageChecks(page, `${size.name} scanner, tray offline`);

      await page.unroute("**/api/scanner/printings");
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(tray).not.toContainText("You're offline");
      await expect(
        tray.getByRole("button", { name: /^Add 1 card/ })
      ).toBeEnabled();
      await expect(
        tray.getByRole("button", { name: "Normal", exact: true })
      ).toBeEnabled();
    });

    test("rows that need a finish stay in place with a banner, and a row whose card is gone opens search", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, { frames: placements(ids["Bulbasaur"]) });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Bulbasaur");
      // The catalog withdraws Normal, and another card in the tray no longer exists at all.
      await retireBulbasaurNormal();
      await page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) =>
          k.startsWith("prizecheck:scanner:tray:v1:")
        )!;
        const tray = JSON.parse(localStorage.getItem(key)!);
        tray.rows.push({
          id: "gone-row",
          printing_id: "00000000-0000-4000-8000-00000000dead",
          edition_id: "00000000-0000-4000-8000-00000000beef",
          count: 1,
          candidates: [],
          needs_pick: false,
        });
        localStorage.setItem(key, JSON.stringify(tray));
      });
      await page.reload();
      await reviewTray(page);
      const tray = trayOpen(page);
      await expect(tray).toContainText(
        "2 rows need a finish before you can add them."
      );
      await expect(tray).toContainText("2 rows need a finish.");
      await expect(
        tray.getByRole("button", { name: /^Add 2 cards/ })
      ).toBeDisabled();
      // The row stays in its place, newest first, with no chip selected.
      const rows = tray.getByRole("listitem");
      await expect(rows).toHaveCount(2);
      const bulbasaur = tray.getByRole("listitem", { name: /^Bulbasaur/ });
      await expect(bulbasaur).toContainText(
        "isn't listed for this card anymore"
      );
      await expect(
        bulbasaur.getByRole("button", { pressed: true })
      ).toHaveCount(0);
      // The row whose Printing is gone shows no chips and offers search.
      const gone = rows.filter({ hasText: "isn't in the catalog anymore" });
      await expect(gone).toHaveCount(1);
      await expect(gone.getByRole("group")).toHaveCount(1); // the stepper only
      await gone.getByRole("button", { name: "Change card" }).click();
      const search = page.getByRole("dialog", { name: "Change card" });
      await expect(search).toBeVisible();
      await expect(
        search.getByRole("searchbox", { name: "Search the catalog" })
      ).toBeFocused();
      await search.getByRole("searchbox").fill("Rare Candy");
      await search
        .getByRole("button", { name: /^Rare Candy/ })
        .first()
        .click();
      await expect(search).toBeHidden();
      await expect(gone).toHaveCount(0);
      await expect(
        tray.getByRole("listitem", { name: /^Rare Candy/ })
      ).toBeVisible();
      await expect(tray).toContainText(
        "1 row needs a finish before you can add it."
      );
    });

    test("the stepper's minus becomes a bin at 1, and Clear tray asks first", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: placements(ids["Bulbasaur"], ids["Bulbasaur"], ids["Switch"]),
      });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("3 cards");
      await reviewTray(page);
      const tray = trayOpen(page);
      await tray.getByRole("button", { name: "One fewer Bulbasaur" }).click();
      const bin = tray.getByRole("button", {
        name: "Remove Bulbasaur from the tray",
      });
      await expect(bin).toBeVisible();
      if (size.phone) await expectTouchTarget(bin);
      await bin.click();
      await expect(
        tray.getByRole("listitem", { name: /^Bulbasaur/ })
      ).toHaveCount(0);
      await expect(tray).toContainText("1 card");

      await tray.getByRole("button", { name: "Clear tray" }).click();
      const confirm = page.getByRole("dialog", { name: "Clear the tray?" });
      await expect(confirm).toContainText(
        "This removes 1 card from the tray. Nothing in your Collection changes."
      );
      await confirm.getByRole("button", { name: "Keep cards" }).click();
      await expect(
        tray.getByRole("listitem", { name: /^Switch/ })
      ).toBeVisible();
      await tray.getByRole("button", { name: "Clear tray" }).click();
      await page
        .getByRole("dialog", { name: "Clear the tray?" })
        .getByRole("button", { name: "Clear tray", exact: true })
        .click();
      await expect(tray).toContainText("The tray is empty.");
    });

    test("the lock sound is off until the collector turns it on, and the choice stays on the device", async ({
      page,
    }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}] });
      await openScanner(page);
      const toggle = page.getByRole("button", { name: "Lock sound" });
      await expect(toggle).toHaveAttribute("aria-pressed", "false");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-pressed", "true");
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Lock sound" })
      ).toHaveAttribute("aria-pressed", "true");
    });

    test("a full tray asks the collector to add the cards before scanning more", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const { userId } = (await (
        await page.request.get(new URL("/auth/session", page.url()).href)
      ).json()) as { userId: string };
      // 200 distinct Editions already wait in the tray.
      const rows = Array.from({ length: 200 }, (_, i) => ({
        id: `row-${i}`,
        printing_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        edition_id: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
        count: 1,
        candidates: [],
        needs_pick: false,
      }));
      await page.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [
          `prizecheck:scanner:tray:v1:${userId}`,
          JSON.stringify({
            v: 1,
            location_id: null,
            rows,
            pending_save: null,
            updated_at: new Date().toISOString(),
          }),
        ] as const
      );
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      const prompt = page.getByRole("dialog", {
        name: "The tray is full. Add these cards to your Collection before scanning more.",
      });
      await expect(prompt).toBeVisible();
      await expectPageChecks(page, `${size.name} scanner, tray full`);
      await prompt.getByRole("button", { name: "Review tray" }).click();
      await expect(trayOpen(page)).toBeVisible();
      await expect(trayOpen(page)).not.toContainText("Switch");
    });

    test("the most copies of one card says so, with a hint", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      const { userId } = (await (
        await page.request.get(new URL("/auth/session", page.url()).href)
      ).json()) as { userId: string };
      const printings = (await (
        await page.request.post(
          new URL("/api/scanner/printings", page.url()).href,
          {
            headers: { origin: new URL(page.url()).origin },
            data: { printing_ids: [ids["Switch"]] },
          }
        )
      ).json()) as { printings: { default_edition_id: string }[] };
      const edition = printings.printings[0].default_edition_id;
      // 9,999 copies of Switch's starting Edition already wait in other rows.
      const counts = [...Array(10).fill(999), 9];
      const rows = counts.map((count, i) => ({
        id: `row-${i}`,
        printing_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        edition_id: edition,
        count,
        candidates: [],
        needs_pick: false,
      }));
      await page.addInitScript(
        ([key, value]) => localStorage.setItem(key, value),
        [
          `prizecheck:scanner:tray:v1:${userId}`,
          JSON.stringify({
            v: 1,
            location_id: null,
            rows,
            pending_save: null,
            updated_at: new Date().toISOString(),
          }),
        ] as const
      );
      await installScript(page, { frames: placements(ids["Switch"]) });
      await openScanner(page);
      await expect(hintPill(page)).toHaveText(
        "That's the most copies of one card in a tray"
      );
    });

    test("a card that stays in the guide is counted once", async ({ page }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      await installScript(page, {
        frames: [...empty(2), ...holding(ids["Switch"], 60)],
      });
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("×1");
      // The card stays in the guide while many more frames play: it would lock again only after it left and came back.
      await framesPlayed(page, 30);
      await expect(trayPeek(page)).toContainText("×1");
      await expect(trayPeek(page)).not.toContainText("×2");
    });
  });
}
