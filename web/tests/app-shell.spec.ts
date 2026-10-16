// Ticket #162: the app shell (spec "The shell"). Tabs and the avatar menu on desktop; the bottom tab bar,
// More sheet and ☰ drawer on a phone; client-side routing and redirects; Collection staying mounted
// across tab switches (#121); the shared page check on the shell's states.
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { signInWithButton } from "./support/sign-in";

type TreeNode = { id: string; name: string; version: number };

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

/** Replaces the catalog with one Printing per name (set "Fixture Set"), each with artwork. This also
 * clears every Holding, so All owned holds only what a test adds. */
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

/** Opens `path` signed out, checks where the address lands, and signs in there through the sign-in card's Google
 * button (the OAuth test fake). */
async function signIn(page: Page, path = "/collection") {
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
  );
  await page.goto(`${ORIGIN}${path}`);
  await expect(page).toHaveURL(/\/collection$/);
  await signInWithButton(page);
  await expect(page).toHaveURL(/\/collection$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("All owned");
}

/** Binds the owner role to OWNER_EMAIL's user (after a first sign-in), or removes the binding. */
async function setOwner(bound: boolean) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (bound)
      await pool.query(
        'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
        [OWNER_EMAIL]
      );
    else await pool.query("DELETE FROM owner_binding");
  } finally {
    await pool.end();
  }
}

/** Creates a top-level Location through the API and returns its id. */
async function createLocation(page: Page, name: string): Promise<string> {
  const response = await page.request.post(
    new URL("/api/location-tree", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: {
        name,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      },
    }
  );
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

const mainViews = (page: Page) =>
  page.getByRole("navigation", { name: "Main views" });
const tab = (page: Page, name: string) =>
  mainViews(page).getByRole("button", { name, exact: true });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const account = (page: Page) => page.getByRole("button", { name: "Account" });
const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const selectionBar = (page: Page) =>
  page.getByRole("region", { name: "Selection" });
const counts = (page: Page, text: string) =>
  page.getByRole("main").getByText(text, { exact: true });

/** Two animation frames, so every commit after the last event has been painted. */
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );

/** Collection's scroll position, document height and gallery height. */
const geometry = (page: Page) =>
  page.evaluate(() => ({
    scrollY: window.scrollY,
    documentHeight: document.documentElement.scrollHeight,
    galleryHeight: document
      .querySelector('section[aria-label="Cards"]')!
      .getBoundingClientRect().height,
  }));

/** From now on, counts placeholder tiles ("Loading cards") added to the page, records every inline
 * height the gallery grid is given, and samples Collection's geometry on every animation frame in which
 * its gallery is shown. */
