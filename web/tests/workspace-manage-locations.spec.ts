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

/** Seeding and assertions through the real API, same origin as the page. */
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
  /** Renames a Location through the API, as another session would. */
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
  return { tree, node, create, deck, stock, rename };
}

type Fixture = {
  shelf: string;
  loose: string;
  deck: string;
  spare: string;
  /** "<shelf> Deep / Level 2 / … / Level 10" and its child "… / Level 11", when seeded. */
  level10: string;
  level11: string;
  ids: Record<string, string>;
};

/**
 * Seeds, under a unique suffix s:
 *   Shelf s                (folder)
 *     A loose s            (empty leaf)
 *     Binder 1, binder 2   (empty leaves)
 *     Binder 10 / Page 1   (folder with one empty leaf)
 *     Box                  (Storage Leaf with 3 copies)
 *   Shelf s Deck           (an empty top-level Deck)
 *   Shelf s Deep / Level 2 / … / Level 11   (only with deep: true; Level 11 sits 11 levels deep)
 *   Shelf s Spare          (empty top-level leaf)
 * Every top-level name starts with "Shelf s", so the fixture's rows sit together in the panel.
 */
async function seed(page: Page, { deep = false } = {}): Promise<Fixture> {
  const client = api(page);
  const s = randomUUID().slice(0, 8);
  const shelf = `Shelf ${s}`;
  const loose = `A loose ${s}`;
  const ids: Record<string, string> = {};
  ids.shelf = await client.create(shelf, null);
  ids.loose = await client.create(loose, ids.shelf);
  ids.binder1 = await client.create("Binder 1", ids.shelf);
  ids.binder2 = await client.create("binder 2", ids.shelf);
  ids.binder10 = await client.create("Binder 10", ids.shelf);
  ids.page1 = await client.create("Page 1", ids.binder10);
  ids.box = await client.create("Box", ids.shelf);
  await client.stock(ids.box, "3");
  ids.deck = await client.deck(`${shelf} Deck`);
  ids.spare = await client.create(`${shelf} Spare`, null);
  let level10 = "";
  let level11 = "";
  if (deep) {
    let parent = await client.create(`${shelf} Deep`, null);
    let path = `${shelf} Deep`;
    for (let level = 2; level <= 11; level++) {
      parent = await client.create(`Level ${level}`, parent);
      path = `${path} / Level ${level}`;
      if (level === 10) level10 = path;
    }
    level11 = path;
    ids.level11 = parent;
  }
  return {
    shelf,
    loose,
    deck: `${shelf} Deck`,
    spare: `${shelf} Spare`,
    level10,
    level11,
    ids,
  };
}

const panelOf = (page: Page) =>
  page.getByRole("dialog", { name: "Manage locations", exact: true });
/** A panel row, by its full path. */
const row = (panel: Locator, path: string) =>
  panel.getByRole("group", { name: path, exact: true });
/** A row's ☰ handle. */
const handle = (panel: Locator, path: string) =>
  panel.getByRole("button", { name: `Move ${path}`, exact: true });
const button = (scope: Locator, name: string) =>
  scope.getByRole("button", { name, exact: true });

async function openFromSidebar(page: Page, shelf: string) {
  await button(
    page.getByRole("complementary", { name: "Sidebar" }),
    "Manage locations"
  ).click();
  const panel = panelOf(page);
  await expect(panel).toBeVisible();
  await reveal(panel, shelf);
  return panel;
}

/** Scrolls the panel so the fixture's shelf row is the first row under the pinned Top level zone. */
async function reveal(panel: Locator, shelf: string) {
  await expect(row(panel, shelf)).toBeVisible();
  await row(panel, shelf).evaluate((element) =>
    element.scrollIntoView({ block: "start" })
  );
}

async function center(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Presses a handle with the mouse and moves past the drag threshold. */
async function lift(page: Page, from: Locator) {
  const start = await center(from);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 12, start.y + 12, { steps: 4 });
}

async function hover(page: Page, target: Locator) {
  const point = await center(target);
  await page.mouse.move(point.x, point.y, { steps: 8 });
}

