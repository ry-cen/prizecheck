// Ticket #267: For trade Locations (Trading spec "For trade Locations and the Trade List"). For trade in Manage
// locations covers everything inside the Location apart from Decks; the rows inside say "For trade because <parent>
// is." and can't be un-marked on their own; a Deck is refused in plain words; and a Location that is both
// hidden and For trade says its cards are still offered. At desktop width and at 375 px.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";
import { expectTouchTarget } from "./support/touch-target";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

type Node = { id: string; version: number };

async function nodes(page: Page): Promise<Node[]> {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  expect(response.ok()).toBeTruthy();
  return ((await response.json()) as { locations: Node[] }).locations;
}

const versionOf = async (page: Page, id: string) =>
  (await nodes(page)).find((node) => node.id === id)!.version;

/** Creates a Location through the API under `parentId` and returns its id. */
async function create(
  page: Page,
  name: string,
  parentId: string | null = null
) {
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: parentId,
      parent_version: parentId ? await versionOf(page, parentId) : null,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location.id;
}

/** Creates a Deck through the Deck route and moves it inside `parentId`. */
async function createDeck(page: Page, name: string, parentId: string) {
  const made = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(made.status()).toBe(201);
  const id = ((await made.json()) as { location: { id: string } }).location.id;
  const moved = await page.request.patch(`${ORIGIN}/api/decks/${id}`, {
    headers: { origin: ORIGIN },
    data: {
      parent_id: parentId,
      parent_version: await versionOf(page, parentId),
      version: await versionOf(page, id),
      idempotency_key: randomUUID(),
    },
  });
  expect(moved.status()).toBe(200);
  return id;
}

const panelOf = (page: Page) =>
  page.getByRole("dialog", { name: "Manage locations", exact: true });
const row = (panel: Locator, path: string) =>
  panel.getByRole("group", { name: path, exact: true });
const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

const STILL_OFFERED = "Still on your Trade List";

