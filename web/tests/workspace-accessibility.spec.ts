// Ticket 114: the workspace's accessibility baseline (spec "Accessibility baseline", resolution 28).
import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { animationsFinished } from "./support/motion";
import { startAsNewOwner } from "./support/owner";

type TreeNode = { id: string; name: string; version: number };

// Helpers copied from workspace-selection.spec.ts so that spec stays untouched.

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

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const WCAG_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const bar = (page: Page) => page.getByRole("region", { name: "Selection" });
const sidebar = (page: Page) =>
  page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" });
const toast = (page: Page) =>
  page.getByRole("status").filter({ hasText: /Moved|Removed|Undo|Dismissed/ });

async function createDeck(page: Page, name: string): Promise<string> {
  const response = await page.request.post(
    new URL("/api/decks", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { name, idempotency_key: randomUUID() },
    }
  );
  expect(response.status()).toBe(201);
  return ((await response.json()) as { location: TreeNode }).location.id;
}

/** axe under the WCAG 2.0-2.2 A and AA tags, then heading order. Incomplete results (text over artwork) aren't failures. */
async function expectAccessible(page: Page, state: string) {
  const list = (violations: { id: string; nodes: { target: unknown[] }[] }[]) =>
    violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`
    );
  // axe measured the Manage locations panel half faded in and reported its muted text's contrast.
  await animationsFinished(page);
  const aa = await new AxeBuilder({ page }).withTags(WCAG_AA).analyze();
  expect(list(aa.violations), `WCAG 2.2 AA violations in ${state}`).toEqual([]);
  const order = await new AxeBuilder({ page })
    .withRules(["heading-order"])
    .analyze();
  expect(list(order.violations), `heading order in ${state}`).toEqual([]);
}

/** Visible controls smaller than `min` px; inline links in text are exempt, and a radio or checkbox counts its label. */
async function smallTargets(page: Page, min: number): Promise<string[]> {
  // A drawer still sliding in from the left would have its controls skipped below as off-screen.
  await animationsFinished(page);
  return page.evaluate((min) => {
    const found: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      '.ws-root button, .ws-root a[href], .ws-root input, .ws-root select, .ws-root [role="menuitem"]'
    );
    for (const el of controls) {
      if (el.closest("[inert]") || el.closest('[aria-hidden="true"]')) continue;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.opacity === "0") continue;
      if (el.matches("a") && el.parentElement?.closest("p")) continue;
      let box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.bottom < 0 || box.right < 0) continue; // the skip links wait above the viewport
      if (el.matches('input[type="checkbox"], input[type="radio"]'))
        box = (el.closest("label") ?? el).getBoundingClientRect();
      if (box.width < min - 0.5 || box.height < min - 0.5)
        found.push(
          `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40)}" ${Math.round(box.width)}x${Math.round(box.height)}`
        );
    }
    return found;
  }, min);
}

/** The longest transition or animation on any workspace element, in seconds. */
const longestMotion = (page: Page) =>
  page.evaluate(() => {
    const seconds = (value: string) =>
      Math.max(
        0,
        ...value.split(",").map((part) => {
          const text = part.trim();
          return text.endsWith("ms")
            ? parseFloat(text) / 1000
            : parseFloat(text) || 0;
        })
      );
    let longest = 0;
    for (const el of document.querySelectorAll<HTMLElement>(
      ".ws-root, .ws-root *"
    )) {
      const style = getComputedStyle(el);
      longest = Math.max(longest, seconds(style.transitionDuration));
      if (style.animationName !== "none")
        longest = Math.max(longest, seconds(style.animationDuration));
    }
    return longest;
  });

