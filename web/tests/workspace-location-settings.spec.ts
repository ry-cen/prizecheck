// Ticket #292: a settings gear on each sidebar Location (and each drawer row on a phone) opens that Location's own
// settings dialog: Rename, Move, Hide from Friends, For trade and Delete, or for a Deck Rename, Move, Hide from
// Friends and Open in Decks. Manage locations keeps only arranging.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

type TreeLocation = {
  id: string;
  name: string;
  kind: string;
  parent_id: string | null;
  version: number;
  copy_count: string;
};

// Same sign-in as workspace-shell.spec.ts; copied so that spec stays untouched.
async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await page.goto(
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/collection`
  );
  await expect(page).toHaveURL(/\/collection$/);
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toBeVisible();
  await signInAsOwner(page, "/collection");
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** Seeding and assertions through the real API, same origin as the page. Copied from
 * workspace-manage-locations.spec.ts so that spec stays untouched, plus rename(). */
function api(page: Page) {
  const url = (path: string) => new URL(path, page.url()).href;
  const headers = () => ({ origin: new URL(page.url()).origin });
  const tree = async () => {
    const response = await page.request.get(url("/api/location-tree"));
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as { locations: TreeLocation[] }).locations;
  };
  const node = async (id: string) => (await tree()).find((n) => n.id === id);
  const create = async (name: string, parentId: string | null) => {
    // Every child create bumps the parent's version, so read it fresh each time.
    const parentVersion = parentId ? (await node(parentId))!.version : null;
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
    return ((await response.json()) as { location: TreeLocation }).location.id;
  };
  const deck = async (name: string) => {
    const response = await page.request.post(url("/api/decks"), {
      headers: headers(),
      data: { name, idempotency_key: randomUUID() },
    });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { location: TreeLocation }).location.id;
  };
  /** Creates a Deck through the Deck route and moves it inside `parentId`. */
  const deckIn = async (name: string, parentId: string) => {
    const id = await deck(name);
    const moved = await page.request.patch(url(`/api/decks/${id}`), {
      headers: headers(),
      data: {
        parent_id: parentId,
        parent_version: (await node(parentId))!.version,
        version: (await node(id))!.version,
        idempotency_key: randomUUID(),
      },
    });
    expect(moved.status()).toBe(200);
    return id;
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
  /** Renames through the API, as another tab would. */
  const rename = async (id: string, name: string) => {
    const response = await page.request.patch(url(`/api/location-tree/${id}`), {
      headers: headers(),
      data: {
        name,
        version: (await node(id))!.version,
        idempotency_key: randomUUID(),
      },
    });
    expect(response.status()).toBe(200);
  };
  return { tree, node, create, deck, deckIn, stock, rename };
}

/** One Location's rows: the Hide from Friends note ends before its checkbox on the same row, and the Rename
 * button shares the checkbox's right edge. */
async function expectRowLayout(
  dialog: Locator,
  checkboxName: string,
  path: string
) {
  const hide = (await checkbox(dialog, checkboxName).boundingBox())!;
  const rename = (await button(dialog, `Rename ${path}`).boundingBox())!;
  const note = (await dialog
    .getByText("Friends can't see this Location")
    .boundingBox())!;
  expect(note.x + note.width).toBeLessThanOrEqual(hide.x);
  expect(hide.y).toBeGreaterThanOrEqual(note.y - 20);
  expect(hide.y).toBeLessThanOrEqual(note.y + note.height + 20);
  expect(
    Math.abs(rename.x + rename.width - (hide.x + hide.width))
  ).toBeLessThanOrEqual(30);
}

const sidebarNav = (page: Page) =>
  page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });
const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });
const checkbox = (scope: Locator, name: string) =>
  scope.getByRole("checkbox", { name, exact: true });
const gear = (scope: Locator, path: string) =>
  button(scope, `Settings for ${path}`);
/** A Location's settings dialog, by its full path (its title). A Rename or Move changes the name. */
const settingsOf = (page: Page, path: string) =>
  page.getByRole("dialog", { name: path, exact: true });

const DELETE_REASON = "Only an empty Location with no children can be deleted.";

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the gear appears on hover and keyboard focus, keeps the row in place, and opens the Location's own settings", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const binder = `${shelf} / Binder 1`;
    const shelfId = await client.create(shelf, null);
    await client.create("Binder 1", shelfId);
    const deckName = `${shelf} Deck`;
    const deckId = await client.deck(deckName);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, shelf).click();

    const row = button(nav, "Binder 1");
    const g = gear(nav, binder);
    await page.mouse.move(0, 0);
    await expect(g).toHaveCSS("opacity", "0");
    const before = (await row.boundingBox())!;
    await row.hover();
    await expect(g).toHaveCSS("opacity", "1");
    await expect.poll(() => row.boundingBox()).toEqual(before);
    const box = (await g.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(30);
    expect(box.height).toBeGreaterThanOrEqual(30);

    await g.click();
    const dialog = settingsOf(page, binder);
    await expect(dialog).toBeVisible();
    const frame = (await dialog.boundingBox())!;
    expect(Math.abs(frame.x + frame.width / 2 - 640)).toBeLessThanOrEqual(1);
    for (const name of [
      `Rename ${binder}`,
      `Move ${binder}`,
      `Delete ${binder}`,
    ])
      await expect(button(dialog, name)).toBeVisible();
    for (const name of [
      `Hide ${binder} from Friends`,
      `Mark ${binder} For trade`,
    ])
      await expect(checkbox(dialog, name)).toBeVisible();
    await expect(
      dialog.getByRole("link", { name: /^Open .* in Decks$/ })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(g).toBeFocused();

    // By keyboard: the row, then Add child, then the gear.
    await page.mouse.move(0, 0);
    await row.focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(g).toBeFocused();
    await expect(g).toHaveCSS("opacity", "1");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(g).toBeFocused();

    // A Deck's settings have only a Deck's actions.
    await gear(nav, deckName).click();
    const deckDialog = settingsOf(page, deckName);
    await expect(deckDialog).toBeVisible();
    await expect(button(deckDialog, `Rename ${deckName}`)).toBeVisible();
    await expect(button(deckDialog, `Move ${deckName}`)).toBeVisible();
    await expect(
      checkbox(deckDialog, `Hide ${deckName} from Friends`)
    ).toBeVisible();
    await expect(
      deckDialog.getByRole("button", { name: /^Delete / })
    ).toHaveCount(0);
    await expect(deckDialog.getByRole("checkbox")).toHaveCount(1);
    const link = deckDialog.getByRole("link", {
      name: `Open ${deckName} in Decks`,
    });
    await expect(link).toHaveAttribute(
      "href",
      `/decks/${encodeURIComponent(deckId)}`
    );
    await link.click();
    await expect(page).toHaveURL(
      new RegExp(`/decks/${encodeURIComponent(deckId)}$`)
    );
  });

  test("Rename and Move update the sidebar, the dialog title and the open heading at once", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const spare = `${shelf} Spare`;
    const shelfId = await client.create(shelf, null);
    const binder1 = await client.create("Binder 1", shelfId);
    await client.create("binder 2", shelfId);
    const spareId = await client.create(spare, null);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, shelf).click();
    await button(nav, "Binder 1").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Binder 1"
    );

    const path = `${shelf} / Binder 1`;
    await gear(nav, path).click();
    let dialog = settingsOf(page, path);
    await button(dialog, `Rename ${path}`).click();
    const form = dialog.getByRole("form", { name: `Rename ${path}` });
    const field = form.getByLabel("New name");
    await expect(field).toBeFocused();
    await expect(field).toHaveValue("Binder 1");
    await field.fill("BINDER 2");
    await button(form, "Save name").click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "A sibling already has that name."
    );
    expect((await client.node(binder1))!.name).toBe("Binder 1");

    await field.fill("Binder 1a");
    await button(form, "Save name").click();
    const renamed = `${shelf} / Binder 1a`;
    dialog = settingsOf(page, renamed);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText(
      "Renamed Binder 1 to Binder 1a."
    );
    await expect(button(dialog, `Rename ${renamed}`)).toBeFocused();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Binder 1a"
    );
    await expect(button(nav, "Binder 1a")).toBeVisible();
    expect((await client.node(binder1))!.name).toBe("Binder 1a");

    await button(dialog, `Move ${renamed}`).click();
    await button(
      dialog.getByRole("list", { name: "New parent" }),
      spare
    ).click();
    await button(dialog, "Move here").click();
    const moved = `${spare} / Binder 1a`;
    dialog = settingsOf(page, moved);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveText(
      `Moved Binder 1a to ${spare}.`
    );
    expect((await client.node(binder1))!.parent_id).toBe(spareId);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    const moveGear = gear(nav, moved);
    await expect(moveGear).toBeVisible();
    await expect(moveGear).toBeFocused();
  });

  test("Hide from Friends and For trade toggle in place, and a Location inside a hidden or For trade parent says why", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const storageId = await client.create("Storage", null);
    await client.create("Binder 1", storageId);
    await client.deckIn("Lugia Deck", storageId);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, "Storage").click();

    await gear(nav, "Storage").click();
    const storage = settingsOf(page, "Storage");
    const hideStorage = checkbox(storage, "Hide Storage from Friends");
    await expect(hideStorage).not.toBeChecked();
    await hideStorage.click();
    await expect(storage.getByRole("status")).toHaveText(
      "Storage and everything in it are hidden from Friends."
    );
    await expect(hideStorage).toBeChecked();
    await expect(hideStorage).toBeFocused();
    const tradeStorage = checkbox(storage, "Mark Storage For trade");
    await expect(tradeStorage).not.toBeChecked();
    await tradeStorage.click();
    await expect(storage.getByRole("status")).toHaveText(
      "Storage and everything in it, apart from Decks, are For trade."
    );
    await expect(tradeStorage).toBeChecked();
    await expect(tradeStorage).toBeFocused();
    await expect(storage).toContainText(
      "Folder · Hidden from Friends · For trade"
    );
    await expect(storage).toContainText("Still on your Trade List");
    await page.keyboard.press("Escape");
    await expect(storage).toBeHidden();
    await expect(button(nav, "Storage")).toHaveAccessibleDescription(
      "Hidden from Friends For trade"
    );

    await gear(nav, "Storage / Binder 1").click();
    const binder = settingsOf(page, "Storage / Binder 1");
    const hide = checkbox(binder, "Hide Storage / Binder 1 from Friends");
    await expect(hide).toBeDisabled();
    await expect(hide).toBeChecked();
    await expect(hide).not.toHaveAttribute("title");
    await expect(binder).toContainText("Hidden because Storage is hidden");
    await expect(hide).toHaveAccessibleDescription(
      "Hidden because Storage is hidden"
    );
    const trade = checkbox(binder, "Mark Storage / Binder 1 For trade");
    await expect(trade).toBeDisabled();
    await expect(trade).toBeChecked();
    await expect(binder).toContainText("For trade because Storage is.");
    await expect(trade).toHaveAccessibleDescription(
      "For trade because Storage is."
    );
    await page.keyboard.press("Escape");
    await expect(binder).toBeHidden();

    await gear(nav, "Storage / Lugia Deck").click();
    const lugia = settingsOf(page, "Storage / Lugia Deck");
    const deckHide = checkbox(lugia, "Hide Storage / Lugia Deck from Friends");
    await expect(deckHide).toBeDisabled();
    await expect(deckHide).toBeChecked();
    await expect(deckHide).toHaveAccessibleDescription(
      "Hidden because Storage is hidden"
    );
    await expect(lugia.getByRole("checkbox", { name: /^Mark / })).toHaveCount(
      0
    );
  });

  test("each setting is a row with its note on the left and its control on the right", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const storageId = await client.create("Storage", null);
    await client.create("Binder 1", storageId);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, "Storage").click();
    await gear(nav, "Storage").click();
    const storage = settingsOf(page, "Storage");
    await expect(storage).toContainText(
      "Friends can't see this Location or anything in it."
    );
    await expect(storage).toContainText(
      "Offer the cards here, apart from Decks, in trades."
    );
    await expect(button(storage, "Delete Storage")).toBeDisabled();
    await expect(storage).toContainText(
      "Only an empty Location with no children can be deleted."
    );

    await expectRowLayout(storage, "Hide Storage from Friends", "Storage");
  });

  test("a checkbox saved against a stale version says nothing was changed and keeps focus", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const storageId = await client.create("Storage", null);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, "Storage").click();
    await gear(nav, "Storage").click();
    const storage = settingsOf(page, "Storage");
    const trade = checkbox(storage, "Mark Storage For trade");
    await expect(trade).not.toBeChecked();
    // Another tab adds a child, which bumps Storage's version after this dialog read it.
    await client.create("Binder 1", storageId);
    await trade.click();
    await expect(storage.getByRole("alert")).toContainText(
      "nothing was changed"
    );
    await expect(trade).not.toBeChecked();
    await expect(trade).toBeFocused();
    expect((await client.node(storageId))!.for_trade).toBeFalsy();
  });

  test("Delete needs an empty Location without children, and deleting the open Location opens its parent", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const spare = `${shelf} Spare`;
    const shelfId = await client.create(shelf, null);
    const box = await client.create("Box", shelfId);
    await client.stock(box, "3");
    const binder10 = await client.create("Binder 10", shelfId);
    const page1 = await client.create("Page 1", binder10);
    const spareId = await client.create(spare, null);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, shelf).click();
    await button(nav, "Binder 10").click();

    for (const path of [`${shelf} / Box`, `${shelf} / Binder 10`, shelf]) {
      await gear(nav, path).click();
      const dialog = settingsOf(page, path);
      const del = button(dialog, `Delete ${path}`);
      await expect(del).toBeDisabled();
      await expect(del).toHaveAccessibleDescription(DELETE_REASON);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }

    const pagePath = `${shelf} / Binder 10 / Page 1`;
    await button(nav, "Page 1").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page 1");
    await gear(nav, pagePath).click();
    const dialog = settingsOf(page, pagePath);
    await button(dialog, `Delete ${pagePath}`).click();
    const form = dialog.getByRole("form", { name: `Delete ${pagePath}` });
    const field = form.getByLabel("Type Page 1 to confirm");
    await field.fill("page 1");
    await expect(button(form, "Delete location")).toBeDisabled();
    await field.fill("Page 1");
    await button(form, "Delete location").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("location-announcement")).toHaveText(
      `Deleted ${pagePath}.`
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Binder 10"
    );
    const parentRow = button(nav, "Binder 10");
    await expect(parentRow).toHaveAttribute("aria-current", "page");
    await expect(parentRow).toBeFocused();
    expect(await client.node(page1)).toBeUndefined();

    // A Location at the top level goes back to All owned.
    await button(nav, spare).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(spare);
    await gear(nav, spare).click();
    const spareDialog = settingsOf(page, spare);
    await button(spareDialog, `Delete ${spare}`).click();
    await spareDialog.getByLabel(`Type ${spare} to confirm`).fill(spare);
    await button(spareDialog, "Delete location").click();
    await expect(spareDialog).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await expect(button(nav, "All owned")).toBeFocused();
    expect(await client.node(spareId)).toBeUndefined();
  });

  test("a Delete the server refuses and a stale rename say why and change nothing", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const shelfId = await client.create(shelf, null);
    const binder1 = await client.create("Binder 1", shelfId);
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, shelf).click();

    const path = `${shelf} / Binder 1`;
    await gear(nav, path).click();
    let dialog = settingsOf(page, path);
    await button(dialog, `Delete ${path}`).click();
    const form = dialog.getByRole("form", { name: `Delete ${path}` });
    await form.getByLabel("Type Binder 1 to confirm").fill("Binder 1");
    // Cards arrive after the dialog read the Location, so the server refuses the Delete.
    await client.stock(binder1, "1");
    await button(form, "Delete location").click();
    await expect(dialog.getByRole("alert")).toHaveText(DELETE_REASON);
    expect(await client.node(binder1)).toBeDefined();

    await button(form, "Cancel").click();
    await client.rename(binder1, "Binder 1 elsewhere");
    await button(dialog, `Rename ${path}`).click();
    await dialog.getByLabel("New name").fill("Binder 1 mine");
    await button(dialog, "Save name").click();
    // The tree is read again, so the dialog is now titled with the other tab's name.
    dialog = settingsOf(page, `${shelf} / Binder 1 elsewhere`);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert")).toContainText(
      "nothing was changed"
    );
    await expect(button(nav, "Binder 1 elsewhere")).toBeVisible();
    expect((await client.node(binder1))!.name).toBe("Binder 1 elsewhere");
  });

  test("Move leaves out parents past the 12-level limit", async ({ page }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const shelfId = await client.create(shelf, null);
    const binder10 = await client.create("Binder 10", shelfId);
    await client.create("Page 1", binder10);
    const deckName = `${shelf} Deck`;
    await client.deck(deckName);
    let parent = await client.create(`${shelf} Deep`, null);
    let path = `${shelf} Deep`;
    let level10 = "";
    for (let level = 2; level <= 11; level++) {
      parent = await client.create(`Level ${level}`, parent);
      path = `${path} / Level ${level}`;
      if (level === 10) level10 = path;
    }
    const level11 = path;
    await page.reload();
    const nav = sidebarNav(page);
    await button(nav, shelf).click();

    const binder = `${shelf} / Binder 10`;
    await gear(nav, binder).click();
    const dialog = settingsOf(page, binder);
    await button(dialog, `Move ${binder}`).click();
    const picker = dialog.getByRole("list", { name: "New parent" });
    await expect(button(picker, level10)).toBeVisible();
    const options = await picker.getByRole("button").allTextContents();
    expect(options).toContain(level10);
    expect(options).not.toContain(level11);
    expect(options).not.toContain(shelf);
    expect(options).not.toContain(deckName);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the drawer's gear is always shown and touch sized, and its settings sheet opens over the drawer", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const shelfId = await client.create(shelf, null);
    await client.create("Binder 1", shelfId);
    await page.reload();
    await button(page.getByRole("banner"), "Open locations").click();
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    await expect(drawer).toBeVisible();
    await button(drawer, shelf).click();

    const path = `${shelf} / Binder 1`;
    const g = gear(drawer, path);
    await expectTouchTarget(g);
    await expectTouchTarget(button(drawer, `Add child location to ${path}`));
    await expect(g).toHaveCSS("opacity", "1");

    await g.click();
    const sheet = settingsOf(page, path);
    await expect(sheet).toBeVisible();
    const frame = (await sheet.boundingBox())!;
    expect(frame.width).toBe(375);
    expect(Math.round(frame.y + frame.height)).toBe(812);
    await expect(drawer).toBeVisible();
    for (const name of [`Rename ${path}`, `Move ${path}`, `Delete ${path}`])
      await expectTouchTarget(button(sheet, name), ["height"]);
    await expectRowLayout(sheet, `Hide ${path} from Friends`, path);
    // A checkbox's tap area is the label around it.
    for (const name of [`Hide ${path} from Friends`, `Mark ${path} For trade`])
      await expectTouchTarget(
        checkbox(sheet, name).locator("xpath=ancestor::label")
      );

    await button(sheet, `Rename ${path}`).click();
    await sheet.getByLabel("New name").fill("Binder 1a");
    await button(sheet, "Save name").click();
    const renamed = `${shelf} / Binder 1a`;
    const after = settingsOf(page, renamed);
    await expect(after).toBeVisible();
    await button(after, "Close settings").click();
    await expect(after).toBeHidden();
    await expect(gear(drawer, renamed)).toBeFocused();
    await expect(drawer).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(375);

    // The scrim above the sheet closes the settings only; the drawer stays and the gear gets focus back.
    await button(page.getByRole("banner"), "Open locations").click();
    await expect(drawer).toBeVisible();
    await gear(drawer, renamed).click();
    const reopened = settingsOf(page, renamed);
    await expect(reopened).toBeVisible();
    // The point must sit above the sheet, on the backdrop.
    await expect
      .poll(async () => (await reopened.boundingBox())?.y ?? 0)
      .toBeGreaterThan(20);
    await page.mouse.click(187, 20);
    await expect(reopened).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(gear(drawer, renamed)).toBeFocused();

    // Widening the window to a desktop closes both and restores the scroll lock.
    await gear(drawer, renamed).click();
    await expect(reopened).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(reopened).toBeHidden();
    await expect(drawer).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("");
  });

  test("a Delete made from the drawer is announced inside the drawer", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const s = randomUUID().slice(0, 8);
    const shelf = `Shelf ${s}`;
    const shelfId = await client.create(shelf, null);
    await client.create("Empty box", shelfId);
    await page.reload();
    await button(page.getByRole("banner"), "Open locations").click();
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    await expect(drawer).toBeVisible();
    await button(drawer, shelf).click();

    const path = `${shelf} / Empty box`;
    await gear(drawer, path).click();
    const sheet = settingsOf(page, path);
    await button(sheet, `Delete ${path}`).click();
    await sheet.getByLabel("Type Empty box to confirm").fill("Empty box");
    await button(sheet, "Delete location").click();
    await expect(sheet).toBeHidden();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId("drawer-location-announcement")).toHaveText(
      `Deleted ${path}.`
    );
    await expect(page.getByTestId("location-announcement")).toHaveText("");
  });
});
