// Ticket #320: the card scanner's entry points (spec "Web and delivery" Entry points, "Starting a Card Scan"). Scan cards
// in Collection's actions row, the camera button in the phone header and the Camera choice in Collection Import each
// open the scanner (SCANNER_PATH) by a full document load, never the client router, and never call
// POST /api/collection-imports. Camera hides Put cards in and Review import and offers Start scanning. Checked at
// 1280×800 and 375×812. The scanner page itself is #318; its cross-origin isolation is checked in #321.
import { test, expect, type Page } from "@playwright/test";
import { Pool } from "pg";
import { SCANNER_PATH } from "../src/scanner/route";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

/** Signs in as a new owner and lands on Collection. */
async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** Records every request that would create or replace an import draft. */
function watchImportPosts(page: Page): string[] {
  const posts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname.startsWith("/api/collection-imports")
    )
      posts.push(request.url());
  });
  return posts;
}

/** Marks this document, so a later check can tell a full load (a new document, no mark) from client routing. */
async function markDocument(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { __shellMark: boolean }).__shellMark = true;
  });
}

/** Runs `open`, which must leave the shell for the scanner by a document request to SCANNER_PATH. */
async function expectFullNavigation(page: Page, open: () => Promise<void>) {
  await markDocument(page);
  const loading = page.waitForRequest(
    (request) =>
      request.isNavigationRequest() &&
      new URL(request.url()).pathname === SCANNER_PATH
  );
  await open();
  await loading;
  await expect(page).toHaveURL(new RegExp(`${SCANNER_PATH}$`));
  expect(
    await page.evaluate(
      () => (window as unknown as { __shellMark?: boolean }).__shellMark
    ),
    "the scanner is a new document, not a route of the shell"
  ).toBeUndefined();
}

const actions = (page: Page) => page.getByRole("main");
const scanCards = (page: Page) =>
  actions(page).getByRole("button", { name: "Scan cards", exact: true });
const cameraTab = (page: Page) => page.getByRole("tab", { name: "Camera" });
const startScanning = (page: Page) =>
  page.getByRole("button", { name: "Start scanning" });

async function openImport(page: Page) {
  await actions(page).getByRole("button", { name: "Import…" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Import your collection"
  );
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Scan cards in the actions row opens the scanner by a full navigation", async ({
    page,
  }) => {
    const posts = watchImportPosts(page);
    await signIn(page);
    await expect(scanCards(page)).toBeVisible();
    // The camera button belongs to the phone header, which a desktop does not draw.
    await expect(
      page.getByRole("banner").getByRole("button", { name: "Scan cards" })
    ).toBeHidden();
    await expectFullNavigation(page, () => scanCards(page).click());
    expect(posts).toEqual([]);
  });

  test("Camera in Collection Import hides the destination and review, and Start scanning opens the scanner", async ({
    page,
  }) => {
    const posts = watchImportPosts(page);
    await signIn(page);
    await openImport(page);
    await expect(
      page
        .getByRole("tab")
        .evaluateAll((tabs) => tabs.map((t) => t.textContent))
    ).resolves.toEqual(["Upload a file", "Paste", "Camera"]);
    await expect(page.getByLabel("Put cards in")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review import" })
    ).toBeVisible();

    await cameraTab(page).click();
    await expect(cameraTab(page)).toHaveAttribute("aria-selected", "true");
    await expect(startScanning(page)).toBeVisible();
    await expect(page.getByLabel("Put cards in")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Review import" })
    ).toHaveCount(0);
    await expectPageChecks(page, "Collection Import, camera");

    // Choosing Camera and going back to Paste brings both back.
    await page.getByRole("tab", { name: "Paste" }).click();
    await expect(page.getByLabel("Put cards in")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Review import" })
    ).toBeVisible();
    await cameraTab(page).click();

    await expectFullNavigation(page, () => startScanning(page).click());
    expect(posts).toEqual([]);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the row reads Add cards, Scan cards, Import…, Select, the header keeps its camera button, and both open the scanner", async ({
    page,
  }) => {
    const posts = watchImportPosts(page);
    await signIn(page);
    const names = ["Add cards", "Scan cards", "Import…", "Select"];
    const boxes = [];
    for (const name of names) {
      const button = actions(page).getByRole("button", {
        name,
        exact: true,
      });
      boxes.push(await expectTouchTarget(button));
    }
    // The row wraps on a narrow phone, so the order is the reading order: by line, then left to right.
    for (let i = 1; i < boxes.length; i++) {
      const before = boxes[i - 1];
      const after = boxes[i];
      const sameLine = Math.abs(after.y - before.y) < before.height / 2;
      expect(
        sameLine ? after.x > before.x : after.y > before.y,
        `${names[i]} follows ${names[i - 1]}`
      ).toBe(true);
    }
    const camera = page
      .getByRole("banner")
      .getByRole("button", { name: "Scan cards" });
    await expectTouchTarget(camera);
    await expectPageChecks(page, "phone Collection, scan entries");

    await expectFullNavigation(page, () => camera.tap());
    expect(posts).toEqual([]);
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await expectFullNavigation(page, () => scanCards(page).tap());
    expect(posts).toEqual([]);
  });

  test("Camera in Collection Import fits a phone and opens the scanner", async ({
    page,
  }) => {
    const posts = watchImportPosts(page);
    await signIn(page);
    await openImport(page);
    await cameraTab(page).tap();
    await expect(startScanning(page)).toBeVisible();
    await expect(page.getByLabel("Put cards in")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Review import" })
    ).toHaveCount(0);
    await expectTouchTarget(cameraTab(page));
    await expectPageChecks(page, "phone Collection Import, camera");
    await expectFullNavigation(page, () => startScanning(page).tap());
    expect(posts).toEqual([]);
  });
});