/** Selects the first two tiles, then Moves them through Actions → Move… to the named leaf. */
async function moveTwo(page: Page, destination: string) {
  await tiles(page).nth(0).click();
  await tiles(page)
    .nth(1)
    .click({ modifiers: ["ControlOrMeta"] });
  await bar(page).getByRole("button", { name: "Actions" }).click();
  await bar(page).getByRole("button", { name: "Move…" }).click();
  const dialog = page.getByRole("dialog", { name: "Move 2 copies" });
  await dialog
    .getByRole("searchbox", { name: "Search locations" })
    .fill(destination);
  await dialog.getByRole("button", { name: destination, exact: true }).click();
  await dialog.getByRole("button", { name: "Move 2 copies" }).click();
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 860 } });

  test("the workspace has no WCAG 2.2 AA violations in its main states", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Access Abra", "card-2": "Access Bulbasaur" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const access = await createLocation(page, `0 Access ${s}`, null);
    await createLocation(page, `0 Dest ${s}`, null);
    const deck = await createDeck(page, `0 Deck ${s}`);
    const [abra, bulbasaur] = await Promise.all(
      ["card-1", "card-2"].map(editionOf)
    );
    await addCopies(page, access, abra, 3);
    await addCopies(page, access, bulbasaur, 1);
    await addCopies(page, deck, abra, 2);
    await page.reload();
    await expect(tiles(page)).toHaveCount(6);

    await expectAccessible(page, "All owned");

    await page.getByRole("button", { name: "Names", exact: true }).click();
    await page.getByRole("button", { name: "Prices", exact: true }).click();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await expectAccessible(page, "names, prices and filters");

    await sidebar(page)
      .getByRole("button", { name: `0 Access ${s}`, exact: true })
      .click();
    await expect(tiles(page)).toHaveCount(4);
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await bar(page).getByRole("button", { name: "Actions" }).click();
    await expectAccessible(page, "selection and Actions");

    await bar(page).getByRole("button", { name: "Move…" }).click();
    const move = page.getByRole("dialog", { name: "Move 2 copies" });
    await expect(move).toBeVisible();
    await expectAccessible(page, "Move dialog");

    await move
      .getByRole("searchbox", { name: "Search locations" })
      .fill(`0 Dest ${s}`);
    await move
      .getByRole("button", { name: `0 Dest ${s}`, exact: true })
      .click();
    await move.getByRole("button", { name: "Move 2 copies" }).click();
    await expect(
      toast(page).filter({ hasText: "Moved 2 copies" })
    ).toBeVisible();
    await expectAccessible(page, "toast");

    await tiles(page).nth(0).click();
    await bar(page).getByRole("button", { name: "Actions" }).click();
    await bar(page).getByRole("button", { name: "Inventory Removal…" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectAccessible(page, "Removal dialog");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Add cards", exact: true }).click();
    const add = page.getByRole("dialog", {
      name: `Add cards to 0 Access ${s}`,
    });
    await add.getByLabel("Search English card name").fill("Access");
    await add.getByRole("button", { name: "Search", exact: true }).click();
    await expect(add.getByLabel("Card Edition")).toBeVisible();
    await expectAccessible(page, "Add cards");
    await add.getByRole("button", { name: "Close" }).click();

    await page
      .getByRole("button", { name: "Add location", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Add location" })
    ).toBeVisible();
    await expectAccessible(page, "Add location");
    await page.keyboard.press("Escape");

    await page
      .getByRole("button", { name: "Manage locations", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Manage locations", exact: true })
    ).toBeVisible();
    await expectAccessible(page, "Manage locations");
    await page.keyboard.press("Escape");

    await sidebar(page)
      .getByRole("button", { name: `0 Deck ${s}`, exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Estimated Deck Cost" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await expectAccessible(page, "Deck heading and Export menu");
    await page.keyboard.press("Escape");

    await addCopies(page, access, bulbasaur, 1);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("button", { name: "Reload", exact: true })
    ).toBeVisible();
    await expectAccessible(page, "stale banner");
  });

  test("keyboard-only: every stop shows a focus ring, and the skip links bypass the tree and the cards", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Keys Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const keys = await createLocation(page, `0 Keys ${s}`, null);
    await createLocation(page, `0 Dest ${s}`, null);
    await addCopies(page, keys, await editionOf("card-1"), 3);
    const url = `${ORIGIN}/workspace?location=${keys}`;
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      `0 Keys ${s}`
    );
    await expect(tiles(page)).toHaveCount(3);

    // Enough presses for every stop once. The tree holds only this test's Locations (startAsNewOwner), so this sizing is
    // defence in depth: a fixed 150 ran out before the gallery when burn-in repeats shared one owner's tree.
    const stops = await page.evaluate(
      () =>
        document.querySelectorAll(
          'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
        ).length
    );
    const names: string[] = [];
    for (let press = 0; press < stops + 10; press++) {
      await page.keyboard.press("Tab");
      const stop = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return {
          name: (el.getAttribute("aria-label") || el.textContent || "").trim(),
          ring:
            style.outlineStyle !== "none" &&
            parseFloat(style.outlineWidth) >= 2,
          visible: box.width > 0 && box.height > 0 && style.opacity !== "0",
        };
      });
      if (!stop) break;
      expect(stop.ring, `focus ring on "${stop.name}"`).toBe(true);
      expect(stop.visible, `"${stop.name}" visible`).toBe(true);
      names.push(stop.name);
    }
    for (const expected of [
      "Skip to main content",
      "Collection",
      "Decks",
      "Catalog",
      "Missing cards",
      "Sign out",
      "Add location",
      "Manage locations",
      "All owned",
      `0 Keys ${s}`,
      "Add cards",
      "Search cards",
      "Sort",
      "Card size",
      "Names",
      "Prices",
    ])
      expect(names, `the Tab walk reaches ${expected}`).toContain(expected);
    expect(names.some((name) => /^Filters/.test(name))).toBe(true);
    expect(names.filter((name) => /, copy \d+, /.test(name))).toHaveLength(3);

    // The top skip link.
    await page.goto(url);
    await expect(tiles(page)).toHaveCount(3);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(page.locator("#ws-heading")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Add cards", exact: true })
    ).toBeFocused();

    // The skip link to Undo, after a Move by mouse.
    await moveTwo(page, `0 Dest ${s}`);
    await expect(
      toast(page).filter({ hasText: `Moved 2 copies to 0 Dest ${s}.` })
    ).toBeVisible();
    await expect(page.locator("#ws-heading")).toBeFocused();
    // Undo joins the toast once the Undo list confirms this Move's record, a moment after the message shows
    // (useInventoryActions.ts); until then the dock's first control, where the skip link lands, is Close notice.
    await expect(
      page.getByRole("button", { name: "Undo", exact: true })
    ).toBeVisible();
    const undoLink = page.getByRole("link", {
      name: "Skip to selection actions and Undo",
    });
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press("Tab");
      if (await undoLink.evaluate((el) => el === document.activeElement)) break;
    }
    await expect(undoLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Undo", exact: true })
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      toast(page).filter({ hasText: "Undo restored 2 copies" })
    ).toBeVisible();
  });

  test("status lines are mounted before their messages", async ({ page }) => {
    promoteCatalog({ "card-1": "Live Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const live = await createLocation(page, `0 Live ${s}`, null);
    await createLocation(page, `0 Dest ${s}`, null);
    await addCopies(page, live, await editionOf("card-1"), 3);
    await page.reload();
    await sidebar(page)
      .getByRole("button", { name: `0 Live ${s}`, exact: true })
      .click();
    await expect(tiles(page)).toHaveCount(3);

    const before = await page.evaluateHandle(() =>
      Array.from(document.querySelectorAll('[role="status"], [role="alert"]'))
    );
    await moveTwo(page, `0 Dest ${s}`);
    const mounted = await page
      .getByRole("status")
      .filter({ hasText: "Moved 2 copies" })
      .evaluate((el, list) => (list as Element[]).includes(el), before);
    expect(mounted).toBe(true);

    await page.getByRole("button", { name: "Add cards", exact: true }).click();
    const add = page.getByRole("dialog", { name: `Add cards to 0 Live ${s}` });
    const status = add.getByRole("status");
    await expect(status).toHaveText("");
    await add.getByLabel("Search English card name").fill("Live");
    await add.getByRole("button", { name: "Search", exact: true }).click();
    await add.getByLabel("Card Edition").selectOption({
      label: "Live Abra · Fixture Set #1 · finish: normal",
    });
    await add.getByLabel("Quantity", { exact: true }).fill("1");
    await add.getByRole("button", { name: "Add to Location" }).click();
    await expect(status).toContainText("This stack now has 2 copies");
  });

  test("targets are at least 24 px on desktop", async ({ page }) => {
    promoteCatalog({ "card-1": "Target Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `0 Target ${s}`, null);
    const deck = await createDeck(page, `0 Deck ${s}`);
    const abra = await editionOf("card-1");
    await addCopies(page, leaf, abra, 3);
    await addCopies(page, deck, abra, 1);
    await page.reload();
    await sidebar(page)
      .getByRole("button", { name: `0 Target ${s}`, exact: true })
      .click();
    await expect(tiles(page)).toHaveCount(3);
    await page.getByRole("button", { name: "Names", exact: true }).click();
    await page.getByRole("button", { name: "Prices", exact: true }).click();
    await page.getByRole("button", { name: /^Filters/ }).click();
    await tiles(page).nth(0).click();
    await bar(page).getByRole("button", { name: "Actions" }).click();
    expect(await smallTargets(page, 24)).toEqual([]);
    await bar(page).getByRole("button", { name: "Actions" }).click();

    await sidebar(page)
      .getByRole("button", { name: `0 Deck ${s}`, exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Estimated Deck Cost" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    expect(await smallTargets(page, 24)).toEqual([]);
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 761, height: 800 });
    expect(
      await page
        .getByRole("banner")
        .evaluate((h) => h.scrollWidth <= h.clientWidth)
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });

  test("a signed-in reload shows the dark loading screen, not the light one", async ({
    page,
  }) => {
    await signIn(page);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/auth/session", async (route) => {
      await gate;
      await route.continue();
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.getByRole("status").filter({ hasText: "Loading…" })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => getComputedStyle(document.documentElement).backgroundColor
      )
    ).toBe("rgb(18, 17, 16)");
    release();
    await page.unroute("**/auth/session");
    await expect(
      page.getByRole("heading", { level: 1, name: "All owned" })
    ).toBeVisible();
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the workspace has no WCAG 2.2 AA violations on a phone", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Phone Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `0 Phone ${s}`, null);
    await addCopies(page, leaf, await editionOf("card-1"), 3);
    await page.reload();
    await expectAccessible(page, "phone All owned");

    await page.getByRole("button", { name: "Open locations" }).tap();
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    await expect(drawer).toBeVisible();
    await expectAccessible(page, "Locations drawer");
    await drawer
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: `0 Phone ${s}`, exact: true })
      .tap();
    await expect(tiles(page)).toHaveCount(3);

    await page.getByRole("button", { name: /^Filters & display/ }).tap();
    await expect(
      page.getByRole("dialog", { name: "Filters & display" })
    ).toBeVisible();
    await expectAccessible(page, "Filters & display");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await tiles(page).nth(0).tap();
    await tiles(page).nth(1).tap();
    await expectAccessible(page, "Select mode");
    await bar(page).getByRole("button", { name: "Actions" }).tap();
    await expectAccessible(page, "phone Actions");
    await bar(page).getByRole("button", { name: "Actions" }).tap();

    await page.getByRole("button", { name: "Add cards", exact: true }).tap();
    await expect(
      page.getByRole("dialog", { name: `Add cards to 0 Phone ${s}` })
    ).toBeVisible();
    await expectAccessible(page, "phone Add cards");
  });

  test("targets are at least 44 px on a phone", async ({ page }) => {
    promoteCatalog({ "card-1": "Touch Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `0 Touch ${s}`, null);
    await addCopies(page, leaf, await editionOf("card-1"), 3);
    await page.reload();
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    await page.getByRole("button", { name: "Open locations" }).tap();
    await drawer
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: `0 Touch ${s}`, exact: true })
      .tap();
    await expect(tiles(page)).toHaveCount(3);

    expect(await smallTargets(page, 44), "heading row").toEqual([]);

    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await tiles(page).nth(0).tap();
    await expect(bar(page)).toContainText("1 copy selected");
    expect(await smallTargets(page, 44), "Select mode").toEqual([]);
    await bar(page).getByRole("button", { name: "Actions" }).tap();
    expect(await smallTargets(page, 44), "Actions open").toEqual([]);
    await bar(page).getByRole("button", { name: "Clear selection" }).tap();

    await page.getByRole("button", { name: "Open locations" }).tap();
    await expect(drawer).toBeVisible();
    expect(await smallTargets(page, 44), "Locations drawer").toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /^Filters & display/ }).tap();
    await expect(
      page.getByRole("dialog", { name: "Filters & display" })
    ).toBeVisible();
    expect(await smallTargets(page, 44), "Filters & display").toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Add cards", exact: true }).tap();
    const add = page.getByRole("dialog", { name: `Add cards to 0 Touch ${s}` });
    await add.getByLabel("Search English card name").fill("Touch");
    await add.getByRole("button", { name: "Search", exact: true }).tap();
    await expect(add.getByLabel("Card Edition")).toBeVisible();
    expect(await smallTargets(page, 44), "Add cards").toEqual([]);
  });

  test("transitions last 150 ms or less and stop under reduced motion", async ({
    page,
  }) => {
    await signIn(page);
    await page.getByRole("button", { name: "Open locations" }).tap();
    await expect(
      page.getByRole("dialog", { name: "Locations", exact: true })
    ).toBeVisible();
    expect(await longestMotion(page)).toBeLessThanOrEqual(0.15);
    await page.keyboard.press("Escape");

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Open locations" }).tap();
    await expect(
      page.getByRole("dialog", { name: "Locations", exact: true })
    ).toBeVisible();
    expect(await longestMotion(page)).toBe(0);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: /^Filters & display/ }).tap();
    await expect(
      page.getByRole("dialog", { name: "Filters & display" })
    ).toBeVisible();
    expect(await longestMotion(page)).toBe(0);
  });
});