/** The whole story, at whichever width the describe block sets. `openPanel` opens Manage locations. */
async function markAndCheck(page: Page, openPanel: () => Promise<void>) {
  await signIn(page);
  const storage = await create(page, "Storage");
  const binder = await create(page, "Binder 1", storage);
  await createDeck(page, "Lugia Deck", storage);
  await create(page, "Shelf");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");

  await openPanel();
  const panel = panelOf(page);
  await expect(row(panel, "Storage")).toBeVisible();

  // Mark the box: everything inside it is For trade, apart from the Deck.
  await button(panel, "Mark Storage For trade").click();
  await expect(panel.getByRole("status")).toHaveText(
    "Storage and everything in it, apart from Decks, are For trade."
  );
  await expect(row(panel, "Storage")).toContainText("Folder · For trade");
  await expect(row(panel, "Storage / Binder 1")).toContainText(
    "For trade because Storage is."
  );
  await expect(row(panel, "Storage / Lugia Deck")).not.toContainText(
    "For trade because"
  );
  await expect(row(panel, "Shelf")).not.toContainText("For trade because");
  await expect(button(panel, "Mark Shelf For trade")).toBeEnabled();
  // Focus stays on the control that was used.
  await expect(button(panel, "Mark Storage Not for trade")).toBeFocused();

  // A Location inside the marked one can't be un-marked on its own: the control is off and says why.
  const inherited = button(panel, "Mark Storage / Binder 1 Not for trade");
  await expect(inherited).toBeDisabled();
  await expect(inherited).toHaveAttribute(
    "title",
    "For trade because Storage is."
  );
  // The server refuses it too, naming the marked Location.
  const refused = await page.request.put(
    `${ORIGIN}/api/location-tree/${binder}/for-trade`,
    {
      headers: { origin: ORIGIN },
      data: {
        for_trade: false,
        version: await versionOf(page, binder),
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toEqual({
    detail: { code: "LOCATION_FOR_TRADE_BY_PARENT", for_trade_by: storage },
  });

  // A Deck can't be marked, and the panel says so plainly.
  await button(panel, "Mark Storage / Lugia Deck For trade").click();
  await expect(panel.getByRole("alert")).toHaveText(
    "A Deck can't be marked For trade."
  );
  await expect(row(panel, "Storage / Lugia Deck")).not.toContainText(
    "For trade because"
  );

  // A page added later is For trade too.
  await button(panel, "Close manage locations").click();
  await expect(panel).toBeHidden();
  await create(page, "Binder 2", storage);
  await openPanel();
  await expect(row(panel, "Storage / Binder 2")).toContainText(
    "For trade because Storage is."
  );

  // Hidden and For trade: the screen says its cards are still offered.
  await expect(panel).not.toContainText(STILL_OFFERED);
  await button(panel, "Hide Storage from Friends").click();
  await expect(panel.getByRole("status")).toHaveText(
    "Storage and everything in it are hidden from Friends."
  );
  await expect(row(panel, "Storage")).toContainText(
    "Folder · Hidden from Friends · For trade"
  );
  await expect(row(panel, "Storage")).toContainText(STILL_OFFERED);
  await expect(row(panel, "Storage / Binder 1")).toContainText(STILL_OFFERED);
  await expect(row(panel, "Storage / Lugia Deck")).not.toContainText(
    STILL_OFFERED
  );
  await expect(row(panel, "Shelf")).not.toContainText(STILL_OFFERED);

  // Un-marking the box leaves it hidden, and the line goes.
  await button(panel, "Mark Storage Not for trade").click();
  await expect(panel.getByRole("status")).toHaveText(
    "Storage is no longer For trade."
  );
  await expect(row(panel, "Storage")).toContainText(
    "Folder · Hidden from Friends"
  );
  await expect(panel).not.toContainText(STILL_OFFERED);
  await expect(
    button(panel, "Mark Storage / Binder 1 For trade")
  ).toBeEnabled();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("marking a box For trade covers what is inside it but its Deck, and a hidden For trade box says its cards are still offered", async ({
    page,
  }) => {
    await markAndCheck(page, async () => {
      await button(
        page.getByRole("complementary", { name: "Sidebar" }),
        "Manage locations"
      ).click();
    });
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the same at 375 px, with touch-sized For trade buttons", async ({
    page,
  }) => {
    await markAndCheck(page, async () => {
      await button(page.getByRole("banner"), "Open locations").click();
      const drawer = page.getByRole("dialog", {
        name: "Locations",
        exact: true,
      });
      await button(drawer, "Manage locations").click();
      await expect(drawer).toBeHidden();
    });
    const panel = panelOf(page);
    await expectTouchTarget(button(panel, "Mark Storage For trade"), [
      "height",
    ]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(375);
  });
});

/** Marks (or hides) a Location through the API. */
async function setFlag(
  page: Page,
  id: string,
  flag: "for-trade" | "hidden",
  on = true
) {
  const response = await page.request.put(
    `${ORIGIN}/api/location-tree/${id}/${flag}`,
    {
      headers: { origin: ORIGIN },
      data: {
        [flag === "hidden" ? "hidden" : "for_trade"]: on,
        version: await versionOf(page, id),
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status()).toBe(200);
}

/** Ticket #282: the sidebar marks For trade Locations like it marks hidden ones. `tree` returns the tree's scope. */
async function sidebarMarks(
  page: Page,
  openTree: () => Promise<Locator>,
  openManage: () => Promise<void>
) {
  await signIn(page);
  const storage = await create(page, "Storage");
  await create(page, "Binder 1", storage);
  await createDeck(page, "Lugia Deck", storage);
  await create(page, "Shelf");
  await setFlag(page, storage, "hidden");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");

  let tree = await openTree();
  const rowOf = (name: string) => button(tree, name);
  await button(tree, "Storage").click();
  await expect(rowOf("Binder 1")).toBeVisible();
  // Nothing is marked yet.
  await expect(tree.getByTestId("for-trade-mark")).toHaveCount(0);

  await setFlag(page, storage, "for-trade");
  await page.reload();
  tree = await openTree();
  await button(tree, "Storage").click();
  const marks = tree.getByTestId("for-trade-mark");
  // Storage, and Binder 1 inside it; not the Deck, not Shelf.
  await expect(marks).toHaveCount(2);
  await expect(rowOf("Storage").getByTestId("for-trade-mark")).toHaveText(
    "For trade"
  );
  await expect(rowOf("Binder 1").getByTestId("for-trade-mark")).toHaveText(
    "For trade"
  );
  await expect(rowOf("Lugia Deck").getByTestId("for-trade-mark")).toHaveCount(
    0
  );
  await expect(rowOf("Shelf").getByTestId("for-trade-mark")).toHaveCount(0);
  // Hidden and For trade shows both marks on the one row; names are unchanged and the marks are descriptions.
  await expect(rowOf("Storage").getByTestId("hidden-mark")).toBeVisible();
  await expect(rowOf("Storage")).toHaveAccessibleDescription(
    "Hidden from Friends For trade"
  );
  await expect(rowOf("Binder 1")).toHaveAccessibleDescription(
    "Hidden because Storage is hidden For trade because Storage is."
  );
  // The Deck is hidden with its box but gets no For trade description.
  await expect(rowOf("Lugia Deck")).toHaveAccessibleDescription(
    "Hidden because Storage is hidden"
  );
  await expect(rowOf("Shelf")).not.toHaveAttribute("aria-describedby");

  // Un-marking in Manage locations clears the marks without a reload.
  await openManage();
  const panel = panelOf(page);
  await button(panel, "Mark Storage Not for trade").click();
  await expect(panel.getByRole("status")).toHaveText(
    "Storage is no longer For trade."
  );
  await button(panel, "Close manage locations").click();
  tree = await openTree();
  await expect(tree.getByTestId("for-trade-mark")).toHaveCount(0);
  await expect(button(tree, "Storage")).toHaveAccessibleDescription(
    "Hidden from Friends"
  );

  // Marking again in Manage locations brings the marks back without a reload.
  await openManage();
  await button(panelOf(page), "Mark Storage For trade").click();
  await expect(panelOf(page).getByRole("status")).toContainText("For trade");
  await button(panelOf(page), "Close manage locations").click();
  tree = await openTree();
  await expect(tree.getByTestId("for-trade-mark")).toHaveCount(2);
}

test.describe("sidebar marks, desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the sidebar shows For trade on a marked box and what is inside it, but not on its Deck", async ({
    page,
  }) => {
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await sidebarMarks(
      page,
      async () => sidebar,
      async () => {
        await button(sidebar, "Manage locations").click();
      }
    );
  });
});

test.describe("sidebar marks, mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the same at 375 px, with both marks on one row and no overflow", async ({
    page,
  }) => {
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    const openDrawer = async () => {
      await button(page.getByRole("banner"), "Open locations").click();
      await expect(drawer).toBeVisible();
      return drawer;
    };
    await sidebarMarks(page, openDrawer, async () => {
      await button(drawer, "Manage locations").click();
      await expect(drawer).toBeHidden();
    });
    // Both marks on a long-named row still fit inside the drawer.
    const long = await create(
      page,
      "A long Location name that has to be cut short to fit"
    );
    await setFlag(page, long, "hidden");
    await setFlag(page, long, "for-trade");
    await page.reload();
    const tree = await openDrawer();
    const longRow = tree.getByRole("button", { name: /^A long Location/ });
    await expect(longRow.getByTestId("hidden-mark")).toBeVisible();
    await expect(longRow.getByTestId("for-trade-mark")).toBeVisible();
    const box = await longRow.boundingBox();
    const drawerBox = await drawer.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(
      drawerBox!.x + drawerBox!.width
    );
    const mark = await longRow.getByTestId("for-trade-mark").boundingBox();
    expect(mark!.x + mark!.width).toBeLessThanOrEqual(box!.x + box!.width);
    expect(
      await longRow.evaluate((el) => el.scrollWidth <= el.clientWidth)
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(375);
  });
});
