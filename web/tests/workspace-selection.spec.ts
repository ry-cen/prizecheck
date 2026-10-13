import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-gallery.spec.ts so that spec stays untouched.

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Replaces the catalog with one Printing per name (set "Fixture Set", number from the id),
 * each with artwork. This also clears every Holding, so All owned holds only what a test adds. */
function promoteCatalog(names: Record<string, string>) {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
import test_catalog_search as search
class Imaged(search.SearchSource):
    def fetch(self, source_id):
        record = super().fetch(source_id)
        record["image"] = "https://assets.tcgdex.net/en/fixture/" + source_id
        return record
search.SearchSource = Imaged
search.promote(json.loads(sys.argv[1]))`,
      JSON.stringify(names),
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function signIn(page: Page) {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
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
    `${process.env.TEST_ORIGIN || "http://localhost:5173"}/collection`
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
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** Creates a Location through the API and returns its id. */
async function createLocation(
  page: Page,
  name: string,
  parentId: string | null
): Promise<string> {
  const api = (path: string) => new URL(path, page.url()).href;
  let parentVersion: number | null = null;
  if (parentId) {
    const tree = await page.request.get(api("/api/location-tree"));
    expect(tree.ok()).toBeTruthy();
    parentVersion = (
      (await tree.json()) as { locations: TreeNode[] }
    ).locations.find((node) => node.id === parentId)!.version;
  }
  const response = await page.request.post(api("/api/location-tree"), {
    headers: { origin: new URL(page.url()).origin },
    data: {
      name,
      parent_id: parentId,
      parent_version: parentVersion,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: TreeNode }).location.id;
}

/** Adds copies of an Edition to a Storage Leaf through the API. */
async function addCopies(
  page: Page,
  locationId: string,
  editionId: string,
  quantity: number
) {
  const response = await page.request.post(
    new URL("/api/holdings", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        location_id: locationId,
        edition_id: editionId,
        quantity: String(quantity),
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** The normal-finish Edition of a fixture Printing. */
async function editionOf(sourceId: string): Promise<string> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'finish'='normal'`,
      [sourceId]
    );
    return rows[0].id;
  } finally {
    await pool.end();
  }
}

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const pressed = (page: Page) =>
  cards(page).getByRole("button", { pressed: true });
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
const inspector = (page: Page) =>
  page.getByRole("complementary", { name: "Card details" });
/** The tile whose accessible name holds ", copy <n>, " (one Holding per test where this is used). */
const copy = (page: Page, n: number) =>
  cards(page).getByRole("button", { name: new RegExp(`, copy ${n}, `) });

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found).not.toBeNull();
  return found!;
}

const center = async (locator: Locator) => {
  const b = await box(locator);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

/** Display indexes per row, read from the mounted tiles' geometry. */
async function columns(page: Page) {
  const tops = await tiles(page).evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().top)
  );
  return tops.filter((top) => Math.abs(top - tops[0]) < 1).length;
}

/** A point in the row gap just below a tile, which is empty gallery space. */
async function gapBelow(tile: Locator) {
  const b = await box(tile);
  return { x: b.x + 10, y: b.y + b.height + 8 };
}

/** The copy number of a mounted tile in `column` (0-based) in the middle of the viewport, clear of the
 * auto-scroll edges, or 0. */
const middleTile = (page: Page, perRow: number, column: number) =>
  tiles(page).evaluateAll(
    (elements, [perRow, column]) => {
      for (const element of elements) {
        const match = /, copy (\d+), /.exec(
          element.getAttribute("aria-label") ?? ""
        );
        if (!match) continue;
        const n = Number(match[1]);
        const rect = element.getBoundingClientRect();
        if (
          (n - 1) % perRow === column &&
          rect.top > window.innerHeight / 3 &&
          rect.bottom < window.innerHeight - 100
        )
          return n;
      }
      return 0;
    },
    [perRow, column] as const
  );

