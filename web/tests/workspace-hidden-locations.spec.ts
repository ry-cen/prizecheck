// Ticket #249: Hidden Locations (spec "Blocks and Hidden Locations"). Hide from Friends is in a Location's settings
// (#292) and covers everything inside the Location; the rows inside say "Hidden because <parent> is hidden" and can't be shown on their
// own; the sidebar marks hidden Locations without changing their names.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

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

/** Creates a Location through the API under `parentId` and returns its id. */
async function create(
  page: Page,
  name: string,
  parentId: string | null = null
) {
  let parentVersion: number | null = null;
  if (parentId) {
    const tree = await page.request.get(`${ORIGIN}/api/location-tree`);
    const nodes = (
      (await tree.json()) as { locations: { id: string; version: number }[] }
    ).locations;
    parentVersion = nodes.find((node) => node.id === parentId)!.version;
  }
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: parentId,
      parent_version: parentVersion,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location.id;
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

test("hiding a parent marks everything inside it, and a Location inside can't be shown on its own", async ({
  page,
}) => {
  await signIn(page);
  const storage = await create(page, "Storage");
  const binders = await create(page, "Binders", storage);
  await create(page, "Binder 1", binders);
  await create(page, "Shelf");
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");

  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const nav = page.getByRole("navigation", { name: "Locations" }).first();
  const storageSettings = settingsOf(page, "Storage");
  await gear(nav, "Storage").click();
  await button(storageSettings, "Hide Storage from Friends").click();
  await expect(storageSettings.getByRole("status")).toHaveText(
    "Storage and everything in it are hidden from Friends."
  );
  await expect(
    button(storageSettings, "Show Storage to Friends")
  ).toBeEnabled();
  // Focus stays on the control that was used.
  await expect(
    button(storageSettings, "Show Storage to Friends")
  ).toBeFocused();
  await expect(storageSettings).toContainText("Folder · Hidden from Friends");
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();

  // Manage locations keeps only arranging: it no longer offers Hide or Show.
  await button(sidebar, "Manage locations").click();
  const panel = panelOf(page);
  await expect(row(panel, "Storage")).toContainText(
    "Folder · Hidden from Friends"
  );
  await expect(row(panel, "Storage / Binders")).toContainText(
    "Hidden because Storage is hidden"
  );
  await expect(row(panel, "Storage / Binders / Binder 1")).toContainText(
    "Hidden because Storage is hidden"
  );
  await expect(row(panel, "Shelf")).not.toContainText("Hidden");
  await expect(
    panel.getByRole("button", { name: / (from|to) Friends$/ })
  ).toHaveCount(0);
  await button(panel, "Close manage locations").click();

  // Inside a hidden Location the button is off: it can't be shown on its own.
  await button(nav, "Storage").click();
  await button(nav, "Binders").click();
  const binderPath = "Storage / Binders / Binder 1";
  const binderSettings = settingsOf(page, binderPath);
  await gear(nav, binderPath).click();
  const hideBinder = button(binderSettings, `Hide ${binderPath} from Friends`);
  await expect(hideBinder).toBeDisabled();
  await expect(hideBinder).toHaveAccessibleDescription(
    "Hidden because Storage is hidden"
  );
  await expect(hideBinder).toHaveAttribute(
    "title",
    "Hidden because Storage is hidden"
  );
  await page.keyboard.press("Escape");
  await expect(binderSettings).toBeHidden();

  // The sidebar marks them, keeping their names as the buttons' names.
  await expect(button(nav, "Storage")).toHaveAccessibleDescription(
    "Hidden from Friends"
  );
  await expect(button(nav, "Binders")).toHaveAccessibleDescription(
    "Hidden because Storage is hidden"
  );
  // A visible Location keeps its path tooltip as its description.
  await expect(button(nav, "Shelf")).not.toHaveAccessibleDescription(/Hidden/);

  // A Location hidden on its own stays hidden when its parent is shown again.
  await gear(nav, "Storage").click();
  await button(storageSettings, "Show Storage to Friends").click();
  await expect(storageSettings).not.toContainText("Hidden");
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();
  await gear(nav, binderPath).click();
  await expect(binderSettings).not.toContainText("Hidden");
  await button(binderSettings, `Hide ${binderPath} from Friends`).click();
  await expect(binderSettings).toContainText("Hidden from Friends");
  await page.keyboard.press("Escape");
  await expect(binderSettings).toBeHidden();
  await gear(nav, "Storage").click();
  await button(storageSettings, "Hide Storage from Friends").click();
  await expect(
    button(storageSettings, "Show Storage to Friends")
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();
  await gear(nav, binderPath).click();
  await expect(binderSettings).toContainText(
    "Hidden because Storage is hidden"
  );
  await page.keyboard.press("Escape");
  await expect(binderSettings).toBeHidden();
  await gear(nav, "Storage").click();
  await button(storageSettings, "Show Storage to Friends").click();
  await expect(
    button(storageSettings, "Hide Storage from Friends")
  ).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(storageSettings).toBeHidden();
  await gear(nav, binderPath).click();
  await expect(binderSettings).toContainText("Hidden from Friends");
});

// Added at integration (Settings › Privacy comes from #246).
test("Settings › Privacy lists the Locations hidden from Friends", async ({
  page,
}) => {
  await signIn(page);
  const storage = await create(page, "Storage");
  const binder = await create(page, "Binder", storage);
  await page.goto(`${ORIGIN}/settings`);
  const summary = page.getByRole("region", { name: "Hidden from Friends" });
  await expect(summary).toContainText("Friends can see every Location.");
  for (const id of [storage, binder]) {
    const tree = await page.request.get(`${ORIGIN}/api/location-tree`);
    const nodes = (
      (await tree.json()) as { locations: { id: string; version: number }[] }
    ).locations;
    const response = await page.request.put(
      `${ORIGIN}/api/location-tree/${id}/hidden`,
      {
        headers: { origin: ORIGIN },
        data: {
          hidden: true,
          version: nodes.find((node) => node.id === id)!.version,
          idempotency_key: randomUUID(),
        },
      }
    );
    expect(response.status()).toBe(200);
  }
  await page.reload();
  await expect(summary.getByRole("listitem")).toHaveText([
    "Storage",
    "Storage / Binder",
  ]);
});
