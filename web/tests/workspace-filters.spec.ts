import { test, expect, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

type TreeNode = { id: string; name: string; version: number };

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);

type Card = {
  name: string;
  set: [id: string, name: string];
  number: string;
  category: "Pokemon" | "Trainer" | "Energy";
  types?: string[];
  trainerType?: string;
};

/** Five Printings across two sets. Set B's numbers 1, 2 and 10 check numeric order. */
const CARDS: Record<string, Card> = {
  "card-1": {
    name: "Charmander",
    set: ["set-a", "Alpha Set"],
    number: "4",
    category: "Pokemon",
    types: ["Fire"],
  },
  "card-2": {
    name: "Squirtle",
    set: ["set-a", "Alpha Set"],
    number: "7",
    category: "Pokemon",
    types: ["Water"],
  },
  "card-3": {
    name: "Potion",
    set: ["set-b", "Beta Set"],
    number: "2",
    category: "Trainer",
    trainerType: "Item",
  },
  "card-4": {
    name: "Basic Fire Energy",
    set: ["set-b", "Beta Set"],
    number: "10",
    category: "Energy",
    types: ["Fire"],
  },
  "card-5": {
    name: "Vaporeon",
    set: ["set-b", "Beta Set"],
    number: "1",
    category: "Pokemon",
    types: ["Water"],
  },
};

/** Replaces the catalog with CARDS through the real import, so the card attributes the filters read
 * (card kind, Trainer Type and types) are derived the way a TCGdex pull derives them. This also clears
 * every Holding. */
function promoteCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
import test_catalog_search as search
cards = json.loads(sys.argv[1])
class Attributed(search.SearchSource):
    def fetch(self, source_id):
        card = cards[source_id]
        record = {"id": source_id, "name": card["name"], "localId": card["number"],
                  "set": {"id": card["set"][0], "name": card["set"][1]}, "category": card["category"],
                  "image": "https://assets.tcgdex.net/en/fixture/" + source_id,
                  "variants": {"normal": True, "reverse": False}}
        if card.get("types"):
            record["types"] = card["types"]
        if card.get("trainerType"):
            record["trainerType"] = card["trainerType"]
        if card["category"] == "Energy":
            record["energyType"] = "Normal"
        return record