async function marquee(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("click, Ctrl/Cmd-click and Shift-click select tiles; the bar counts copies, editions and locations", async ({
    page,
  }) => {
    promoteCatalog({
      "card-1": "Pick Abra",
      "card-2": "Pick Pikachu",
      "card-3": "Pick Zubat",
    });
    await signIn(page);
    const suffix = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${suffix}`, null);
    const beta = await createLocation(page, `Beta ${suffix}`, null);
    const [abra, pikachu, zubat] = await Promise.all(
      ["card-1", "card-2", "card-3"].map(editionOf)
    );
    await addCopies(page, alpha, abra, 2);
    await addCopies(page, alpha, pikachu, 1);
    await addCopies(page, beta, pikachu, 2);
    await addCopies(page, beta, zubat, 1);
    await page.reload();
    // Display order: Abra·Alpha ×2, Pikachu·Alpha, Pikachu·Beta ×2, Zubat·Beta.
    await expect(tiles(page)).toHaveCount(6);
    const tile = (index: number) => tiles(page).nth(index);
    const pressedIndexes = async () => {
      const states = await tiles(page).evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-pressed"))
      );
      return states.flatMap((state, index) =>
        state === "true" ? [index] : []
      );
    };

    // Nothing selected: every tile is an unpressed toggle and there is no bar.
    await expect(pressed(page)).toHaveCount(0);
    await expect(tile(0)).toHaveAttribute("aria-pressed", "false");
    await expect(bar(page)).toHaveCount(0);

    // A click selects one tile; clicking the only selected tile deselects it.
    await tile(2).click();
    expect(await pressedIndexes()).toEqual([2]);
    await expect(bar(page)).toContainText("1 copy selected");
    await expect(bar(page)).toContainText("1 edition · 1 location");
    await tile(2).click();
    expect(await pressedIndexes()).toEqual([]);
    await expect(bar(page)).toHaveCount(0);

    // A click replaces; Ctrl/Cmd-click toggles.
    await tile(0).click();
    await tile(3).click({ modifiers: ["ControlOrMeta"] });
    expect(await pressedIndexes()).toEqual([0, 3]);
    await expect(bar(page)).toContainText("2 copies selected");
    await expect(bar(page)).toContainText("2 editions · 2 locations");
    await tile(3).click({ modifiers: ["ControlOrMeta"] });
    expect(await pressedIndexes()).toEqual([0]);
    await tile(4).click();
    expect(await pressedIndexes()).toEqual([4]);

    // Shift-click selects the displayed range from the last clicked tile, either direction.
    await tile(1).click();
    await tile(4).click({ modifiers: ["Shift"] });
    expect(await pressedIndexes()).toEqual([1, 2, 3, 4]);
    await expect(bar(page)).toContainText("4 copies selected");
    await expect(bar(page)).toContainText("2 editions · 2 locations");
    await tile(0).click({ modifiers: ["Shift"] });
    expect(await pressedIndexes()).toEqual([0, 1]);
    await expect(bar(page)).toContainText("1 edition · 1 location");
    // Ctrl/Cmd+Shift adds the range to the selection.
    await tile(3).click();
    await tile(5).click({ modifiers: ["ControlOrMeta", "Shift"] });
    expect(await pressedIndexes()).toEqual([3, 4, 5]);
    await tile(0).click({ modifiers: ["ControlOrMeta"] });
    expect(await pressedIndexes()).toEqual([0, 3, 4, 5]);
    await expect(bar(page)).toContainText("4 copies selected");
    await expect(bar(page)).toContainText("3 editions · 2 locations");

    // Selected tiles carry a check badge inside the card's top-right corner and a ring, not only a colour.
    const selected = tile(0);
    const check = selected.getByText("✓");
    await expect(check).toBeVisible();
    await expect(tile(1).getByText("✓")).toHaveCount(0);
    const badge = await box(check);
    const card = await box(selected);
    expect(badge.x).toBeGreaterThan(card.x + card.width / 2);
    expect(badge.x + badge.width).toBeLessThanOrEqual(card.x + card.width);
    expect(badge.y).toBeGreaterThanOrEqual(card.y);
    expect(badge.y).toBeLessThan(card.y + card.height / 4);
    const ring = (target: Locator) =>
      target
        .locator("img")
        .evaluate((image) => getComputedStyle(image.parentElement!).boxShadow);
    // Prize gold: a background-coloured gap (#121110), then the accent ring (#e6bd57).
    expect(await ring(selected)).toContain("rgb(18, 17, 16)");
    expect(await ring(selected)).toContain("rgb(230, 189, 87)");
    expect(await ring(tile(1))).not.toContain("rgb(230, 189, 87)");

    // Actions → Clear selection empties the selection.
    await bar(page).getByRole("button", { name: "Actions" }).click();
    await bar(page).getByRole("button", { name: "Clear selection" }).click();
    expect(await pressedIndexes()).toEqual([]);
    await expect(bar(page)).toHaveCount(0);
  });

  test("Escape and a click on empty space clear the selection; dialogs keep it; changing Location clears it", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Clear Abra", "card-2": "Clear Pikachu" });
    await signIn(page);
    const suffix = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${suffix}`, null);
    const beta = await createLocation(page, `Beta ${suffix}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 2);
    await addCopies(page, beta, await editionOf("card-2"), 1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);

    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(2)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(pressed(page)).toHaveCount(2);
    await page.keyboard.press("Escape");
    await expect(pressed(page)).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);

    // Empty space inside the gallery area, below the last row.
    await tiles(page).nth(1).click();
    await expect(pressed(page)).toHaveCount(1);
    const last = await box(tiles(page).nth(2));
    const area = await box(cards(page));
    const empty = { x: last.x + 10, y: last.y + last.height + 60 };
    expect(empty.y).toBeLessThan(area.y + area.height);
    // Ctrl/Cmd-click on empty space adds nothing and keeps the selection.
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(empty.x, empty.y);
    await page.keyboard.up("ControlOrMeta");
    await expect(pressed(page)).toHaveCount(1);
    await page.mouse.click(empty.x, empty.y);
    await expect(pressed(page)).toHaveCount(0);

    // Escape inside a dialog closes the dialog only.
    await tiles(page).nth(1).click();
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: "Add location" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Add location" })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(pressed(page)).toHaveCount(1);
    await expect(bar(page)).toContainText("1 copy selected");

    // Changing Location clears the selection; coming back finds nothing selected.
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    await nav
      .getByRole("button", { name: `Alpha ${suffix}`, exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      `Alpha ${suffix}`
    );
    await expect(bar(page)).toHaveCount(0);
    await tiles(page).nth(0).click();
    await expect(bar(page)).toContainText("1 copy selected");
    await nav.getByRole("button", { name: "All owned", exact: true }).click();
    await expect(tiles(page)).toHaveCount(3);
    await expect(pressed(page)).toHaveCount(0);
    await expect(bar(page)).toHaveCount(0);
  });

  test("a marquee replaces the selection, Ctrl/Cmd-marquee adds, and both reach rows that aren't mounted", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Band Abra" });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Band ${randomUUID().slice(0, 8)}`,
      null
    );
    await addCopies(page, leaf, await editionOf("card-1"), 600);
    await page.reload();
    await expect(copy(page, 1)).toBeVisible();
    const perRow = await columns(page);
    expect(perRow).toBeGreaterThanOrEqual(3);
    // Rows far below the viewport aren't mounted.
    await expect(copy(page, 600)).toHaveCount(0);
    // Put the first row 120 px below the viewport top, whatever sits above the grid, so rows 1–3
    // stay clear of the edges where a held marquee auto-scrolls.
    const first = await box(copy(page, 1));
    await page.evaluate(
      (by) => window.scrollBy(0, by),
      Math.max(0, first.y - 120)
    );
    await expect
      .poll(async () => (await box(copy(page, 1))).y)
      .toBeLessThanOrEqual(121);

    // From the gap under row 1 into row 2's third tile: row 2, columns 1–3.
    await marquee(
      page,
      await gapBelow(copy(page, 1)),
      await center(copy(page, perRow + 3))
    );
    await expect(bar(page)).toContainText("3 copies selected");
    await expect(bar(page)).toContainText("1 edition · 1 location");
    for (const n of [perRow + 1, perRow + 2, perRow + 3])
      await expect(copy(page, n)).toHaveAttribute("aria-pressed", "true");
    await expect(copy(page, perRow + 4)).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await expect(copy(page, 1)).toHaveAttribute("aria-pressed", "false");

    // Ctrl/Cmd-marquee adds row 3's last two columns. Every point stays well inside the viewport,
    // away from the edges where a held marquee auto-scrolls.
    expect(perRow).toBeGreaterThanOrEqual(5);
    const corner = await center(copy(page, 3 * perRow));
    expect(corner.y).toBeLessThan(860 - 100);
    await page.keyboard.down("ControlOrMeta");
    await marquee(
      page,
      await gapBelow(copy(page, perRow + perRow - 1)),
      corner
    );
    await page.keyboard.up("ControlOrMeta");
    await expect(bar(page)).toContainText("5 copies selected");
    await expect(copy(page, perRow + 1)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    for (const n of [3 * perRow - 1, 3 * perRow])
      await expect(copy(page, n)).toHaveAttribute("aria-pressed", "true");
    await expect(copy(page, 2 * perRow + 1)).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    // A plain marquee replaces it.
    await marquee(
      page,
      await gapBelow(copy(page, 1)),
      await center(copy(page, perRow + 1))
    );
    await expect(bar(page)).toContainText("1 copy selected");
    await expect(copy(page, perRow + 1)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(copy(page, perRow + 2)).toHaveAttribute(
      "aria-pressed",
      "false"
    );

    // Hold a marquee while the window scrolls far past the mounted rows, then finish in column 2.
    const top = await box(copy(page, 1));
    const stride = (await box(copy(page, perRow + 1))).y - top.y;
    // Copy 1's top in page coordinates.
    const origin = top.y + (await page.evaluate(() => window.scrollY));
    const start = await gapBelow(copy(page, 1));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 6, start.y + 4, { steps: 2 });
    await page.evaluate(() => window.scrollBy(0, 6000));
    let target = 0;
    await expect
      .poll(async () => (target = await middleTile(page, perRow, 1)))
      .toBeGreaterThan(0);
    const end = await center(copy(page, target));
    await page.mouse.move(end.x, end.y, { steps: 4 });
    await page.mouse.up();
    // Rows 2 through the target's row, columns 1–2: every one of those copies, mounted or not.
    const lastRow = Math.floor((target - 1) / perRow);
    expect(lastRow).toBeGreaterThan(20);
    await expect(bar(page)).toContainText(
      `${(2 * lastRow).toLocaleString("en-US")} copies selected`
    );
    // Rows that were never mounted during the drag show as selected once scrolled to.
    const row = Math.floor(lastRow / 2);
    await page.evaluate(
      (y) => window.scrollTo(0, y),
      origin + row * stride - 200
    );
    await expect(copy(page, row * perRow + 1)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(copy(page, row * perRow + 2)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(copy(page, row * perRow + 3)).toHaveAttribute(
      "aria-pressed",
      "false"
    );
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(copy(page, 1)).toHaveAttribute("aria-pressed", "false");
    await expect(copy(page, perRow + 1)).toHaveAttribute(
      "aria-pressed",
      "true"
    );
    await expect(copy(page, perRow + 3)).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  test("Shift-click selects a range across rows that aren't mounted", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Range Abra" });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Range ${randomUUID().slice(0, 8)}`,
      null
    );
    await addCopies(page, leaf, await editionOf("card-1"), 600);
    await page.reload();
    await copy(page, 2).click();
    await expect(bar(page)).toContainText("1 copy selected");
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect(copy(page, 599)).toBeVisible();
    await copy(page, 599).click({ modifiers: ["Shift"] });
    await expect(bar(page)).toContainText("598 copies selected");
    await expect(copy(page, 600)).toHaveAttribute("aria-pressed", "false");
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(copy(page, 1)).toHaveAttribute("aria-pressed", "false");
    await expect(copy(page, 2)).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight / 2)
    );
    await expect.poll(() => pressed(page).count()).toBeGreaterThan(20);
    await expect(
      cards(page).getByRole("button", { pressed: false })
    ).toHaveCount(0);
  });

  test("a focused tile stays mounted when it scrolls out of the window, so Space still toggles it", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Focus Abra" });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Focus ${randomUUID().slice(0, 8)}`,
      null
    );
    await addCopies(page, leaf, await editionOf("card-1"), 600);
    await page.reload();
    await copy(page, 1).focus();
    await expect(copy(page, 1)).toBeFocused();
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect(copy(page, 600)).toBeVisible();
    await expect(copy(page, 1)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(copy(page, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(copy(page, 1)).toBeFocused();
    await expect(bar(page)).toContainText("1 copy selected");
  });

  test("the inspector keeps its space while idle, previews on hover only without a selection, and shows the last clicked selected card", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Insp Pikachu", "card-2": "Insp Zubat" });
    await signIn(page);
    const shelf = `Shelf ${randomUUID().slice(0, 8)}`;
    const shelfId = await createLocation(page, shelf, null);
    const binder = await createLocation(page, "Binder 2", shelfId);
    const boxId = await createLocation(page, "Box", shelfId);
    const [pikachu, zubat] = await Promise.all(
      ["card-1", "card-2"].map(editionOf)
    );
    await addCopies(page, binder, pikachu, 2);
    await addCopies(page, boxId, pikachu, 1);
    await addCopies(page, boxId, zubat, 1);
    await page.reload();
    // Order: Pikachu·Binder 2 ×2, Pikachu·Box, Zubat·Box.
    await expect(tiles(page)).toHaveCount(4);
    const panel = inspector(page);
    const pikachuReads: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "GET" &&
        new URL(request.url()).pathname ===
          `/api/collection/editions/${pikachu}`
      )
        pikachuReads.push(request.url());
    });

    // Idle: the column is there, at the reserved width, and empty.
    await expect(panel).toBeAttached();
    expect((await box(panel)).width).toBeCloseTo(310, 0);
    await expect(panel).toBeEmpty();

    // Hover previews while nothing is selected.
    await tiles(page).nth(3).hover();
    await expect(
      panel.getByRole("heading", { name: "Insp Zubat" })
    ).toBeVisible();
    await expect(panel).toContainText("Fixture Set · 2");
    await expect(panel).toContainText(`${shelf} / Box`);
    await expect(panel).toContainText("1 copy here");
    await expect(panel).toContainText("1 copy owned");
    await tiles(page).nth(0).hover();
    await expect(
      panel.getByRole("heading", { name: "Insp Pikachu" })
    ).toBeVisible();
    await expect(panel).toContainText(`${shelf} / Binder 2`);
    await expect(panel).toContainText("2 copies here");
    await expect(panel).toContainText("3 copies owned");
    await page.mouse.move(5, 5);
    await expect(panel).toBeEmpty();

    // Totals already read are kept while the inspector empties between tiles: coming back to a
    // card shows its total at once and asks the server nothing more.
    expect(pikachuReads).toHaveLength(1);
    await tiles(page).nth(0).hover();
    await expect(panel).toContainText("3 copies owned");
    await tiles(page).nth(3).hover();
    await expect(panel).toContainText("1 copy owned");
    // From here, record whether "Counting copies owned…" ever appears in the inspector.
    await panel.evaluate((element) => {
      const win = window as unknown as { sawCounting: boolean };
      win.sawCounting = false;
      const seen = (text?: string | null) => {
        if (text?.includes("Counting copies owned")) win.sawCounting = true;
      };
      new MutationObserver((records) => {
        for (const record of records) {
          seen(record.oldValue);
          record.addedNodes.forEach((node) => seen(node.textContent));
        }
        seen(element.textContent);
      }).observe(element, {
        subtree: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
      });
    });
    await tiles(page).nth(0).hover();
    await expect(
      panel.getByRole("heading", { name: "Insp Pikachu" })
    ).toBeVisible();
    await expect(panel).toContainText("3 copies owned");
    expect(
      await page.evaluate(
        () => (window as unknown as { sawCounting: boolean }).sawCounting
      )
    ).toBe(false);
    expect(pikachuReads).toHaveLength(1);
    await page.mouse.move(5, 5);
    await expect(panel).toBeEmpty();

    // A selection takes precedence over hover and shows the last clicked selected card.
    await tiles(page).nth(2).click();
    await expect(
      panel.getByRole("heading", { name: "Insp Pikachu" })
    ).toBeVisible();
    await expect(panel).toContainText(`${shelf} / Box`);
    await expect(panel).toContainText("1 copy here");
    await expect(panel).toContainText("3 copies owned");
    await tiles(page).nth(3).hover();
    await expect(
      panel.getByRole("heading", { name: "Insp Pikachu" })
    ).toBeVisible();
    await tiles(page)
      .nth(3)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(
      panel.getByRole("heading", { name: "Insp Zubat" })
    ).toBeVisible();
    // Deselecting it falls back to a card that is still selected.
    await tiles(page)
      .nth(3)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(
      panel.getByRole("heading", { name: "Insp Pikachu" })
    ).toBeVisible();
    await expect(panel).toContainText(`${shelf} / Box`);

    // Inside one Storage Leaf, total owned still counts every Location.
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    await nav.getByRole("button", { name: shelf, exact: true }).click();
    await nav.getByRole("button", { name: "Binder 2", exact: true }).click();
    await expect(tiles(page)).toHaveCount(2);
    await expect(panel).toBeEmpty();
    await tiles(page).nth(1).hover();
    await expect(panel).toContainText("2 copies here");
    await expect(panel).toContainText("3 copies owned");
  });

  test("keyboard users focus tiles and toggle them with Space", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Keys Abra" });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Keys ${randomUUID().slice(0, 8)}`,
      null
    );
    await addCopies(page, leaf, await editionOf("card-1"), 3);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);

    await copy(page, 1).focus();
    await page.keyboard.press("Space");
    await expect(copy(page, 1)).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Tab");
    await expect(copy(page, 2)).toBeFocused();
    await page.keyboard.press("Space");
    await expect(bar(page)).toContainText("2 copies selected");
    // Space toggles only the focused tile.
    await page.keyboard.press("Space");
    await expect(copy(page, 2)).toHaveAttribute("aria-pressed", "false");
    await expect(copy(page, 1)).toHaveAttribute("aria-pressed", "true");
    await expect(bar(page)).toContainText("1 copy selected");
    // Enter acts as a click: this tile only.
    await page.keyboard.press("Tab");
    await expect(copy(page, 3)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pressed(page)).toHaveCount(1);
    await expect(copy(page, 3)).toHaveAttribute("aria-pressed", "true");
    await expect(inspector(page)).toContainText("Keys Abra");
    await page.keyboard.press("Escape");
    await expect(pressed(page)).toHaveCount(0);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("a tap opens the details sheet; Select mode makes taps toggle tiles across Locations", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Pocket Abra", "card-2": "Pocket Pikachu" });
    await signIn(page);
    const suffix = randomUUID().slice(0, 8);
    const alpha = await createLocation(page, `Alpha ${suffix}`, null);
    const beta = await createLocation(page, `Beta ${suffix}`, null);
    await addCopies(page, alpha, await editionOf("card-1"), 2);
    await addCopies(page, beta, await editionOf("card-2"), 1);
    await page.reload();
    await expect(tiles(page)).toHaveCount(3);
    await expect(inspector(page)).toBeHidden();

    // A tap opens details in a sheet and selects nothing.
    await tiles(page).nth(0).tap();
    const sheet = page.getByRole("dialog", { name: "Pocket Abra" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("Fixture Set · 1");
    await expect(sheet).toContainText(`Alpha ${suffix}`);
    await expect(sheet).toContainText("2 copies here");
    await expect(sheet).toContainText("2 copies owned");
    await expect(pressed(page)).toHaveCount(0);
    await sheet.getByRole("button", { name: "Close details" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(tiles(page).nth(0)).toBeFocused();

    // Select mode: taps toggle, across Locations, and the strip keeps the count in reach.
    const select = page.getByRole("button", { name: "Select", exact: true });
    await expect(select).toHaveAttribute("aria-pressed", "false");
    await expectTouchTarget(select, ["height"]);
    await select.tap();
    await expect(select).toHaveAttribute("aria-pressed", "true");
    await tiles(page).nth(0).tap();
    await tiles(page).nth(2).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(pressed(page)).toHaveCount(2);
    const strip = bar(page);
    await expect(strip).toContainText("2 copies selected");
    await expect(strip).toContainText("2 editions · 2 locations");
    const stripBox = await box(strip);
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(812);
    expect(stripBox.x).toBeGreaterThanOrEqual(0);
    expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(375);
    for (const name of ["Details", "Actions"])
      await expectTouchTarget(strip.getByRole("button", { name }), ["height"]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    await tiles(page).nth(0).tap();
    await expect(strip).toContainText("1 copy selected");

    // Details on demand shows the last tapped selected card.
    await strip.getByRole("button", { name: "Details" }).tap();
    const details = page.getByRole("dialog", { name: "Pocket Pikachu" });
    await expect(details).toBeVisible();
    await expect(details).toContainText(`Beta ${suffix}`);
    await details.getByRole("button", { name: "Close details" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Leaving Select mode keeps the selection; a tap opens details again.
    await select.tap();
    await expect(select).toHaveAttribute("aria-pressed", "false");
    await expect(strip).toContainText("1 copy selected");
    await tiles(page).nth(1).tap();
    await expect(
      page.getByRole("dialog", { name: "Pocket Abra" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).tap();
    await strip.getByRole("button", { name: "Actions" }).tap();
    await strip.getByRole("button", { name: "Clear selection" }).tap();
    await expect(pressed(page)).toHaveCount(0);
    await expect(strip).toHaveCount(0);
  });

  test("vertical scrolling keeps working in Select mode and the strip leaves the last row reachable", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Scroll Abra" });
    await signIn(page);
    const leaf = await createLocation(
      page,
      `Scroll ${randomUUID().slice(0, 8)}`,
      null
    );
    await addCopies(page, leaf, await editionOf("card-1"), 60);
    await page.reload();
    await expect(copy(page, 1)).toBeVisible();
    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await copy(page, 1).tap();
    await expect(bar(page)).toContainText("1 copy selected");

    // A one-finger swipe up, starting on a tile, scrolls the page and toggles nothing.
    const startPoint = await center(copy(page, 7));
    const cdp = await page.context().newCDPSession(page);
    const send = (
      type: "touchStart" | "touchMove" | "touchEnd",
      point?: { x: number; y: number }
    ) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [],
      });
    await send("touchStart", startPoint);
    for (let step = 1; step <= 10; step++)
      await send("touchMove", { x: startPoint.x, y: startPoint.y - step * 40 });
    await send("touchEnd");
    await cdp.detach();
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(100);
    await expect(bar(page)).toContainText("1 copy selected");

    // At the bottom, the last row sits above the strip.
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    await expect(copy(page, 60)).toBeVisible();
    await expect
      .poll(async () => {
        const last = await box(copy(page, 60));
        const strip = await box(bar(page));
        return last.y + last.height <= strip.y;
      })
      .toBe(true);
  });
});