/** A one-finger touch drag through Chromium's touch input, which produces pointerType "touch"
 * pointer events. `during` runs while the finger is still down over the target. */
async function touchDrag(
  page: Page,
  from: Locator,
  to: Locator,
  during?: () => Promise<void>
) {
  const cdp = await page.context().newCDPSession(page);
  const a = await center(from);
  const b = await center(to);
  const send = (
    type: "touchStart" | "touchMove" | "touchEnd",
    point?: { x: number; y: number }
  ) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: point ? [{ x: point.x, y: point.y, id: 1 }] : [],
    });
  await send("touchStart", a);
  for (let step = 1; step <= 10; step++)
    await send("touchMove", {
      x: a.x + ((b.x - a.x) * step) / 10,
      y: a.y + ((b.y - a.y) * step) / 10,
    });
  if (during) await during();
  await send("touchEnd");
  await cdp.detach();
}

/** Group labels (full paths) of the panel's rows, top to bottom. */
const rowPaths = (panel: Locator) =>
  panel
    .getByRole("group")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? "")
    );

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("the gear opens Manage locations with the whole tree in natural order and each row's arranging controls", async ({
    page,
  }) => {
    await signIn(page);
    const f = await seed(page);
    await page.reload();
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const gear = button(sidebar, "Manage locations");
    // The gear sits after the root +. The shell reads the session before the page mounts, so wait for it.
    await expect(gear).toBeVisible();
    const tools = await sidebar
      .getByRole("button", { name: /^(Add location|Manage locations)$/ })
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label"))
      );
    expect(tools).toEqual(["Add location", "Manage locations"]);
    // Sidebar rows take card drops only: no sidebar row is a Location drag source.
    await expect(sidebar.locator('[draggable="true"]')).toHaveCount(0);

    await gear.click();
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    // The page behind the open panel doesn't scroll (the kit Dialog locks <body>, #166).
    expect(await page.evaluate(() => document.body.style.overflow)).toBe(
      "hidden"
    );
    await expect(row(panel, f.shelf)).toBeVisible();
    // The panel's handles use pointer events, not native drag and drop.
    await expect(panel.locator('[draggable="true"]')).toHaveCount(0);
    // A centred panel, narrower than the window.
    const box = (await panel.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThanOrEqual(1);
    expect(box.width).toBeLessThan(1280);

    // Natural, case-insensitive A–Z order at every level.
    const paths = await rowPaths(panel);
    expect(paths.filter((path) => path.startsWith(`${f.shelf} /`))).toEqual([
      `${f.shelf} / ${f.loose}`,
      `${f.shelf} / Binder 1`,
      `${f.shelf} / binder 2`,
      `${f.shelf} / Binder 10`,
      `${f.shelf} / Binder 10 / Page 1`,
      `${f.shelf} / Box`,
    ]);
    const top = [f.shelf, f.deck, f.spare].map((path) => paths.indexOf(path));
    expect(top[0]).toBeGreaterThanOrEqual(0);
    expect(top[1]).toBeGreaterThan(top[0]);
    expect(top[2]).toBeGreaterThan(top[1]);

    // Each row shows its kind.
    await expect(row(panel, `${f.shelf} / Box`)).toContainText("3 copies");
    await expect(row(panel, `${f.shelf} / Binder 1`)).toContainText("0 copies");
    await expect(row(panel, `${f.shelf} / Binder 10`)).toContainText("Folder");
    await expect(row(panel, f.deck)).toContainText("Deck · 0 copies");

    // A row keeps only its arranging controls: the handle and Add child (not on Decks).
    const binder1 = `${f.shelf} / Binder 1`;
    await expect(handle(panel, binder1)).toBeEnabled();
    await expect(
      button(panel, `Add child location to ${binder1}`)
    ).toBeEnabled();
    expect(
      await row(panel, binder1)
        .getByRole("button")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
    ).toEqual([`Move ${binder1}`, `Add child location to ${binder1}`]);
    // A Deck can be moved but has no Add child.
    expect(
      await row(panel, f.deck)
        .getByRole("button")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("aria-label"))
        )
    ).toEqual([`Move ${f.deck}`]);
    // Rename, Delete, Hide and For trade are in each Location's settings.
    await expect(
      panel.getByRole("button", { name: /^(Rename|Delete|Hide|Show|Mark) / })
    ).toHaveCount(0);

    // Escape closes the panel and returns focus to the gear.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(gear).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("");
  });

  test("a mouse drag on the handle nests a Location in a row or moves it to Top level, after confirmation", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const f = await seed(page);
    await page.reload();
    const panel = await openFromSidebar(page, f.shelf);
    const binder1 = `${f.shelf} / Binder 1`;
    const label = panel.getByText("Binder 1", { exact: true });
    const labels = await label.count();

    await lift(page, handle(panel, binder1));
    // A floating label with the Location's name follows the pointer, and the lifted row dims.
    await expect(label).toHaveCount(labels + 1);
    await expect(row(panel, binder1)).toHaveCSS("opacity", "0.4");
    await hover(page, row(panel, f.spare));
    await expect(row(panel, f.spare)).toHaveCSS("outline-style", "solid");
    await page.mouse.up();
    // The confirmation replaces the list, and the floating label is gone with the drag.
    await expect(panel.getByText("New path:")).toBeVisible();
    await expect(label).toHaveCount(0);

    // Nothing moves before the confirmation.
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.spare} / Binder 1`
    );
    expect((await client.node(f.ids.binder1))!.parent_id).toBe(f.ids.shelf);
    const moveHere = button(panel, "Move here");
    await expect(moveHere).toBeFocused();
    // "Move here" uses the accent design variables and lines up with "Choose another".
    const look = await moveHere.evaluate((element) => {
      const probe = document.createElement("span");
      probe.style.backgroundColor = "var(--color-accent)";
      probe.style.color = "var(--color-on-accent)";
      element.parentElement!.append(probe);
      const expected = getComputedStyle(probe);
      const actual = getComputedStyle(element);
      const result = {
        background: actual.backgroundColor,
        color: actual.color,
        expectedBackground: expected.backgroundColor,
        expectedColor: expected.color,
      };
      probe.remove();
      return result;
    });
    expect(look.background).toBe(look.expectedBackground);
    expect(look.color).toBe(look.expectedColor);
    const here = (await moveHere.boundingBox())!;
    const another = (await button(panel, "Choose another").boundingBox())!;
    expect(here.height).toBe(another.height);
    expect(here.y).toBe(another.y);

    await moveHere.click();
    await expect(row(panel, `${f.spare} / Binder 1`)).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText(
      `Moved Binder 1 to ${f.spare}.`
    );
    expect((await client.node(f.ids.binder1))!.parent_id).toBe(f.ids.spare);

    // Dragging onto Top level moves a Location out of every folder.
    await reveal(panel, f.shelf);
    await lift(page, handle(panel, `${f.shelf} / ${f.loose}`));
    await hover(page, panel.getByText("Top level", { exact: true }));
    await page.mouse.up();
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.loose}`
    );
    await button(panel, "Move here").click();
    await expect(row(panel, f.loose)).toBeVisible();
    expect((await client.node(f.ids.loose))!.parent_id).toBeNull();

    // The sidebar reloads: the spare leaf is now a folder holding Binder 1.
    await page.keyboard.press("Escape");
    const nav = page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("navigation", { name: "Locations" });
    await button(nav, f.spare).click();
    await expect(
      nav.getByRole("list", { name: f.spare, exact: true })
    ).toContainText("Binder 1");
  });

  test("invalid targets are dimmed and refuse the drop, and the picker leaves them out", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const f = await seed(page, { deep: true });
    await page.reload();
    const panel = await openFromSidebar(page, f.shelf);
    const source = `${f.shelf} / Binder 10`;
    // Binder 10 / Page 1 is two levels tall, so Level 11 (depth 11) would put Page 1 at depth 13.
    const invalid = [source, `${source} / Page 1`, f.deck, f.shelf, f.level11];
    const valid = [`${f.shelf} / Box`, f.spare, f.level10];

    await lift(page, handle(panel, source));
    for (const path of invalid)
      await expect(row(panel, path)).toHaveCSS("opacity", "0.4");
    for (const path of valid)
      await expect(row(panel, path)).toHaveCSS("outline-style", "dashed");
    await expect(panel.getByText("Top level", { exact: true })).toHaveCSS(
      "outline-style",
      "dashed"
    );
    // Releasing on a Deck changes nothing.
    await hover(page, row(panel, f.deck));
    await expect(row(panel, f.deck)).toHaveCSS("opacity", "0.4");
    await page.mouse.up();
    await expect(panel.getByText("New path:")).toHaveCount(0);
    await expect(
      panel.getByRole("list", { name: "New parent", exact: true })
    ).toHaveCount(0);

    // Releasing on the current parent changes nothing either.
    await reveal(panel, f.shelf);
    await lift(page, handle(panel, source));
    await hover(page, row(panel, f.shelf));
    await page.mouse.up();
    await expect(panel.getByText("New path:")).toHaveCount(0);
    expect((await client.node(f.ids.binder10))!.parent_id).toBe(f.ids.shelf);

    // The picker lists the same valid parents by full path, Top level first.
    await handle(panel, source).focus();
    await page.keyboard.press("Enter");
    const picker = panel.getByRole("list", { name: "New parent", exact: true });
    const options = await picker.getByRole("button").allTextContents();
    expect(options[0]).toBe("Top level");
    for (const path of valid) expect(options).toContain(path);
    for (const path of invalid) expect(options).not.toContain(path);
  });

  test("the handle opens the Move picker by keyboard, and a move into a stocked leaf explains the Unsorted conversion", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const f = await seed(page);
    await page.reload();
    const panel = await openFromSidebar(page, f.shelf);
    const binder1 = `${f.shelf} / Binder 1`;
    const picker = panel.getByRole("list", { name: "New parent", exact: true });

    // Enter on the focused handle opens the picker; Cancel returns to the handle.
    await handle(panel, binder1).focus();
    await page.keyboard.press("Enter");
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("button").first()).toHaveText("Top level");
    await expect(picker.getByRole("button").first()).toBeFocused();
    await button(panel, "Cancel").click();
    await expect(picker).toHaveCount(0);
    await expect(handle(panel, binder1)).toBeFocused();
    // Space opens it too.
    await page.keyboard.press("Space");
    await expect(picker).toBeVisible();

    await button(picker, `${f.shelf} / Box`).click();
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.shelf} / Box / Binder 1`
    );
    await expect(
      panel.getByText(
        "Box holds 3 copies. They move into a new Unsorted child inside it, so every card stays in a storage location."
      )
    ).toBeVisible();
    // Choose another goes back to the picker without changing anything.
    await button(panel, "Choose another").click();
    await expect(picker).toBeVisible();
    expect((await client.node(f.ids.binder1))!.parent_id).toBe(f.ids.shelf);

    await button(picker, `${f.shelf} / Box`).click();
    await button(panel, "Move here").click();
    await expect(row(panel, `${f.shelf} / Box / Binder 1`)).toBeVisible();
    await expect(row(panel, `${f.shelf} / Box / Unsorted`)).toContainText(
      "3 copies"
    );
    await expect(row(panel, `${f.shelf} / Box`)).toContainText("Folder");
    const nodes = await client.tree();
    const unsorted = nodes.find(
      (n) => n.parent_id === f.ids.box && n.name === "Unsorted"
    );
    expect(unsorted?.copy_count).toBe("3");
    expect(nodes.find((n) => n.id === f.ids.box)?.kind).toBe("organization");
    expect(nodes.find((n) => n.id === f.ids.binder1)?.parent_id).toBe(
      f.ids.box
    );
  });

  test("the gallery shows the new path after a move through the panel, without a reload", async ({
    page,
  }) => {
    await signIn(page);
    const f = await seed(page);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await expect(
      page.getByRole("button", {
        name: new RegExp(`, ${f.shelf} / Box$`),
      })
    ).toHaveCount(3);
    const panel = await openFromSidebar(page, f.shelf);
    await handle(panel, `${f.shelf} / Binder 1`).focus();
    await page.keyboard.press("Enter");
    await button(
      panel.getByRole("list", { name: "New parent", exact: true }),
      `${f.shelf} / Box`
    ).click();
    await button(panel, "Move here").click();
    await expect(row(panel, `${f.shelf} / Box / Unsorted`)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`, ${f.shelf} / Box / Unsorted$`),
      })
    ).toHaveCount(3);
  });

  test("a Deck is moved into a folder by drag and back to Top level by the picker, and stays a Deck", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const f = await seed(page);
    const otherDeck = `${f.shelf} Other Deck`;
    const otherDeckId = await client.deck(otherDeck);
    await page.reload();
    const panel = await openFromSidebar(page, f.shelf);

    // A handle drag nests it in a folder after confirmation. Decks, itself included, refuse it.
    await reveal(panel, f.shelf);
    await lift(page, handle(panel, f.deck));
    await expect(row(panel, f.deck)).toHaveCSS("opacity", "0.4");
    await expect(row(panel, otherDeck)).toHaveCSS("opacity", "0.4");
    await hover(page, row(panel, `${f.shelf} / Binder 1`));
    await expect(row(panel, `${f.shelf} / Binder 1`)).toHaveCSS(
      "outline-style",
      "solid"
    );
    await page.mouse.up();
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.shelf} / Binder 1 / ${f.deck}`
    );
    expect((await client.node(f.ids.deck))!.parent_id).toBeNull();
    await button(panel, "Move here").click();
    const nested = `${f.shelf} / Binder 1 / ${f.deck}`;
    await expect(row(panel, nested)).toBeVisible();
    await expect(panel.getByRole("status")).toHaveText(
      `Moved ${f.deck} to ${f.shelf} / Binder 1.`
    );
    await expect(row(panel, nested)).toContainText("Deck · 0 copies");
    await expect(
      row(panel, nested).getByRole("button", { name: /^Add child/ })
    ).toHaveCount(0);
    expect(await client.node(f.ids.deck)).toMatchObject({
      kind: "deck",
      parent_id: f.ids.binder1,
    });
    expect((await client.node(f.ids.binder1))!.kind).toBe("organization");

    // The picker offers Top level first and never a Deck or the current parent.
    await handle(panel, nested).focus();
    await page.keyboard.press("Enter");
    const picker = panel.getByRole("list", { name: "New parent", exact: true });
    const options = await picker.getByRole("button").allTextContents();
    expect(options[0]).toBe("Top level");
    expect(options).toContain(f.spare);
    expect(options).not.toContain(otherDeck);
    expect(options).not.toContain(`${f.shelf} / Binder 1`);
    await button(picker, "Top level").click();
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.deck}`
    );
    await button(panel, "Move here").click();
    await expect(row(panel, f.deck)).toBeVisible();
    await expect(row(panel, nested)).toHaveCount(0);
    expect((await client.node(f.ids.deck))!.parent_id).toBeNull();
    // Binder 1 lost its only child and is an empty Storage Leaf again.
    expect((await client.node(f.ids.binder1))!.kind).toBe("storage_leaf");
    expect((await client.node(otherDeckId))!.name).toBe(otherDeck);
  });

  test("Add child opens the create form with the row preselected and returns to the panel", async ({
    page,
  }) => {
    await signIn(page);
    const f = await seed(page);
    await page.reload();
    const panel = await openFromSidebar(page, f.shelf);
    const binder10 = `${f.shelf} / Binder 10`;
    const add = button(panel, `Add child location to ${binder10}`);
    await add.click();
    const create = page.getByRole("dialog", { name: "Add location" });
    await expect(create).toBeVisible();
    await expect(
      create.getByLabel("Parent location").locator("option:checked")
    ).toHaveText(binder10);
    await create.getByLabel("Name", { exact: true }).fill("Page 2");
    await button(create, "Create location").click();
    await expect(create).toBeHidden();
    await expect(panel).toBeVisible();
    await expect(row(panel, `${binder10} / Page 2`)).toBeVisible();
    await expect(add).toBeFocused();
    // Escape in the create form closes only the form.
    await add.click();
    await expect(create).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(create).toBeHidden();
    await expect(panel).toBeVisible();
  });

  test("a stale move fails without changes and reloads the tree", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const f = await seed(page);
    await page.reload();
    const panel = await openFromSidebar(page, f.shelf);
    const binder1 = `${f.shelf} / Binder 1`;
    await expect(row(panel, binder1)).toBeVisible();

    // Another session renames Binder 1 first, so this panel still shows the old version.
    await client.rename(f.ids.binder1, "Binder 1 elsewhere");

    // Its move is refused and the tree reloads.
    await handle(panel, binder1).click();
    await button(
      panel.getByRole("list", { name: "New parent", exact: true }),
      f.spare
    ).click();
    await button(panel, "Move here").click();
    await expect(panel.getByRole("alert")).toContainText("nothing was changed");
    await expect(row(panel, `${f.shelf} / Binder 1 elsewhere`)).toBeVisible();
    await expect(row(panel, binder1)).toHaveCount(0);
    expect((await client.node(f.ids.binder1))!.name).toBe("Binder 1 elsewhere");
    expect((await client.node(f.ids.binder1))!.parent_id).toBe(f.ids.shelf);
  });
});

test.describe("mobile", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the drawer gear opens a full-screen sheet where touch drags and taps on the handle work", async ({
    page,
  }) => {
    await signIn(page);
    const client = api(page);
    const f = await seed(page);
    await page.reload();
    const opener = button(page.getByRole("banner"), "Open locations");
    await opener.click();
    const drawer = page.getByRole("dialog", { name: "Locations", exact: true });
    const gear = button(drawer, "Manage locations");
    await expectTouchTarget(gear);
    await gear.click();
    await expect(drawer).toBeHidden();
    const panel = panelOf(page);
    await expect(panel).toBeVisible();
    await expect
      .poll(() => panel.boundingBox())
      .toEqual({
        x: 0,
        y: 0,
        width: 375,
        height: 812,
      });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth)
    ).toBeLessThanOrEqual(375);
    await reveal(panel, f.shelf);

    const binder1 = `${f.shelf} / Binder 1`;
    await expectTouchTarget(handle(panel, binder1));
    for (const name of [`Add child location to ${binder1}`])
      await expectTouchTarget(button(panel, name), ["height"]);
    await expect(
      row(panel, binder1).getByRole("button", { name: /^(Rename|Delete) / })
    ).toHaveCount(0);

    // A tap on the handle opens the picker.
    await handle(panel, binder1).tap();
    const picker = panel.getByRole("list", { name: "New parent", exact: true });
    await expect(picker).toBeVisible();
    await button(panel, "Cancel").click();
    await reveal(panel, f.shelf);

    // A touch drag onto a row nests the Location there.
    const label = panel.getByText("Binder 1", { exact: true });
    const labels = await label.count();
    await touchDrag(
      page,
      handle(panel, binder1),
      row(panel, `${f.shelf} / binder 2`),
      async () => {
        await expect(label).toHaveCount(labels + 1);
        await expect(row(panel, `${f.shelf} / binder 2`)).toHaveCSS(
          "outline-style",
          "solid"
        );
        await expect(row(panel, f.deck)).toHaveCSS("opacity", "0.4");
      }
    );
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.shelf} / binder 2 / Binder 1`
    );
    await button(panel, "Move here").click();
    await expect(row(panel, `${f.shelf} / binder 2 / Binder 1`)).toBeVisible();
    expect((await client.node(f.ids.binder1))!.parent_id).toBe(f.ids.binder2);

    // A touch drag onto Top level moves it out of every folder.
    await reveal(panel, f.shelf);
    await touchDrag(
      page,
      handle(panel, `${f.shelf} / ${f.loose}`),
      panel.getByText("Top level", { exact: true })
    );
    await expect(panel.getByText("New path:")).toHaveText(
      `New path: ${f.loose}`
    );
    await button(panel, "Move here").click();
    await expect(row(panel, f.loose)).toBeVisible();
    expect((await client.node(f.ids.loose))!.parent_id).toBeNull();

    // Closing returns focus to the drawer's opener.
    await button(panel, "Close manage locations").click();
    await expect(panel).toBeHidden();
    await expect(opener).toBeFocused();
  });
});
