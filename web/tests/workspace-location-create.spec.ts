import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

type TreeNode = {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
  version: number;
};
type Holding = { edition_id: string; quantity: string };

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// Same sign-in as workspace-shell.spec.ts; copied so that spec stays untouched.
async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
  const before = messages(mail).length;
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/workspace`
  );
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByLabel("Email")).toBeVisible();
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

/** Seeding and assertions through the real API, same origin as the page. */
function api(page: Page) {
  const url = (path: string) => new URL(path, page.url()).href;
  const headers = () => ({ origin: new URL(page.url()).origin });
  const tree = async () => {
    const response = await page.request.get(url("/api/location-tree"));
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { locations: TreeNode[] }).locations;
  };
  const node = async (id: string) => (await tree()).find((n) => n.id === id)!;
  const children = async (parentId: string) =>
    (await tree())
      .filter((n) => n.parent_id === parentId)
      .map((n) => n.name)
      .sort();
  const create = async (name: string, parentId: string | null) => {
    // Every child create bumps the parent's version, so read it fresh each time.
    const parentVersion = parentId ? (await node(parentId)).version : null;
    const response = await page.request.post(url("/api/location-tree"), {
      headers: headers(),
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
  const deck = async (name: string) => {
    const response = await page.request.post(url("/api/decks"), {
      headers: headers(),
      data: { name, idempotency_key: randomUUID() },
    });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { location: TreeNode }).location.id;
  };
  const holdings = async (locationId: string) => {
    const response = await page.request.get(url(`/api/holdings/${locationId}`));
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { holdings: Holding[] }).holdings;
  };
  /** Puts `quantity` copies of a fixture card in a Storage Leaf. promote() truncates the catalog,
   * which removes every Holding in this stack, so each test stocks its own leaf after promoting. */
  const stock = async (locationId: string, quantity: string) => {
    execFileSync(
      ".venv/bin/python",
      [
        "-c",
        `from test_catalog_search import promote