test("theme colours meet AA text contrast and 3:1 for outlines", async ({
  page,
}) => {
  await page.goto(`${ORIGIN}/workspace`);
  const roles = [
    "bg",
    "surface",
    "surface-raised",
    "surface-selected",
    "text",
    "text-muted",
    "text-subtle",
    "accent",
    "accent-strong",
    "warning",
    "danger",
    "on-accent",
    "accent-fill",
    "danger-fill",
    "control-outline",
    "accent-border",
    "accent-outline",
    "danger-border",
    "focus",
  ];
  const colours = await page.evaluate(
    (roles) =>
      Object.fromEntries(
        roles.map((role) => [
          role,
          getComputedStyle(document.documentElement)
            .getPropertyValue(`--color-${role}`)
            .trim(),
        ])
      ),
    roles
  );
  for (const [role, value] of Object.entries(colours))
    expect(value, `--color-${role}`).toMatch(/^#[0-9a-f]{6}$/i);
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const channel = parseInt(hex.slice(i, i + 2), 16) / 255;
      return channel <= 0.03928
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [high, low] = [luminance(colours[a]), luminance(colours[b])].sort(
      (x, y) => y - x
    );
    return (high + 0.05) / (low + 0.05);
  };
  const surfaces = ["bg", "surface", "surface-raised", "surface-selected"];
  const failures: string[] = [];
  const check = (foreground: string, background: string, minimum: number) => {
    const value = ratio(foreground, background);
    if (value < minimum)
      failures.push(
        `${foreground} on ${background}: ${value.toFixed(2)} < ${minimum}`
      );
  };
  for (const text of [
    "text",
    "text-muted",
    "text-subtle",
    "accent",
    "accent-strong",
    "warning",
    "danger",
  ])
    for (const surface of surfaces) check(text, surface, 4.5);
  check("text", "accent-fill", 4.5);
  check("text", "danger-fill", 4.5);
  check("on-accent", "accent", 4.5);
  check("on-accent", "accent-strong", 4.5);
  for (const outline of [
    "control-outline",
    "accent-border",
    "accent-outline",
    "danger-border",
    "focus",
  ])
    for (const surface of surfaces) check(outline, surface, 3);
  expect(failures).toEqual([]);
});
