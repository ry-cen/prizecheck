import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";

type TreeNode = {
  id: string;
  name: string;
  parent_id: string | null;
  version: number;
};

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
  } finally {
    await pool.end();
  }
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await page
    .getByLabel("Email")
    .fill(process.env.OWNER_EMAIL || "owner@example.test");
  await page.getByRole("button", { name: "Send code" }).click();
  await expect.poll(() => messages(mail).length).toBeGreaterThan(before);
  await page
    .getByLabel("Six-digit code")
    .fill(JSON.parse(messages(mail).at(-1)!).otp);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** Creates "Shelf <suffix>" holding Binder 10 (a folder with Page 1), binder 2, Binder 1 and Box,
 * in that non-natural order. The server returns siblings in case-folded text order, so natural
 * order on screen comes from the client. Returns the shelf's name. */
async function seedShelf(page: Page): Promise<string> {
  const api = (path: string) => new URL(path, page.url()).href;
  const headers = { origin: new URL(page.url()).origin };
  const tree = async () => {
    const response = await page.request.get(api("/api/location-tree"));
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { locations: TreeNode[] }).locations;
  };
  const create = async (name: string, parentId: string | null) => {
    // Every child create bumps the parent's version, so read it fresh each time.
    const parentVersion = parentId
      ? (await tree()).find((node) => node.id === parentId)!.version
      : null;
    const response = await page.request.post(api("/api/location-tree"), {
      headers,
      data: {
        name,
        parent_id: parentId,
        parent_version: parentVersion,
        idempotency_key: randomUUID(),
      },
    });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { location: TreeNode }).location.id;
  };
  const shelf = `Shelf ${randomUUID().slice(0, 8)}`;
  const shelfId = await create(shelf, null);
  const binder10 = await create("Binder 10", shelfId);
  await create("binder 2", shelfId);
  await create("Binder 1", shelfId);
  await create("Box", shelfId);
  await create("Page 1", binder10);
  return shelf;
}

/** The named rows appear top to bottom in the given order. */
async function expectVerticalOrder(scope: Locator, names: string[]) {
  const tops: number[] = [];
  for (const name of names) {
    const box = await scope
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box, name).not.toBeNull();
    tops.push(box!.y);
  }
  for (let i = 1; i < tops.length; i++)
    expect(tops[i], `${names[i]} below ${names[i - 1]}`).toBeGreaterThan(
      tops[i - 1]
    );
}

const naturalOrder = ["Binder 1", "binder 2", "Binder 10", "Box"];

test("desktop workspace shows the Location tree in natural order and opens Storage Leaves", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await signIn(page);
  const shelf = await seedShelf(page);
  await page.reload();
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("All owned");
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    "prize-gold"
  );

  const nav = page.getByRole("navigation", { name: "Locations" });
  const shelfRow = nav.getByRole("button", { name: shelf, exact: true });
  const shelfList = nav.getByRole("list", { name: shelf, exact: true });
  await expect(shelfRow).toBeVisible();

  // The workspace is not held to the app-wide 900 px main cap.
  const main = await page.getByRole("main").boundingBox();
  expect(main!.width).toBeGreaterThan(1200);

  // Keyboard focus shows a visible ring on each control it reaches.
  for (let stop = 0; stop < 4; stop++) {
    await page.keyboard.press("Tab");
    const ring = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement;
      const style = getComputedStyle(element);
      return {
        tag: element.tagName,
        style: style.outlineStyle,
        width: parseFloat(style.outlineWidth),
      };
    });
    expect(ring.tag).not.toBe("BODY");
    expect(ring.style).toBe("solid");
    expect(ring.width).toBeGreaterThanOrEqual(2);
  }

  await expect(shelfRow).toHaveAttribute("aria-expanded", "false");
  await expect(shelfList).toHaveCount(0);
  await shelfRow.click();
  await expect(shelfRow).toHaveAttribute("aria-expanded", "true");
  await expectVerticalOrder(shelfList, naturalOrder);

  // Choosing a Storage Leaf updates the heading.
  const binder2 = shelfList.getByRole("button", {
    name: "binder 2",
    exact: true,
  });
  await binder2.click();
  await expect(heading).toHaveText("binder 2");
  await expect(binder2).toHaveAttribute("aria-current", "page");

  // A nested folder expands and collapses; toggling it leaves the heading alone.
  const binder10 = shelfList.getByRole("button", {
    name: "Binder 10",
    exact: true,
  });
  const page1 = shelfList.getByRole("button", { name: "Page 1", exact: true });
  await expect(binder10).toHaveAttribute("aria-expanded", "false");
  await expect(page1).toHaveCount(0);
  await binder10.click();
  await expect(binder10).toHaveAttribute("aria-expanded", "true");
  await page1.click();
  await expect(heading).toHaveText("Page 1");
  await binder10.click();
  await expect(binder10).toHaveAttribute("aria-expanded", "false");
  await expect(page1).toHaveCount(0);
  await expect(heading).toHaveText("Page 1");
  await shelfRow.click();
  await expect(shelfList).toHaveCount(0);

  await nav.getByRole("button", { name: "All owned", exact: true }).click();
  await expect(heading).toHaveText("All owned");

  // The existing Locations view still works, and its main nav links back here.
  await page
    .getByRole("navigation", { name: "App" })
    .getByRole("button", { name: "Locations view" })
    .click();
  await expect(page).toHaveURL(/\/locations$/);
  await expect(
    page.getByRole("navigation", { name: "Location tree" })
  ).toBeVisible();
  await page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: "Workspace", exact: true })
    .click();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(heading).toHaveText("All owned");
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("mobile Location drawer opens from the left, keeps natural order and closes", async ({
    page,
  }) => {
    await signIn(page);
    const shelf = await seedShelf(page);
    await page.reload();
    const heading = page.getByRole("heading", { level: 1 });
    const header = page.getByRole("banner");
    await expect(
      header.getByRole("searchbox", { name: "Search cards" })
    ).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Sidebar" })
    ).toBeHidden();

    const opener = header.getByRole("button", { name: "Open locations" });
    const size = await opener.boundingBox();
    expect(size!.width).toBeGreaterThanOrEqual(44);
    expect(size!.height).toBeGreaterThanOrEqual(44);

    await opener.click();
    const drawer = page.getByRole("dialog", { name: "Locations" });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Close locations" })
    ).toBeFocused();
    // Anchored left, and its motion lasts 150 ms or less.
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
    const seconds = await drawer.evaluate((element) =>
      parseFloat(getComputedStyle(element).animationDuration)
    );
    expect(seconds).toBeLessThanOrEqual(0.15);

    const nav = drawer.getByRole("navigation", { name: "Locations" });
    await nav.getByRole("button", { name: shelf, exact: true }).click();
    const shelfList = nav.getByRole("list", { name: shelf, exact: true });
    await expectVerticalOrder(shelfList, naturalOrder);

    // Choosing a Storage Leaf closes the drawer, updates the heading and returns focus.
    await shelfList.getByRole("button", { name: "Box", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(heading).toHaveText("Box");
    await expect(opener).toBeFocused();

    // Escape closes the drawer.
    await opener.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();

    // The close button closes it.
    await opener.click();
    await drawer.getByRole("button", { name: "Close locations" }).click();
    await expect(drawer).toBeHidden();
    await expect(heading).toHaveText("Box");

    // No motion under reduced motion.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await opener.click();
    await expect(drawer).toHaveCSS("animation-name", "none");
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  });
});