promote({'card-1': 'Pikachu'})`,
      ],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    );
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const edition = (
        await pool.query(
          "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='card-1' AND e.descriptor->>'finish'='normal'"
        )
      ).rows[0].id as string;
      const response = await page.request.post(url("/api/holdings"), {
        headers: headers(),
        data: {
          location_id: locationId,
          edition_id: edition,
          quantity,
          idempotency_key: randomUUID(),
        },
      });
      expect(response.status()).toBe(200);
    } finally {
      await pool.end();
    }
  };
  return { tree, node, children, create, deck, holdings, stock };
}

const suffix = () => randomUUID().slice(0, 8);
const row = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const addChild = (scope: Locator, path: string) =>
  scope.getByRole("button", {
    name: `Add child location to ${path}`,
    exact: true,
  });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("the root plus creates a top-level Location and selects it; name errors show inline", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const nav = sidebar.getByRole("navigation", { name: "Locations" });
    const heading = page.getByRole("heading", { level: 1 });
    const plus = sidebar.getByRole("button", {
      name: "Add location",
      exact: true,
    });
    const dialog = page.getByRole("dialog", { name: "Add location" });
    const nameField = dialog.getByLabel("Name", { exact: true });
    const parentField = dialog.getByLabel("Parent location");
    const alert = dialog.getByRole("alert");

    await plus.click();
    await expect(dialog).toBeVisible();
    await expect(nameField).toBeFocused();
    await expect(parentField.locator("option:checked")).toHaveText("Top level");

    // An empty name is rejected inline.
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(alert).toHaveText("Enter a name of 1 to 120 characters.");
    await expect(dialog).toBeVisible();

    const name = `Root ${suffix()}`;
    await nameField.fill(name);
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog).toBeHidden();
    await expect(heading).toHaveText(name);
    await expect(row(nav, name)).toHaveAttribute("aria-current", "page");
    await expect(plus).toBeFocused();
    const created = (await client.tree()).filter((n) => n.name === name);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ parent_id: null, kind: "storage_leaf" });

    // A sibling name that differs only in case is rejected inline; Escape closes without creating.
    await plus.click();
    await nameField.fill(name.toUpperCase());
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(alert).toHaveText(
      "A Location with that name already exists under this parent."
    );
    await expect(nameField).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(plus).toBeFocused();

    // Cancel and a backdrop click also close without creating.
    await plus.click();
    await nameField.fill(`Never ${suffix()}`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await plus.click();
    await nameField.fill(`Never ${suffix()}`);
    await page.mouse.click(20, 880);
    await expect(dialog).toBeHidden();
    expect(
      (await client.tree()).filter(
        (n) => n.name.toLowerCase() === name.toLowerCase()
      )
    ).toHaveLength(1);
    expect(
      (await client.tree()).filter((n) => n.name.startsWith("Never "))
    ).toHaveLength(0);
    await expect(heading).toHaveText(name);
  });

  test("Add child shows on hover or focus, never on Decks, and expands the new Location's ancestors", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const shelf = `Shelf ${suffix()}`;
    const shelfId = await client.create(shelf, null);
    await client.create("Box", shelfId);
    const deck = `Deck ${suffix()}`;
    await client.deck(deck);
    await page.reload();
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    const heading = page.getByRole("heading", { level: 1 });
    const dialog = page.getByRole("dialog", { name: "Add location" });
    const parentField = dialog.getByLabel("Parent location");
    const shelfRow = row(nav, shelf);
    const shelfList = nav.getByRole("list", { name: shelf, exact: true });
    const addShelf = addChild(nav, shelf);

    // Decks have no Add child control.
    await expect(row(nav, deck)).toBeVisible();
    await expect(addChild(nav, deck)).toHaveCount(0);

    // Hidden until the row is hovered or holds keyboard focus.
    await expect(addShelf).toHaveCSS("opacity", "0");
    await shelfRow.hover();
    await expect(addShelf).toHaveCSS("opacity", "1");
    const rowBox = (await shelfRow.boundingBox())!;
    const addBox = (await addShelf.boundingBox())!;
    const entryBox = (await shelfRow
      .locator("xpath=ancestor::*[contains(@class,'ws-tree-entry')][1]")
      .boundingBox())!;
    expect(Math.abs(addBox.width - 28)).toBeLessThanOrEqual(1);
    expect(Math.abs(addBox.height - rowBox.height)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(addBox.x + addBox.width - (rowBox.x + rowBox.width))
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(entryBox.width - rowBox.width)).toBeLessThanOrEqual(1);
    await page.mouse.move(1500, 850);
    await expect(addShelf).toHaveCSS("opacity", "0");
    await shelfRow.focus();
    await expect(addShelf).toHaveCSS("opacity", "1");
    await page.keyboard.press("Tab");
    await expect(addShelf).toBeFocused();
    await expect(addShelf).toHaveCSS("opacity", "1");

    // Add child preselects its parent. Shelf is collapsed; creating inside it expands it.
    await expect(shelfRow).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await expect(parentField.locator("option:checked")).toHaveText(shelf);
    const binder = `Binder ${suffix()}`;
    await dialog.getByLabel("Name", { exact: true }).fill(binder);
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog).toBeHidden();
    await expect(heading).toHaveText(binder);
    await expect(shelfRow).toHaveAttribute("aria-expanded", "true");
    await expect(row(shelfList, binder)).toHaveAttribute(
      "aria-current",
      "page"
    );

    // Choosing a deeper parent in the form expands every ancestor, including collapsed ones.
    await shelfRow.click();
    await expect(shelfRow).toHaveAttribute("aria-expanded", "false");
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: "Add location", exact: true })
      .click();
    await parentField.selectOption({ label: `${shelf} / Box` });
    const sleeve = `Sleeve ${suffix()}`;
    await dialog.getByLabel("Name", { exact: true }).fill(sleeve);
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog).toBeHidden();
    await expect(heading).toHaveText(sleeve);
    await expect(shelfRow).toHaveAttribute("aria-expanded", "true");
    await expect(row(shelfList, "Box")).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    await expect(row(shelfList, sleeve)).toHaveAttribute(
      "aria-current",
      "page"
    );
    // Decks are never offered as a parent.
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: "Add location", exact: true })
      .click();
    await expect(parentField.locator("option", { hasText: deck })).toHaveCount(
      0
    );
    await page.keyboard.press("Escape");
  });

  test("a stocked Storage Leaf can move its cards into the new child", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const box = `Box ${suffix()}`;
    const boxId = await client.create(box, null);
    await client.stock(boxId, "3");
    await page.reload();
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    const dialog = page.getByRole("dialog", { name: "Add location" });
    const page1 = `Page ${suffix()}`;

    await addChild(nav, box).click();
    await expect(
      dialog.getByLabel("Parent location").locator("option:checked")
    ).toHaveText(box);
    await dialog.getByLabel("Name", { exact: true }).fill(page1);
    await dialog.getByRole("button", { name: "Create location" }).click();
    const choices = dialog.getByRole("group", {
      name: `${box} contains cards. Where should they go?`,
    });
    await expect(choices).toBeVisible();
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(page1);

    // A choice is required.
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Choose where to keep the existing cards."
    );

    await choices.getByLabel(`Move existing cards into ${page1}`).check();
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(page1);
    await expect(row(nav, box)).toHaveAttribute("aria-expanded", "true");
    await expect(
      row(nav.getByRole("list", { name: box, exact: true }), page1)
    ).toHaveAttribute("aria-current", "page");

    expect((await client.node(boxId)).kind).toBe("organization");
    expect(await client.children(boxId)).toEqual([page1]);
    const pageId = (await client.tree()).find(
      (n) => n.parent_id === boxId && n.name === page1
    )!.id;
    expect((await client.holdings(pageId)).map((h) => h.quantity)).toEqual([
      "3",
    ]);
  });

  test("a stocked Storage Leaf can keep its cards in a separate Unsorted child", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const box = `Box ${suffix()}`;
    const boxId = await client.create(box, null);
    await client.stock(boxId, "2");
    await page.reload();
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    const dialog = page.getByRole("dialog", { name: "Add location" });
    const nameField = dialog.getByLabel("Name", { exact: true });

    await addChild(nav, box).click();
    await nameField.fill("unsorted");
    await dialog.getByRole("button", { name: "Create location" }).click();
    await dialog
      .getByLabel("Create a separate Unsorted child for existing cards")
      .check();
    await dialog.getByRole("button", { name: "Create location" }).click();
    // The new child can't take the name the Unsorted child needs.
    await expect(dialog.getByRole("alert")).toHaveText(
      "The separate Unsorted child needs a unique name. Use another name for the new Location, or move the cards into it."
    );
    await expect(dialog).toBeVisible();
    expect((await client.node(boxId)).kind).toBe("storage_leaf");
    expect(await client.children(boxId)).toEqual([]);

    const sleeve = `Sleeve ${suffix()}`;
    await nameField.fill(sleeve);
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(sleeve);
    const boxList = nav.getByRole("list", { name: box, exact: true });
    await expect(row(nav, box)).toHaveAttribute("aria-expanded", "true");
    await expect(row(boxList, sleeve)).toHaveAttribute("aria-current", "page");
    await expect(row(boxList, "Unsorted")).toBeVisible();

    expect(await client.children(boxId)).toEqual([sleeve, "Unsorted"].sort());
    const tree = await client.tree();
    const id = (name: string) =>
      tree.find((n) => n.parent_id === boxId && n.name === name)!.id;
    expect(
      (await client.holdings(id("Unsorted"))).map((h) => h.quantity)
    ).toEqual(["2"]);
    expect(await client.holdings(id(sleeve))).toEqual([]);
  });

  test("Cancel at the conversion choice leaves the stocked leaf and its cards unchanged", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const box = `Box ${suffix()}`;
    const boxId = await client.create(box, null);
    await client.stock(boxId, "1");
    await page.reload();
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    const dialog = page.getByRole("dialog", { name: "Add location" });

    await addChild(nav, box).click();
    await dialog.getByLabel("Name", { exact: true }).fill(`Page ${suffix()}`);
    await dialog.getByRole("button", { name: "Create location" }).click();
    await dialog.getByLabel(/^Move existing cards into /).check();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await expect(row(nav, box)).not.toHaveAttribute("aria-expanded");
    expect((await client.node(boxId)).kind).toBe("storage_leaf");
    expect(await client.children(boxId)).toEqual([]);
    expect((await client.holdings(boxId)).map((h) => h.quantity)).toEqual([
      "1",
    ]);
  });

  test("the depth limit shows inline", async ({ page }) => {
    await signIn(page);
    const client = api(page);
    let parentId: string | null = null;
    for (let level = 1; level <= 12; level++)
      parentId = await client.create(`Deep ${level} ${suffix()}`, parentId);
    await page.reload();
    const dialog = page.getByRole("dialog", { name: "Add location" });
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: "Add location", exact: true })
      .click();
    await dialog.getByLabel("Parent location").selectOption(parentId!);
    await dialog.getByLabel("Name", { exact: true }).fill("Too deep");
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "Locations can be nested at most 12 levels deep."
    );
    expect(await client.children(parentId!)).toEqual([]);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the drawer shows touch-sized create controls and Add child selects the new Location", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const shelf = `Shelf ${suffix()}`;
    const shelfId = await client.create(shelf, null);
    await client.create("Box", shelfId);
    const deck = `Deck ${suffix()}`;
    await client.deck(deck);
    await page.reload();
    const opener = page
      .getByRole("banner")
      .getByRole("button", { name: "Open locations" });
    const drawer = page.getByRole("dialog", { name: "Locations" });
    const nav = drawer.getByRole("navigation", { name: "Locations" });

    await opener.click();
    await expect(drawer).toBeVisible();
    // Geometry below is measured after the drawer's slide-in has finished.
    await expect.poll(async () => (await drawer.boundingBox())?.x).toBe(0);
    // The heading's Close stays the first focus stop; the + sits below it.
    await expect(
      drawer.getByRole("button", { name: "Close locations" })
    ).toBeFocused();
    await expectTouchTarget(
      drawer.getByRole("button", { name: "Add location", exact: true })
    );

    // Add child is always visible and 44 px tall; Decks have none.
    const addShelf = addChild(nav, shelf);
    await expect(addShelf).toBeVisible();
    await expect(addShelf).toHaveCSS("opacity", "1");
    const size = await expectTouchTarget(addShelf);
    const shelfBox = (await row(nav, shelf).boundingBox())!;
    expect(size.x).toBeGreaterThanOrEqual(shelfBox.x + shelfBox.width - 1);
    expect(Math.abs(size.y - shelfBox.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(size.height - shelfBox.height)).toBeLessThanOrEqual(1);
    await expect(row(nav, deck)).toBeVisible();
    await expect(addChild(nav, deck)).toHaveCount(0);

    await addShelf.tap();
    const dialog = page.getByRole("dialog", { name: "Add location" });
    await expect(drawer).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByLabel("Parent location").locator("option:checked")
    ).toHaveText(shelf);
    await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
    const binder = `Binder ${suffix()}`;
    await dialog.getByLabel("Name", { exact: true }).fill(binder);
    await dialog.getByRole("button", { name: "Create location" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(binder);
    await expect(opener).toBeFocused();

    await opener.click();
    await expect(row(nav, shelf)).toHaveAttribute("aria-expanded", "true");
    await expect(
      row(nav.getByRole("list", { name: shelf, exact: true }), binder)
    ).toHaveAttribute("aria-current", "page");
  });
});
