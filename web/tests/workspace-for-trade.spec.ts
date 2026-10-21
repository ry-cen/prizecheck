// Ticket #267: For trade Locations (Trading spec "For trade Locations and the Trade List"). For trade, in a
// Location's settings (#292), covers everything inside the Location apart from Decks; the rows inside say "For trade because <parent>
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
const gear = (scope: Locator, path: string) =>
  scope.getByRole("button", { name: `Settings for ${path}`, exact: true });
const settingsOf = (page: Page, path: string) =>
  page.getByRole("dialog", { name: path, exact: true });

const STILL_OFFERED = "Still on your Trade List";

type Ui = {
  /** The Locations tree's scope: the sidebar, or the open drawer. */
  tree: () => Promise<Locator>;
  /** Opens Manage locations and returns its panel. */
  manage: () => Promise<Locator>;
};

/** The whole story, at whichever width the describe block sets. */
async function markAndCheck(page: Page, ui: Ui) {
  await signIn(page);
  const storage = await create(page, "Storage");
  const binder = await create(page, "Binder 1", storage);
  await createDeck(page, "Lugia Deck", storage);
  await create(page, "Shelf");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");

  let tree = await ui.tree();
  await button(tree, "Storage").click();
  await expect(gear(tree, "Storage / Binder 1")).toBeVisible();

  // Mark the box: everything inside it is For trade, apart from the Deck.
  const storageSettings = settingsOf(page, "Storage");
  await gear(tree, "Storage").click();
  await button(storageSettings, "Mark Storage For trade").click();
  await expect(storageSettings.getByRole("status")).toHaveText(
    "Storage and everything in it, apart from Decks, are For trade."
  );
  await expect(storageSettings).toContainText("Folder · For trade");
  // Focus stays on the control that was used.
  await expect(
    button(storageSettings, "Mark Storage Not for trade")
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();

  let panel = await ui.manage();
  await expect(row(panel, "Storage")).toBeVisible();
  await expect(row(panel, "Storage / Binder 1")).toContainText(
    "For trade because Storage is."
  );
  await expect(row(panel, "Storage / Lugia Deck")).not.toContainText(
    "For trade because"
  );
  await expect(row(panel, "Shelf")).not.toContainText("For trade because");
  await button(panel, "Close manage locations").click();
  await expect(panel).toBeHidden();

  tree = await ui.tree();
  const shelfSettings = settingsOf(page, "Shelf");
  await gear(tree, "Shelf").click();
  await expect(button(shelfSettings, "Mark Shelf For trade")).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(shelfSettings).toBeHidden();

  // A Location inside the marked one can't be un-marked on its own: the control is off and says why.
  const binderSettings = settingsOf(page, "Storage / Binder 1");
  await gear(tree, "Storage / Binder 1").click();
  const inherited = button(
    binderSettings,
    "Mark Storage / Binder 1 Not for trade"
  );
  await expect(inherited).toBeDisabled();
  await expect(inherited).toHaveAccessibleDescription(
    "For trade because Storage is."
  );
  await expect(inherited).toHaveAttribute(
    "title",
    "For trade because Storage is."
  );
  await page.keyboard.press("Escape");
  await expect(binderSettings).toBeHidden();
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

  // A Deck can't be marked: its settings have no For trade button.
  const deckSettings = settingsOf(page, "Storage / Lugia Deck");
  await gear(tree, "Storage / Lugia Deck").click();
  await expect(
    deckSettings.getByRole("button", { name: /^Mark / })
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(deckSettings).toBeHidden();

  // A page added later is For trade too.
  await create(page, "Binder 2", storage);
  // Adding a page changes Storage, so the tree is read again before Storage's own settings change it.
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
  panel = await ui.manage();
  await expect(row(panel, "Storage / Binder 2")).toContainText(
    "For trade because Storage is."
  );

  // Hidden and For trade: the screen says its cards are still offered.
  await expect(panel).not.toContainText(STILL_OFFERED);
  await button(panel, "Close manage locations").click();
  await expect(panel).toBeHidden();
  tree = await ui.tree();
  await button(tree, "Storage").click();
  await gear(tree, "Storage").click();
  await button(storageSettings, "Hide Storage from Friends").click();
  await expect(storageSettings.getByRole("status")).toHaveText(
    "Storage and everything in it are hidden from Friends."
  );
  await expect(storageSettings).toContainText(
    "Folder · Hidden from Friends · For trade"
  );
  await expect(storageSettings).toContainText(STILL_OFFERED);
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();
  panel = await ui.manage();
  await expect(row(panel, "Storage")).toContainText(STILL_OFFERED);
  await expect(row(panel, "Storage / Binder 1")).toContainText(STILL_OFFERED);
  await expect(row(panel, "Storage / Lugia Deck")).not.toContainText(
    STILL_OFFERED
  );
  await expect(row(panel, "Shelf")).not.toContainText(STILL_OFFERED);
  await button(panel, "Close manage locations").click();
  await expect(panel).toBeHidden();

  // Un-marking the box leaves it hidden, and the line goes.
  tree = await ui.tree();
  await gear(tree, "Storage").click();
  await button(storageSettings, "Mark Storage Not for trade").click();
  await expect(storageSettings.getByRole("status")).toHaveText(
    "Storage is no longer For trade."
  );
  await expect(storageSettings).toContainText("Folder · Hidden from Friends");
  await expect(storageSettings).not.toContainText(STILL_OFFERED);
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();
  await gear(tree, "Storage / Binder 1").click();
  await expect(
    button(binderSettings, "Mark Storage / Binder 1 For trade")
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(binderSettings).toBeHidden();
}

const desktopUi = (page: Page): Ui => ({
  tree: async () =>
    page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" }),
  manage: async () => {
    await button(
      page.getByRole("complementary", { name: "Sidebar" }),
      "Manage locations"
    ).click();
    return panelOf(page);
  },
});

/** The drawer opens only when it is shut: a Location's settings leave it open behind them. */
const mobileUi = (page: Page): Ui => {
  const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
  const tree = async () => {
    if (await drawer.isHidden()) {
      await button(page.getByRole("banner"), "Open locations").click();
    }
    await expect(drawer).toBeVisible();
    return drawer;
  };
  return {
    tree,
    manage: async () => {
      await tree();
      await button(drawer, "Manage locations").click();
      await expect(drawer).toBeHidden();
      return panelOf(page);
    },
  };
};

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("marking a box For trade covers what is inside it but its Deck, and a hidden For trade box says its cards are still offered", async ({
    page,
  }) => {
    await markAndCheck(page, desktopUi(page));
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
    const ui = mobileUi(page);
    await markAndCheck(page, ui);
    const tree = await ui.tree();
    await gear(tree, "Storage").click();
    const settings = settingsOf(page, "Storage");
    await expectTouchTarget(button(settings, "Mark Storage For trade"), [
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
  openSettings: (path: string) => Promise<Locator>
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

  // Un-marking in the Location's settings clears the marks without a reload.
  let settings = await openSettings("Storage");
  await button(settings, "Mark Storage Not for trade").click();
  await expect(settings.getByRole("status")).toHaveText(
    "Storage is no longer For trade."
  );
  await button(settings, "Close settings").click();
  await expect(settings).toBeHidden();
  tree = await openTree();
  await expect(tree.getByTestId("for-trade-mark")).toHaveCount(0);
  await expect(button(tree, "Storage")).toHaveAccessibleDescription(
    "Hidden from Friends"
  );

  // Marking again in the Location's settings brings the marks back without a reload.
  settings = await openSettings("Storage");
  await button(settings, "Mark Storage For trade").click();
  await expect(settings.getByRole("status")).toContainText("For trade");
  await button(settings, "Close settings").click();
  await expect(settings).toBeHidden();
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
      async (path) => {
        await gear(sidebar, path).click();
        return settingsOf(page, path);
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
    // A Location's settings stack over the drawer and leave it open, so it opens only when it is shut.
    const openDrawer = async () => {
      if (await drawer.isHidden()) {
        await button(page.getByRole("banner"), "Open locations").click();
      }
      await expect(drawer).toBeVisible();
      return drawer;
    };
    await sidebarMarks(page, openDrawer, async (path) => {
      await openDrawer();
      await gear(drawer, path).click();
      return settingsOf(page, path);
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
