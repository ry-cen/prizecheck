import { test } from "./support/art-upstream";
// Ticket #318: the scanner's first-open and cannot-start screens. "Getting the scanner ready" with a bar only while
// something downloads; one screen for every reason the scanner cannot start, offering Search for cards, Import from another
// tracker, Try again and (with cards in the tray) Review tray. Only no camera, a denied camera and an unsupported browser
// name a cause; a failed load and no index built show the generic screen, which never says index, download or asset.
import { expect, type Page } from "@playwright/test";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import {
  installScript,
  openScanner,
  placements,
  printingIds,
  seedPopup,
  signInFresh,
  trayPeek,
} from "./support/scanner";

const SIZES = [
  { name: "desktop", viewport: { width: 1280, height: 800 }, phone: false },
  { name: "phone", viewport: { width: 375, height: 812 }, phone: true },
] as const;

const heading = (page: Page) =>
  page.getByRole("heading", { name: "The scanner can't start" });
const action = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true });

/** The screen says nothing about how the scanner is made or fetched. */
async function expectNoPlumbing(page: Page) {
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/index|download|asset|model|cache/i);
}

async function expectActions(page: Page, phone: boolean) {
  for (const name of [
    "Search for cards",
    "Import from another tracker",
    "Try again",
  ]) {
    if (phone) await expectTouchTarget(action(page, name));
    else await expect(action(page, name)).toBeVisible();
  }
}

for (const size of SIZES) {
  test.describe(size.name, () => {
    test.use({ viewport: size.viewport, hasTouch: size.phone });
    test.beforeEach(() => seedPopup());

    test("a denied camera is named, with how to allow it", async ({ page }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}], camera: "denied" });
      await openScanner(page);
      await expect(heading(page)).toBeVisible();
      await expect(
        page.getByText("The camera is blocked for PrizeCheck.")
      ).toBeVisible();
      const how = page.getByText("How to allow the camera");
      await how.click();
      await expect(
        page.getByText(/Settings, then Apps, then Safari/)
      ).toBeVisible();
      await expectActions(page, size.phone);
      // The tray is empty, so there is nothing to review.
      await expect(action(page, "Review tray")).toHaveCount(0);
      await expectPageChecks(page, `${size.name} cannot start, camera denied`);
    });

    test("no camera is named", async ({ page }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}], camera: "none" });
      await openScanner(page);
      await expect(heading(page)).toBeVisible();
      await expect(
        page.getByText("This device has no camera the scanner can use.")
      ).toBeVisible();
      await expect(page.getByText("How to allow the camera")).toHaveCount(0);
      await expectPageChecks(page, `${size.name} cannot start, no camera`);
    });

    test("a browser missing a capability is named, and says nothing else of it", async ({
      page,
    }) => {
      await signInFresh(page);
      await page.addInitScript(() => {
        Object.defineProperty(window, "OffscreenCanvas", {
          value: undefined,
          configurable: true,
        });
      });
      await installScript(page, { frames: [{}] });
      await openScanner(page);
      await expect(heading(page)).toBeVisible();
      await expect(
        page.getByText("This browser can't run the scanner.")
      ).toBeVisible();
      await expectNoPlumbing(page);
      await expectActions(page, size.phone);
    });

    test("a failed load shows the generic screen, with no cause", async ({
      page,
    }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}], assets: "cannot-start" });
      await openScanner(page);
      await expect(heading(page)).toBeVisible();
      await expect(page.getByText("The camera is blocked")).toHaveCount(0);
      await expect(page.getByText("no camera")).toHaveCount(0);
      await expect(page.getByText("This browser can't")).toHaveCount(0);
      await expectNoPlumbing(page);
      await expectPageChecks(page, `${size.name} cannot start, generic`);
    });

    test("with no index built, the real asset load gives the same generic screen", async ({
      page,
    }) => {
      // No stub script: the page asks the test stack for its manifest, which has no index.
      await signInFresh(page);
      await openScanner(page);
      await expect(heading(page)).toBeVisible({ timeout: 15_000 });
      await expectNoPlumbing(page);
      await expectActions(page, size.phone);
    });

    test("Review tray shows only when the tray holds cards, and opens it", async ({
      page,
    }) => {
      await signInFresh(page);
      const ids = await printingIds(page);
      // Cards scanned on an earlier visit are waiting in the tray.
      await installScript(
        page,
        { frames: placements(ids["Switch"]) },
        { frames: [{}], camera: "denied" }
      );
      await openScanner(page);
      await expect(trayPeek(page)).toContainText("Switch");
      await page.reload();
      await expect(heading(page)).toBeVisible();
      await expect(
        page.getByText(/Your tray still has 1 card\./)
      ).toBeVisible();
      await action(page, "Review tray").click();
      await expect(page.getByRole("dialog", { name: "Tray" })).toBeVisible();
      await expect(page.getByRole("dialog", { name: "Tray" })).toContainText(
        "Switch"
      );
    });

    test("Search for cards, Try again and Import from another tracker each lead somewhere", async ({
      page,
    }) => {
      await signInFresh(page);
      await installScript(page, { frames: [{}], camera: "denied" });
      await openScanner(page);
      await action(page, "Search for cards").click();
      const search = page.getByRole("dialog", { name: "Find this card" });
      await expect(search).toBeVisible();
      await search.getByRole("button", { name: "Back to scanning" }).click();
      await expect(search).toBeHidden();
      await expect(action(page, "Search for cards")).toBeFocused();

      await action(page, "Try again").click();
      await expect(heading(page)).toBeVisible();

      await action(page, "Import from another tracker").click();
      await expect(page).toHaveURL(/\/collection\/import$/);
    });

    test("first open shows the heading and a bar; a warm open shows the heading alone", async ({
      page,
    }) => {
      await signInFresh(page);
      await installScript(
        page,
        { frames: [{}], assets: "hold", progress: { loaded: 40, total: 100 } },
        // Reloaded: nothing left to download, so no bar.
        { frames: [{}], assets: "hold" }
      );
      await openScanner(page);
      await expect(
        page.getByRole("heading", { name: "Getting the scanner ready" })
      ).toBeVisible();
      await expect(page.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "40"
      );
      await expectNoPlumbing(page);
      await expectPageChecks(page, `${size.name} getting ready, first open`);

      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Getting the scanner ready" })
      ).toBeVisible();
      await expect(page.getByRole("progressbar")).toHaveCount(0);
    });
  });
}
