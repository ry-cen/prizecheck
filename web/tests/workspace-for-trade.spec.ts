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

const STILL_OFFERED = "Its cards are still offered for trade.";

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