async function recordCollection(page: Page) {
  await page.evaluate(() => {
    const record = {
      placeholders: 0,
      heights: [] as string[],
      samples: [] as string[],
    };
    const gallery = () =>
      document.querySelector<HTMLElement>('section[aria-label="Cards"]');
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes))
          if (
            node instanceof HTMLElement &&
            (node.matches('[aria-label="Loading cards"]') ||
              node.querySelector('[aria-label="Loading cards"]'))
          )
            record.placeholders++;
        const target = mutation.target as HTMLElement;
        if (
          mutation.type === "attributes" &&
          target.parentElement === gallery()
        )
          record.heights.push(
            `${mutation.oldValue} -> ${target.getAttribute("style")}`
          );
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
      attributeOldValue: true,
    });
    const sample = () => {
      const section = gallery();
      if (section?.getClientRects().length)
        record.samples.push(
          `${window.scrollY}|${document.documentElement.scrollHeight}|${section.getBoundingClientRect().height}`
        );
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    (window as unknown as { shellRecord: typeof record }).shellRecord = record;
  });
}
const collectionRecord = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          shellRecord: {
            placeholders: number;
            heights: string[];
            samples: string[];
          };
        }
      ).shellRecord
  );

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("/, /workspace and /locations open Collection, where signing in lands", async ({
    page,
  }) => {
    await signIn(page, "/");
    await expect(tab(page, "Collection")).toHaveAttribute(
      "aria-current",
      "page"
    );
    for (const path of ["/", "/workspace", "/locations", "/old-collection"]) {
      await page.goto(`${ORIGIN}${path}`);
      await expect(page).toHaveURL(/\/collection$/);
      await expect(heading(page)).toHaveText("All owned");
    }
    // An old Location link keeps its query through the redirect and opens that Location.
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `Linked ${s}`);
    await page.goto(`${ORIGIN}/workspace?location=${leaf}`);
    await expect(heading(page)).toHaveText(`Linked ${s}`);
    await expect(page).toHaveURL(/\/collection$/);
    // An address that is no page lands on Collection.
    await page.goto(`${ORIGIN}/nowhere`);
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("All owned");
  });

  test("the tabs mark the current page and switching swaps only the page area", async ({
    page,
  }) => {
    await signIn(page);
    await expect(mainViews(page).getByRole("button")).toHaveText([
      "Collection",
      "Decks",
      "Catalog",
      "Loans",
      "Missing cards",
    ]);
    // A marker on the window survives only if no page load happens.
    await page.evaluate(() => {
      (window as unknown as { shellProbe: number }).shellProbe = 1;
    });
    for (const [name, path, title] of [
      ["Decks", "/decks", "Decks"],
      ["Catalog", "/catalog", "Catalog"],
      ["Loans", "/loans", "Loans"],
      ["Missing cards", "/reports", "Missing cards"],
      ["Collection", "/collection", "All owned"],
    ]) {
      await tab(page, name).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(heading(page)).toHaveText(title);
      await expect(tab(page, name)).toHaveAttribute("aria-current", "page");
      await expect(
        mainViews(page).locator('[aria-current="page"]')
      ).toHaveCount(1);
    }
    expect(
      await page.evaluate(
        () => (window as unknown as { shellProbe?: number }).shellProbe
      )
    ).toBe(1);
    // History moves between pages in the app too.
    await page.goBack();
    await expect(page).toHaveURL(/\/reports$/);
    await expect(tab(page, "Missing cards")).toHaveAttribute(
      "aria-current",
      "page"
    );
    await page.goForward();
    await expect(heading(page)).toHaveText("All owned");
  });

  test("the avatar menu holds the email, Settings, Owner controls for the owner and Sign out", async ({
    page,
  }) => {
    await signIn(page);
    await setOwner(false);
    try {
      await page.reload();
      await expect(heading(page)).toHaveText("All owned");
      await account(page).click();
      await expect(page.getByText(OWNER_EMAIL, { exact: true })).toBeVisible();
      await expect(page.getByRole("menuitem")).toHaveText([
        "Settings",
        "Sign out",
      ]);
      await expect(
        page.getByRole("menuitem", { name: "Settings" })
      ).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(
        page.getByRole("menuitem", { name: "Sign out" })
      ).toBeFocused();
      await expectPageChecks(page, "avatar menu open");
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(account(page)).toBeFocused();
      // Opened by address, Owner controls shows someone else nothing but its heading, as before.
      await page.goto(`${ORIGIN}/owner`);
      await expect(heading(page)).toHaveText("Owner controls");
      await expect(
        page.getByRole("heading", { name: "English catalog pull" })
      ).toHaveCount(0);
      await page.goto(`${ORIGIN}/collection`);

      // Keyboard: ArrowDown opens on the first item, Enter chooses it.
      await account(page).focus();
      await page.keyboard.press("ArrowDown");
      await expect(
        page.getByRole("menuitem", { name: "Settings" })
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/settings$/);
      await expect(heading(page)).toHaveText("Settings");
      await expect(
        page.getByText(`Your account email: ${OWNER_EMAIL}`)
      ).toBeVisible();
      await expectPageChecks(page, "Settings");

      await setOwner(true);
      await page.reload();
      await expect(heading(page)).toHaveText("Settings");
      await account(page).click();
      await expect(page.getByRole("menuitem")).toHaveText([
        "Settings",
        "Owner controls",
        "Sign out",
      ]);
      await page.getByRole("menuitem", { name: "Owner controls" }).click();
      await expect(page).toHaveURL(/\/owner$/);
      await expect(
        page.getByRole("heading", { name: "English catalog pull" })
      ).toBeVisible();
    } finally {
      await setOwner(false);
    }
  });

  test("Collection keeps its Location, selection, scroll, search, filters and display across a tab switch, and a reload starts fresh", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Keep Abra", "card-2": "Keep Zubat" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `Keep ${s}`);
    await addCopies(page, leaf, await editionOf("card-1"), 120);
    await addCopies(page, leaf, await editionOf("card-2"), 3);
    await page.reload();
    await page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: `Keep ${s}`, exact: true })
      .click();
    await expect(counts(page, "123 copies · 2 editions")).toBeVisible();

    // Search, a filter and display choices, then a selection, then scroll down the gallery.
    await page.getByRole("searchbox", { name: "Search cards" }).fill("Keep");
    await page.getByRole("button", { name: /^Filters/ }).click();
    const filters = page.getByRole("region", { name: "Card filters" });
    // Typing settles for 250 ms before the gallery reads again, and a new search or filter clears any selection.
    // Wait for the read that carries both, so the clicks below cannot land before that reload.
    const settled = page.waitForResponse((response) => {
      const url = response.url();
      return url.includes("name=Keep") && url.includes("set_id=");
    });
    await filters.getByLabel("Set").selectOption({ label: "Fixture Set" });
    await settled;
    await expect(counts(page, "123 copies · 2 editions")).toBeVisible();
    await page.getByLabel("Card size").selectOption("medium");
    const names = page.getByRole("button", { name: "Names", exact: true });
    const namesPressed = await names.getAttribute("aria-pressed");
    await names.click();
    await expect(names).not.toHaveAttribute("aria-pressed", namesPressed!);
    await tiles(page).nth(0).click();
    await tiles(page)
      .nth(1)
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(selectionBar(page)).toContainText("2 copies selected");
    await page.evaluate(() => window.scrollTo(0, 700));
    await settle(page);
    const before = await geometry(page);
    expect(before.scrollY).toBe(700);
    const setValue = await filters.getByLabel("Set").inputValue();

    await recordCollection(page);
    await tab(page, "Decks").click();
    await expect(heading(page)).toHaveText("Decks");
    // Escape on another page leaves Collection's selection alone.
    await page.keyboard.press("Escape");
    await tab(page, "Collection").click();
    await expect(heading(page)).toHaveText(`Keep ${s}`);
    await settle(page);

    const record = await collectionRecord(page);
    expect(record.placeholders, "placeholder tiles shown").toBe(0);
    expect(record.heights, "gallery height changes").toEqual([]);
    expect(
      [...new Set(record.samples)],
      "every painted frame of Collection"
    ).toEqual([
      `${before.scrollY}|${before.documentHeight}|${before.galleryHeight}`,
    ]);
    expect(await geometry(page)).toEqual(before);
    await expect(selectionBar(page)).toContainText("2 copies selected");
    await expect(
      page.getByRole("searchbox", { name: "Search cards" })
    ).toHaveValue("Keep");
    await expect(filters.getByLabel("Set")).toHaveValue(setValue);
    await expect(page.getByLabel("Card size")).toHaveValue("medium");
    await expect(names).not.toHaveAttribute("aria-pressed", namesPressed!);
    await expect(
      page
        .getByRole("complementary", { name: "Sidebar" })
        .getByRole("button", { name: `Keep ${s}`, exact: true })
    ).toHaveAttribute("aria-current", "page");

    // A reload starts fresh (display choices are remembered per user, as before).
    await page.reload();
    await expect(heading(page)).toHaveText("All owned");
    await expect(
      page.getByRole("searchbox", { name: "Search cards" })
    ).toHaveValue("");
    await expect(selectionBar(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("browser Back closes Collection's open dialog instead of leaving it over the page now shown", async ({
    page,
  }) => {
    await signIn(page);
    await tab(page, "Decks").click();
    await expect(page).toHaveURL(/\/decks$/);
    await tab(page, "Collection").click();
    await expect(heading(page)).toHaveText("All owned");
    await page
      .getByRole("complementary")
      .getByRole("button", { name: "Add location" })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Add location" })
    ).toBeVisible();
    await expect(page.locator("dialog:modal")).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("All owned");
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/decks$/);
    await tab(page, "Catalog").click();
    await expect(page).toHaveURL(/\/catalog$/);

    await page.goBack();
    await page.goForward();
    await expect(page).toHaveURL(/\/catalog$/);
    await tab(page, "Collection").click();
    await expect(heading(page)).toHaveText("All owned");
    await expect(page.locator("dialog:modal")).toHaveCount(0);
  });

  test("the skip link leads to the page heading, and header controls show the focus ring", async ({
    page,
  }) => {
    await signIn(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press("Enter");
    await expect(heading(page)).toBeFocused();
    for (const control of [
      tab(page, "Collection"),
      tab(page, "Decks"),
      account(page),
    ]) {
      await control.focus();
      const ring = await control.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          visible: element.matches(":focus-visible"),
          style: style.outlineStyle,
          width: parseFloat(style.outlineWidth),
        };
      });
      expect(ring.visible).toBe(true);
      expect(ring.style).toBe("solid");
      expect(ring.width).toBeGreaterThanOrEqual(2);
    }
  });

  test("the shell passes the page check on desktop", async ({ page }) => {
    await signIn(page);
    await expectPageChecks(page, "Collection");
    await page.goto(`${ORIGIN}/settings`);
    await expect(heading(page)).toHaveText("Settings");
    await expectPageChecks(page, "Settings");
  });

  test("a failed sign-out says so in one toast, and signing out returns to the sign-in screen", async ({
    page,
  }) => {
    await signIn(page);
    await page.route("**/auth/sign-out", (route) =>
      route.fulfill({ status: 500, json: {} })
    );
    const failure = page.getByText(
      "Couldn't sign out. Check your connection and try again.",
      { exact: true }
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await account(page).click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await expect(failure).toHaveCount(1);
    }
    await expect(mainViews(page)).toBeVisible();
    await page.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(failure).toHaveCount(0);
    await page.unroute("**/auth/sign-out");
    await account(page).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(
      page.getByRole("link", { name: "Continue with Google" })
    ).toBeVisible();
    await expect(page).toHaveURL(/\/collection$/);
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the bottom tab bar switches pages, Loans has the old More slot, and the account sheet holds Missing cards, Settings, Owner controls for the owner and Sign out", async ({
    page,
  }) => {
    await signIn(page);
    await setOwner(true);
    try {
      await page.reload();
      await expect(heading(page)).toHaveText("All owned");
      await expect(mainViews(page).getByRole("button")).toHaveText([
        "Collection",
        "Decks",
        "Catalog",
        "Loans",
      ]);
      const banner = page.getByRole("banner");
      await expect(banner).toContainText("Collection");
      // Mobile Select mode stays in Collection's own page header.
      await expect(
        page
          .getByRole("main")
          .getByRole("button", { name: "Select", exact: true })
      ).toBeVisible();
      await expect(
        banner.getByRole("button", { name: "Select", exact: true })
      ).toHaveCount(0);

      await tab(page, "Decks").tap();
      await expect(page).toHaveURL(/\/decks$/);
      await expect(heading(page)).toHaveText("Decks");
      // The phone header doesn't repeat the page's title.
      await expect(page.getByRole("banner")).not.toContainText("Decks");
      await expect(tab(page, "Decks")).toHaveAttribute("aria-current", "page");

      await tab(page, "Loans").tap();
      await expect(page).toHaveURL(/\/loans$/);
      await expect(heading(page)).toHaveText("Loans");
      await expect(tab(page, "Loans")).toHaveAttribute("aria-current", "page");

      const avatar = page
        .getByRole("banner")
        .getByRole("button", { name: "Account", exact: true });
      await avatar.tap();
      const sheet = page.getByRole("dialog", { name: "Account" });
      await expect(sheet).toBeVisible();
      await expect(
        sheet.getByRole("button", { name: "Close account" })
      ).toBeFocused();
      // A bottom sheet: full width, along the bottom edge.
      const box = (await sheet.boundingBox())!;
      expect(box.x).toBe(0);
      expect(box.width).toBe(375);
      expect(Math.abs(box.y + box.height - 812)).toBeLessThanOrEqual(0.5);
      await expect(sheet.getByRole("list").getByRole("button")).toHaveText([
        "Settings",
        "Sign-ins",
        "Missing cards",
        "Owner controls",
        "Sign out",
      ]);
      await expectPageChecks(page, "Account sheet");
      // Focus stays in the sheet, and the close button returns it to the avatar.
      const signOut = sheet.getByRole("button", { name: "Sign out" });
      const close = sheet.getByRole("button", { name: "Close account" });
      await signOut.focus();
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(signOut).toBeFocused();
      await close.tap();
      await expect(sheet).toBeHidden();
      await expect(avatar).toBeFocused();

      await avatar.tap();
      await sheet.getByRole("button", { name: "Missing cards" }).tap();
      await expect(page).toHaveURL(/\/reports$/);
      await expect(sheet).toBeHidden();
      await expect(heading(page)).toHaveText("Missing cards");
      // No tab is current on Missing cards; the sheet marks it.
      await expect(
        mainViews(page).locator('[aria-current="page"]')
      ).toHaveCount(0);
      await avatar.tap();
      await expect(
        sheet.getByRole("button", { name: "Missing cards" })
      ).toHaveAttribute("aria-current", "page");

      // The scrim closes it.
      await page.mouse.click(187, 60);
      await expect(sheet).toBeHidden();

      await avatar.tap();
      await sheet.getByRole("button", { name: "Owner controls" }).tap();
      await expect(page).toHaveURL(/\/owner$/);

      await setOwner(false);
      await page.reload();
      await expect(page).toHaveURL(/\/owner$/);
      await avatar.tap();
      await expect(sheet.getByRole("list").getByRole("button")).toHaveText([
        "Settings",
        "Sign-ins",
        "Missing cards",
        "Sign out",
      ]);
      await sheet.getByRole("button", { name: "Sign out" }).tap();
      await expect(
        page.getByRole("link", { name: "Continue with Google" })
      ).toBeVisible();
    } finally {
      await setOwner(false);
    }
  });

  test("☰ opens Collection's Location tree in a left drawer", async ({
    page,
  }) => {
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    await createLocation(page, `0 Drawer ${s}`);
    await page.reload();
    const opener = page
      .getByRole("banner")
      .getByRole("button", { name: "Open locations" });
    await opener.tap();
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Close locations" })
    ).toBeFocused();
    const box = (await drawer.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.height).toBe(812);
    await expectPageChecks(page, "Locations drawer");
    await drawer.getByRole("button", { name: "Close locations" }).tap();
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.tap();

    await drawer
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: `0 Drawer ${s}`, exact: true })
      .tap();
    await expect(drawer).toBeHidden();
    await expect(heading(page)).toHaveText(`0 Drawer ${s}`);
    await expect(opener).toBeFocused();

    await opener.tap();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await opener.tap();
    await page.mouse.click(360, 400);
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
  });

  test("browser Back closes Collection's open drawer and filters, and the page now shown works", async ({
    page,
  }) => {
    await signIn(page);
    await tab(page, "Decks").tap();
    await expect(page).toHaveURL(/\/decks$/);
    await tab(page, "Collection").tap();
    await expect(heading(page)).toHaveText("All owned");
    const bodyLocked = () =>
      page.evaluate(
        () => getComputedStyle(document.body).overflow === "hidden"
      );

    // The Locations drawer.
    await page.getByRole("button", { name: "Open locations" }).tap();
    await expect(
      page.getByRole("dialog", { name: "Locations", exact: true })
    ).toBeVisible();
    await expect(page.locator("dialog:modal")).toHaveCount(1);
    expect(await bodyLocked()).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    expect(await bodyLocked()).toBe(false);
    await tab(page, "Catalog").tap();
    await expect(page).toHaveURL(/\/catalog$/);
    await page.goBack();
    await page.goForward();
    await page.goBack();

    // Filters & display: Tab moves on, and the page scrolls.
    await tab(page, "Collection").tap();
    await expect(heading(page)).toHaveText("All owned");
    await page.getByRole("button", { name: /^Filters & display/ }).tap();
    await expect(
      page.getByRole("dialog", { name: /Filters & display/ })
    ).toBeVisible();
    expect(await bodyLocked()).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/\/decks$/);
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    expect(await bodyLocked()).toBe(false);
    await tab(page, "Decks").focus();
    await page.keyboard.press("Tab");
    await expect(tab(page, "Catalog")).toBeFocused();
    await page.evaluate(() => (document.body.style.minHeight = "3000px"));
    await page.mouse.move(187, 300);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(0);
    await page.evaluate(() => {
      document.body.style.minHeight = "";
      window.scrollTo(0, 0);
    });

    // Going forward lands on Collection with nothing open.
    await page.goForward();
    await expect(page).toHaveURL(/\/collection$/);
    await expect(heading(page)).toHaveText("All owned");
    await expect(page.locator("dialog:modal")).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("Collection keeps its scroll and selection across a tab switch, with the Actions strip above the tab bar", async ({
    page,
  }) => {
    promoteCatalog({ "card-1": "Thumb Abra" });
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const leaf = await createLocation(page, `Thumb ${s}`);
    await addCopies(page, leaf, await editionOf("card-1"), 60);
    await page.goto(`${ORIGIN}/collection?location=${leaf}`);
    await expect(heading(page)).toHaveText(`Thumb ${s}`);
    await expect(counts(page, "60 copies · 1 edition")).toBeVisible();
    await page
      .getByRole("main")
      .getByRole("button", { name: "Select", exact: true })
      .tap();
    await tiles(page).nth(0).tap();
    const strip = selectionBar(page);
    await expect(strip).toContainText("1 copy selected");
    const stripBox = (await strip.boundingBox())!;
    const barBox = (await mainViews(page).boundingBox())!;
    expect(stripBox.y + stripBox.height).toBeLessThanOrEqual(barBox.y);

    await page.evaluate(() => window.scrollTo(0, 600));
    await settle(page);
    const before = await geometry(page);
    await tab(page, "Catalog").tap();
    await expect(page).toHaveURL(/\/catalog$/);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await tab(page, "Collection").tap();
    await settle(page);
    expect(await geometry(page)).toEqual(before);
    await expect(strip).toContainText("1 copy selected");
  });

  test("the shell passes the page check on a phone", async ({ page }) => {
    await signIn(page);
    await expectPageChecks(page, "Collection");
    await page.goto(`${ORIGIN}/settings`);
    await expect(heading(page)).toHaveText("Settings");
    await expectPageChecks(page, "Settings");
  });
});