search.SearchSource = Attributed
search.promote({key: card["name"] for key, card in cards.items()})`,
      JSON.stringify(CARDS),
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

/** Binder and Box (top-level Storage Leaves) holding 15 copies:
 * Charmander 1 + 4, Squirtle 3, Potion 1, Basic Fire Energy 2, Vaporeon 4.
 * All owned totals: Charmander 5, Vaporeon 4, Squirtle 3, Energy 2, Potion 1.
 * In Binder: Vaporeon 4, Squirtle 3, Charmander 1. */
async function seed(page: Page) {
  const suffix = randomUUID().slice(0, 6);
  const binderName = `Binder ${suffix}`;
  const binder = await createLocation(page, binderName);
  const box = await createLocation(page, `Box ${suffix}`);
  const [charmander, squirtle, potion, energy, vaporeon] = await Promise.all(
    ["card-1", "card-2", "card-3", "card-4", "card-5"].map(editionOf)
  );
  await addCopies(page, binder, charmander, 1);
  await addCopies(page, box, charmander, 4);
  await addCopies(page, binder, squirtle, 3);
  await addCopies(page, box, potion, 1);
  await addCopies(page, box, energy, 2);
  await addCopies(page, binder, vaporeon, 4);
  await page.reload();
  await expect(tiles(page)).toHaveCount(15);
  return { binderName };
}

const cards = (page: Page) => page.getByRole("region", { name: "Cards" });
const tiles = (page: Page) => cards(page).getByRole("button");
const counts = (page: Page, text: string) =>
  page.getByRole("main").getByText(text, { exact: true });
const selectionBar = (page: Page) =>
  page.getByRole("region", { name: "Selection" });

/** Card Edition names in display order, each once (tile labels start with the card name). */
async function editionOrder(page: Page): Promise<string[]> {
  const labels = await tiles(page).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("aria-label") ?? "")
  );
  return labels
    .map((label) => label.split(", ")[0])
    .filter((name, index, all) => index === 0 || all[index - 1] !== name);
}

const ALL = [
  "Basic Fire Energy",
  "Charmander",
  "Potion",
  "Squirtle",
  "Vaporeon",
];

/** The desktop filter panel's controls. */
const panel = (page: Page) =>
  page.getByRole("region", { name: "Card filters" });

async function expectEditions(page: Page, names: string[]) {
  await expect.poll(() => editionOrder(page)).toEqual(names);
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1600, height: 900 } });

  test("the toolbar keeps Search and Filters left and Sort, Card size and Names right, at one height", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await seed(page);
    const controls: Locator[] = [
      page.getByRole("searchbox", { name: "Search cards" }),
      page.getByRole("button", { name: "Filters", exact: true }),
      page.getByLabel("Sort", { exact: true }),
      page.getByLabel("Card size", { exact: true }),
      page.getByRole("button", { name: "Names", exact: true }),
    ];
    const boxes = await Promise.all(controls.map((c) => c.boundingBox()));
    for (const box of boxes) {
      expect(Math.abs(box!.height - boxes[0]!.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThanOrEqual(1);
    }
    for (let n = 1; n < boxes.length; n++)
      expect(boxes[n]!.x).toBeGreaterThan(
        boxes[n - 1]!.x + boxes[n - 1]!.width
      );
    // The right group is pushed to the far end: a wide gap separates Filters from Sort.
    expect(boxes[2]!.x - (boxes[1]!.x + boxes[1]!.width)).toBeGreaterThan(40);
  });

  test("each filter narrows the gallery, filters combine, an indicator counts them and Clear filters resets only them", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await seed(page);
    const filters = page.getByRole("button", { name: /^Filters/ });
    await expect(filters).toHaveAccessibleName("Filters");
    await expect(filters).toHaveAttribute("aria-expanded", "false");
    await expect(panel(page)).toHaveCount(0);
    await filters.click();
    await expect(filters).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page)).toBeVisible();

    // The Set filter offers the sets of the cards owned, once each, by name.
    const set = panel(page).getByLabel("Set", { exact: true });
    await expect(set.locator("option")).toHaveText([
      "All",
      "Alpha Set",
      "Beta Set",
    ]);
    await set.selectOption({ label: "Beta Set" });
    await expectEditions(page, ["Basic Fire Energy", "Potion", "Vaporeon"]);
    await expect(counts(page, "7 copies · 3 editions")).toBeVisible();
    await expect(filters).toHaveAccessibleName("Filters, 1 active");
    await set.selectOption("");

    const category = panel(page).getByLabel("Category", { exact: true });
    await expect(category.locator("option")).toHaveText([
      "All",
      "Pokémon",
      "Trainer: any type",
      "Trainer: Supporter",
      "Trainer: Item",
      "Trainer: Pokémon Tool",
      "Trainer: Stadium",
      "Energy",
    ]);
    await category.selectOption({ label: "Pokémon" });
    await expectEditions(page, ["Charmander", "Squirtle", "Vaporeon"]);
    await category.selectOption({ label: "Trainer: any type" });
    await expectEditions(page, ["Potion"]);
    // A Trainer Type lists the Trainers of that type (spec "Card type: one source").
    await category.selectOption({ label: "Trainer: Item" });
    await expectEditions(page, ["Potion"]);
    await expect(filters).toHaveAccessibleName("Filters, 1 active");
    await expectPageChecks(page, "Collection, Filters open (desktop)");
    await category.selectOption({ label: "Trainer: Supporter" });
    await expect(tiles(page)).toHaveCount(0);
    await category.selectOption({ label: "Energy" });
    await expectEditions(page, ["Basic Fire Energy"]);
    await category.selectOption("");

    const type = panel(page).getByLabel("Elemental type", { exact: true });
    // Elemental types are a Pokémon's types: a Basic Energy has none in the card attributes.
    await type.selectOption("Fire");
    await expectEditions(page, ["Charmander"]);
    await type.selectOption("Water");
    await expectEditions(page, ["Squirtle", "Vaporeon"]);

    // Combined: Water and Beta Set, then also Pokémon; each narrows independently.
    await set.selectOption({ label: "Beta Set" });
    await expectEditions(page, ["Vaporeon"]);
    await category.selectOption({ label: "Pokémon" });
    await expectEditions(page, ["Vaporeon"]);
    await expect(filters).toHaveAccessibleName("Filters, 3 active");
    await expect(filters).toContainText("3");
    await category.selectOption({ label: "Trainer: any type" });
    await expect(tiles(page)).toHaveCount(0);
    await expect(
      cards(page).getByText("No cards match your search or filters.")
    ).toBeVisible();

    // Clear filters resets the three filters and nothing else.
    await page
      .getByLabel("Sort", { exact: true })
      .selectOption({ label: "Quantity ↓" });
    await page.getByLabel("Card size", { exact: true }).selectOption("medium");
    const names = page.getByRole("button", { name: "Names", exact: true });
    await names.click();
    await panel(page).getByRole("button", { name: "Clear filters" }).click();
    await expect(tiles(page)).toHaveCount(15);
    await expect(filters).toHaveAccessibleName("Filters");
    await expect(set).toHaveValue("");
    await expect(category).toHaveValue("");
    await expect(type).toHaveValue("");
    await expect(
      panel(page).getByRole("button", { name: "Clear filters" })
    ).toBeDisabled();
    await expect(page.getByLabel("Sort", { exact: true })).toHaveValue(
      "quantity-desc"
    );
    await expect(page.getByLabel("Card size", { exact: true })).toHaveValue(
      "medium"
    );
    await expect(names).toHaveAttribute("aria-pressed", "true");
  });

  test("each sort orders Card Editions, and quantity uses the total in the current view", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    const { binderName } = await seed(page);
    const sort = page.getByLabel("Sort", { exact: true });
    await expect(sort).toHaveValue("name-asc");
    await expectEditions(page, ALL);
    await sort.selectOption({ label: "Name Z–A" });
    await expectEditions(page, [...ALL].reverse());
    // Set name, then collector number as a number: Beta Set 1, 2, 10.
    await sort.selectOption({ label: "Set / number ↑" });
    await expectEditions(page, [
      "Charmander",
      "Squirtle",
      "Vaporeon",
      "Potion",
      "Basic Fire Energy",
    ]);
    await sort.selectOption({ label: "Set / number ↓" });
    await expectEditions(page, [
      "Basic Fire Energy",
      "Potion",
      "Vaporeon",
      "Squirtle",
      "Charmander",
    ]);
    await sort.selectOption({ label: "Quantity ↓" });
    await expectEditions(page, [
      "Charmander",
      "Vaporeon",
      "Squirtle",
      "Basic Fire Energy",
      "Potion",
    ]);
    await sort.selectOption({ label: "Quantity ↑" });
    await expectEditions(page, [
      "Potion",
      "Basic Fire Energy",
      "Squirtle",
      "Vaporeon",
      "Charmander",
    ]);
    // Copies of one Edition stay together, in source Location order.
    const labels = await tiles(page).evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("aria-label") ?? "")
    );
    expect(labels.slice(-5).map((label) => label.split(", ").at(-1))).toEqual([
      binderName,
      ...Array(4).fill(expect.stringMatching(/^Box /)),
    ]);

    // In Binder, Charmander has 1 copy, so it falls below Squirtle.
    await page
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: binderName, exact: true })
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      binderName
    );
    await sort.selectOption({ label: "Quantity ↓" });
    await expectEditions(page, ["Vaporeon", "Squirtle", "Charmander"]);
  });

  test("search finds cards by name; sort, filters, card size and Names are remembered and search is not", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await seed(page);
    const search = page.getByRole("searchbox", { name: "Search cards" });
    await search.fill("CHAR");
    await expectEditions(page, ["Charmander"]);
    await search.fill("eon");
    await expectEditions(page, ["Vaporeon"]);
    await search.fill("fire");
    await expectEditions(page, ["Basic Fire Energy"]);
    await search.fill("zzz");
    await expect(tiles(page)).toHaveCount(0);
    await expect(
      cards(page).getByText("No cards match your search or filters.")
    ).toBeVisible();
    await search.fill("");
    await expect(tiles(page)).toHaveCount(15);

    await page
      .getByLabel("Sort", { exact: true })
      .selectOption({ label: "Quantity ↓" });
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await panel(page)
      .getByLabel("Category", { exact: true })
      .selectOption({ label: "Pokémon" });
    await panel(page)
      .getByLabel("Set", { exact: true })
      .selectOption({ label: "Alpha Set" });
    await page.getByLabel("Card size", { exact: true }).selectOption("medium");
    await page.getByRole("button", { name: "Names", exact: true }).click();
    await search.fill("squirt");
    await expectEditions(page, ["Squirtle"]);

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await expect(search).toHaveValue("");
    await expect(page.getByLabel("Sort", { exact: true })).toHaveValue(
      "quantity-desc"
    );
    await expect(page.getByLabel("Card size", { exact: true })).toHaveValue(
      "medium"
    );
    await expect(
      page.getByRole("button", { name: "Names", exact: true })
    ).toHaveAttribute("aria-pressed", "true");
    const filters = page.getByRole("button", { name: /^Filters/ });
    await expect(filters).toHaveAccessibleName("Filters, 2 active");
    await filters.click();
    await expect(
      panel(page).getByLabel("Category", { exact: true })
    ).toHaveValue("Pokemon");
    await expect(panel(page).getByLabel("Set", { exact: true })).toHaveValue(
      "set-a"
    );
    await expectEditions(page, ["Charmander", "Squirtle"]);
    await expect(cards(page).getByText("Charmander").first()).toBeVisible();
  });

  test("sorting keeps the selection; search or a filter change clears it; the inspector shows category and type", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await seed(page);
    const vaporeon = cards(page).getByRole("button", { name: /^Vaporeon,/ });
    await vaporeon.first().click();
    await expect(selectionBar(page)).toContainText("1 copy selected");
    const details = page.getByRole("complementary", { name: "Card details" });
    await expect(details).toContainText("Pokémon · Water");
    await cards(page)
      .getByRole("button", { name: /^Potion,/ })
      .first()
      .click();
    await expect(
      details.getByText("Trainer · Item", { exact: true })
    ).toBeVisible();
    await vaporeon.first().click();
    await expect(details).toContainText("Pokémon · Water");
    await cards(page)
      .getByRole("button", { name: /^Basic Fire Energy,/ })
      .first()
      .click({ modifiers: ["ControlOrMeta"] });
    await expect(selectionBar(page)).toContainText("2 copies selected");
    await expect(details.getByText("Energy", { exact: true })).toBeVisible();

    await page
      .getByLabel("Sort", { exact: true })
      .selectOption({ label: "Quantity ↓" });
    await expectEditions(page, [
      "Charmander",
      "Vaporeon",
      "Squirtle",
      "Basic Fire Energy",
      "Potion",
    ]);
    await expect(selectionBar(page)).toContainText("2 copies selected");
    await expect(vaporeon.first()).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await panel(page)
      .getByLabel("Elemental type", { exact: true })
      .selectOption("Water");
    await expectEditions(page, ["Vaporeon", "Squirtle"]);
    await expect(selectionBar(page)).toHaveCount(0);
    await expect(vaporeon.first()).toHaveAttribute("aria-pressed", "false");

    await vaporeon.first().click();
    await expect(selectionBar(page)).toContainText("1 copy selected");
    await page.getByRole("searchbox", { name: "Search cards" }).fill("vap");
    await expectEditions(page, ["Vaporeon"]);
    await expect(selectionBar(page)).toHaveCount(0);
  });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("the Filters & display drawer opens from the right and applies changes at once, which stay after it closes", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await seed(page);
    const header = page.getByRole("banner");
    const opener = header.getByRole("button", { name: /^Filters & display/ });
    await expect(opener).toHaveAccessibleName("Filters & display");
    const openerBox = await expectTouchTarget(opener);
    const searchBox = (await header
      .getByRole("searchbox", { name: "Search cards" })
      .boundingBox())!;
    expect(openerBox.x).toBeGreaterThan(searchBox.x + searchBox.width);
    expect(openerBox.x + openerBox.width).toBeLessThanOrEqual(375);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);

    await opener.click();
    const drawer = page.getByRole("dialog", { name: "Filters & display" });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Close filters & display" })
    ).toBeFocused();
    // Anchored right.
    await expect
      .poll(async () => {
        const box = await drawer.boundingBox();
        return box ? Math.round(box.x + box.width) : null;
      })
      .toBe(375);
    for (const label of [
      "Set",
      "Category",
      "Elemental type",
      "Sort",
      "Card size",
    ])
      await expect(drawer.getByLabel(label, { exact: true })).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Clear filters" })
    ).toBeVisible();

    // A change applies while the drawer is still open.
    const listed = page.waitForRequest(
      (request) =>
        request.url().includes("/api/collection/holdings") &&
        request.url().includes("category=Trainer")
    );
    await drawer
      .getByLabel("Category", { exact: true })
      .selectOption({ label: "Trainer: any type" });
    await listed;
    await expectPageChecks(page, "Collection, Filters & display open (phone)");
    await drawer.getByRole("button", { name: "Names", exact: true }).click();
    await expect(
      drawer.getByRole("button", { name: "Names", exact: true })
    ).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await expectEditions(page, ["Potion"]);
    await expect(cards(page).getByText("Potion").first()).toBeVisible();
    await expect(opener).toHaveAccessibleName("Filters & display, 1 active");

    // Reopened, it still shows the change; Clear filters resets it; the backdrop closes the drawer.
    await opener.click();
    await expect(drawer.getByLabel("Category", { exact: true })).toHaveValue(
      "Trainer"
    );
    await drawer
      .getByLabel("Sort", { exact: true })
      .selectOption({ label: "Name Z–A" });
    await drawer.getByRole("button", { name: "Clear filters" }).click();
    await page.mouse.click(10, 400);
    await expect(drawer).toBeHidden();
    await expect(opener).toHaveAccessibleName("Filters & display");
    await expect(tiles(page)).toHaveCount(15);
    await expectEditions(page, [...ALL].reverse());
  });

  test("the drawer closes with Escape, the close button or the backdrop, returns focus to its opener and keeps the selection", async ({
    page,
  }) => {
    promoteCatalog();
    await signIn(page);
    await seed(page);
    const opener = page
      .getByRole("banner")
      .getByRole("button", { name: /^Filters & display/ });
    const drawer = page.getByRole("dialog", { name: "Filters & display" });

    await page.getByRole("button", { name: "Select", exact: true }).tap();
    await tiles(page).nth(0).tap();
    await expect(selectionBar(page)).toContainText("1 copy selected");

    await opener.click();
    await expect(drawer).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(selectionBar(page)).toContainText("1 copy selected");

    await opener.click();
    await expect(drawer).toBeVisible();
    await drawer
      .getByRole("button", { name: "Close filters & display" })
      .click();
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(selectionBar(page)).toContainText("1 copy selected");

    await opener.click();
    await expect(drawer).toBeVisible();
    await page.mouse.click(10, 400);
    await expect(drawer).toBeHidden();
    await expect(opener).toBeFocused();
    await expect(selectionBar(page)).toContainText("1 copy selected");
  });
});
