import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

// Ticket 112, moved by #181: an open Deck in Collection shows a banner with its Estimated Deck Cost, its Deck List cost
// and cost to complete, and a link to the deck builder, whose page header now holds the exports (one Export dialog
// for Pokémon TCG Live and TCGplayer Mass Entry). The cost and export panels are the existing components; these tests
// prove the pages wire them to the server's complete Deck read. Seeding mirrors mass-entry.spec.ts,
// deck-cost.spec.ts and live-export.spec.ts. The file runs the Mass Entry tests first, then cost, then Live,
// so each seed sees the state its original spec already tolerates.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const TCGPLAYER = "https://www.tcgplayer.com/massentry?productline=Pokemon&c=";

const lastOtp = () =>
  JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;

/** Runs Python against the live stack's database, passing `argument` as a JSON file. */
function python(code: string, argument: object = {}): string {
  const path = `${process.env.TMPDIR || "/tmp"}/deck-heading-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
}

// --- Seeds -------------------------------------------------------------------------------------------

/** As mass-entry.spec.ts: `cards` Furret Printings; `mapped` maps card number -> verified TCGplayer product. */
function massWorld(cards: number, mapped: Record<number, number>) {
  python(
    `import json, sys
from app import public_catalog
public_catalog.publish_catalog_best_effort = lambda *a, **k: True
from app.main import connect
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_catalog_targets import card, metadata
from test_metadata_reviews import decide, evidence, seed_users
spec = json.load(open(sys.argv[1]))
seed_users()
run(Records(*[card(i) for i in range(1, spec['cards'] + 1)]))
for number, product in spec['mapped'].items():
    edition = metadata(f"meta-{number}")[1]["normal"]["id"]
    response = decide(evidence("editions", str(edition)), "correct", {"product_id": product, "quote_variant": None})
    assert response.status_code == 200, response.text
with connect() as conn:
    conn.execute("DELETE FROM owner_binding")`,
    { cards, mapped }
  );
}
const massEdition = async (number: number) =>
  (
    await pool.query(
      `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
       WHERE p.source_id=$1 AND e.descriptor->>'type'='normal'`,
      [`meta-${number}`]
    )
  ).rows[0].id as string;

type PriceIds = {
  normal: string;
  "reverse-holofoil": string;
  unspecified: string;
};
/** As deck-cost.spec.ts: a verified normal and reverse Edition of one Printing and an unpriced Edition of another,
 * with $0.25 (fresh) and $0.43 (three days old, so stale) quotes. */
function priceWorld(): PriceIds {
  const out = python(`import json
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(0)))`);
  const ids = JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5)) as PriceIds;
  const ago = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  python(
    `import json, sys
from test_prices import ui_apply
ui_apply(json.load(open(sys.argv[1])))`,
    [
      {
        op: "quote",
        edition: ids.normal,
        amount: "0.25",
        updated: ago(1),
        checked: ago(0.1),
      },
      {
        op: "quote",
        edition: ids["reverse-holofoil"],
        amount: "0.43",
        updated: ago(72),
        checked: ago(0.1),
      },
    ]
  );
  return ids;
}

type LiveCard = {
  key: string;
  name: string;
  number: string;
  category: string;
  live?: { name: string; set_code: string; number: string } | "suspended";
  finishes?: object[];
  set_name?: string;
};
type LiveWorld = Record<string, { printing: string; editions: string[] }>;
/** As live-export.spec.ts: Printings with reviewed Live identities. */
function liveWorld(cards: LiveCard[]): LiveWorld {
  const out = python(
    `import json, sys
from test_deck_live_export import seed_world
spec = json.load(open(sys.argv[1]))
world, _ = seed_world(spec['cards'], bulk=False)
print('WORLD' + json.dumps(world))`,
    { cards }
  );
  return JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5));
}
const MIXED: LiveCard[] = [
  {
    key: "mon",
    name: "Gholdengo ex",
    number: "139",
    category: "Pokemon",
    live: { name: "Gholdengo ex", set_code: "PAR", number: "139" },
    finishes: [{ finish: "normal" }, { finish: "reverse" }],
  },
  {
    key: "promo",
    name: "Gholdengo ex",
    number: "SV01",
    category: "Pokemon",
    live: { name: "Gholdengo ex", set_code: "SVP", number: "SV01" },
  },
  {
    key: "trainer",
    name: "Ultra Ball",
    number: "196",
    category: "Trainer",
    live: { name: "Ultra Ball", set_code: "SVI", number: "196" },
  },
  {
    key: "basic",
    name: "Metal Energy",
    number: "8",
    category: "Energy",
    live: { name: "Metal Energy", set_code: "SVE", number: "8" },
  },
];
const MIXED_TEXT =
  "Pokémon: 5\n3 Gholdengo ex PAR 139\n2 Gholdengo ex SVP SV01\n\nTrainer: 4\n4 Ultra Ball SVI 196\n\nEnergy: 9\n9 Metal Energy SVE 8";

// --- Session, Decks and navigation -------------------------------------------------------------------

async function signIn(page: Page) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await page.goto(`${ORIGIN}/locations`);
  await expect(page).toHaveURL(/\/collection(\?|$)/);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  await page.getByLabel("Six-digit code").fill(lastOtp());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}
const owner = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** Creates a Deck through the gateway and stores `[edition, quantity]` Holdings by SQL with one revision bump. */
async function deckWith(
  page: Page,
  quantities: [string, number][],
  prefix = "Heading"
): Promise<{ id: string; name: string }> {
  const name = `${prefix} ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).location.id as string;
  if (quantities.length) {
    const user = await owner();
    for (const [edition, quantity] of quantities)
      await pool.query(
        "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,$4,1)",
        [user, id, edition, quantity]
      );
    await pool.query(
      "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
      [user]
    );
  }
  return { id, name };
}

/** Adds copies through the API, as a collector would (bumps the owner revision). */
async function put(
  page: Page,
  deckId: string,
  edition: string,
  quantity: number
) {
  const added = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers: { origin: ORIGIN },
    data: {
      location_id: deckId,
      edition_id: edition,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    },
  });
  expect(added.status()).toBe(200);
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const costOf = (page: Page) =>
  page.getByRole("region", { name: "Estimated Deck Cost" });
const exportButton = (page: Page) =>
  page.getByRole("button", { name: "Export", exact: true });

/** Opens the workspace at All owned, then the named Location from the desktop sidebar. */
async function openInWorkspace(page: Page, name: string) {
  await page.goto(`${ORIGIN}/collection`);
  await expect(heading(page)).toHaveText("All owned");
  await page
    .getByRole("navigation", { name: "Locations" })
    .getByRole("button", { name, exact: true })
    .click();
  await expect(heading(page)).toHaveText(name);
}

/** Opens the Deck in the deck builder by its address. */
async function openBuilder(page: Page, deck: { id: string; name: string }) {
  await page.goto(`${ORIGIN}/decks/${deck.id}`);
  await expect(heading(page)).toHaveText(deck.name);
}

/** Opens one export from the deck builder's Export dialog and returns the dialog. These Decks hold every card they
 * list, so Mass Entry sends the whole Deck List. */
async function openExport(
  page: Page,
  item: "Pokémon TCG Live" | "TCGplayer Mass Entry"
) {
  await exportButton(page).click();
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: item }).click();
  if (item === "TCGplayer Mass Entry")
    await dialog.getByRole("radio", { name: /^The whole Deck List/ }).check();
  return dialog;
}
const banner = (page: Page) =>
  page.getByRole("region", { name: "Deck banner" });

test.beforeEach(async ({ context }) => {
  // Real TCGplayer is never contacted.
  await context.route("https://www.tcgplayer.com/**", (route) => route.abort());
});
test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

// --- TCGplayer Mass Entry ----------------------------------------------------------------------------

test("Mass Entry from the deck builder's Export falls back to complete labelled text when a mapping is missing", async ({
  page,
}) => {
  massWorld(3, { 1: 5001, 2: 5002 });
  await pool.query(
    `UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed'
     WHERE edition_id=$1`,
    [await massEdition(2)]
  );
  await signIn(page);
  const deck = await deckWith(page, []);
  await put(page, deck.id, await massEdition(1), 3);
  await put(page, deck.id, await massEdition(2), 2);
  await put(page, deck.id, await massEdition(3), 1); // never verified
  await openBuilder(page, deck);
  const dialog = await openExport(page, "TCGplayer Mass Entry");
  await expect(dialog).toContainText(deck.name);
  const region = dialog.getByRole("region", {
    name: "TCGplayer export",
    exact: true,
  });
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText("No TCGplayer link is offered");
  await expect(region).toContainText("Less specific: 3 of 3 rows");
  await expect(region).toContainText("Basic deck checks only");
  await expect(region).toContainText("6 cards, not 60");
  await expect(
    region.getByRole("button", { name: "Open in TCGplayer" })
  ).toHaveCount(0);
  const text = region.getByLabel("TCGplayer Mass Entry text");
  const shown = (await text.textContent())!;
  expect(shown.split("\n").sort()).toEqual([
    "1 Furret",
    "2 Furret",
    "3 Furret",
  ]);
});

test("an all-mapped Deck offers the TCGplayer link only after the explanation, and Escape closes only the explanation", async ({
  page,
}) => {
  massWorld(2, { 1: 5001, 2: 5002 });
  await signIn(page);
  const deck = await deckWith(page, []);
  await put(page, deck.id, await massEdition(1), 4);
  await put(page, deck.id, await massEdition(2), 2);
  await openBuilder(page, deck);
  const dialog = await openExport(page, "TCGplayer Mass Entry");
  const region = dialog.getByRole("region", {
    name: "TCGplayer export",
    exact: true,
  });
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText("Every card has a verified TCGplayer");
  await region.getByRole("button", { name: "Open in TCGplayer" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Before you open TCGplayer",
  });
  await expect(confirmation).toContainText("Nothing is purchased");
  await page.keyboard.press("Escape");
  await expect(confirmation).toHaveCount(0);
  await expect(dialog).toBeVisible();

  await region.getByRole("button", { name: "Open in TCGplayer" }).click();
  const link = page.getByRole("link", { name: "Continue to TCGplayer" });
  await expect(link).toHaveAttribute("href", TCGPLAYER + "4-5001%7C%7C2-5002");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
});

// --- Estimated Deck Cost -----------------------------------------------------------------------------

test("an open Deck's banner shows its cost and coverage and links to the deck builder, and other views show no Deck banner", async ({
  page,
}) => {
  const ids = priceWorld();
  await signIn(page);
  const deck = await deckWith(page, [
    [ids.normal, 3],
    [ids["reverse-holofoil"], 2],
    [ids.unspecified, 1],
  ]);
  const leaf = `Shelf ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name: leaf,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const requested: string[] = [];
  await page.route("**/api/decks/*/cost", async (route) => {
    requested.push(route.request().url());
    await route.continue();
  });

  await openInWorkspace(page, leaf);
  await expect(costOf(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Locations" })
    .getByRole("button", { name: deck.name, exact: true })
    .click();
  await expect(heading(page)).toHaveText(deck.name);
  const cost = costOf(page);
  await expect(cost).toContainText("$1.61 · 5/6 cards priced");
  await expect(cost).toContainText(
    "Incomplete subtotal: 1 card without a price"
  );
  await expect(cost).toContainText("2 stale cards (price over 48 hours old)");
  await expect(cost).toContainText("0 cards with unknown price age");
  await expect(cost).toContainText("Excludes shipping and taxes");
  await expect(cost).not.toContainText("$0.00");
  await expect(banner(page)).toContainText(
    "$1.61 deck (5/6 priced) · $0.00 to complete"
  );
  await expect(
    banner(page).getByRole("link", { name: "Open in the deck builder" })
  ).toHaveAttribute("href", `/decks/${deck.id}`);
  // Exports live on Decks (#181).
  await expect(exportButton(page)).toHaveCount(0);
  await expect(page.getByText("6 copies · 3 editions")).toBeVisible();
  expect(requested).toHaveLength(1);

  await page
    .getByRole("navigation", { name: "Locations" })
    .getByRole("button", { name: "All owned", exact: true })
    .click();
  await expect(heading(page)).toHaveText("All owned");
  await expect(costOf(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
});

test("the cost comes from the complete Deck read even when the gallery's tiles fail to load", async ({
  page,
}) => {
  const ids = priceWorld();
  await signIn(page);
  const deck = await deckWith(page, [
    [ids.normal, 3],
    [ids["reverse-holofoil"], 2],
    [ids.unspecified, 1],
  ]);
  await page.route(/\/api\/collection\/holdings(\?|$)/, (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: { code: "UNAVAILABLE" } }),
    })
  );
  await openInWorkspace(page, deck.name);
  await expect(
    page.getByText("Cards are temporarily unavailable.")
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Cards" }).getByRole("button", {
      name: /Furret/,
    })
  ).toHaveCount(0);
  await expect(costOf(page)).toContainText("$1.61 · 5/6 cards priced");
  await expect(costOf(page)).toContainText("2 stale cards");
});

test("a cost for a newer inventory revision re-reads the Deck and prices the new contents", async ({
  page,
}) => {
  const ids = priceWorld();
  await signIn(page);
  const deck = await deckWith(page, [[ids.normal, 3]]);
  const user = await owner();
  let held = true;
  let resume: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => (resume = resolve));
  const seen: string[] = [];
  await page.route("**/api/decks/*/cost", async (route) => {
    seen.push(route.request().url());
    if (held) {
      held = false;
      await paused;
    }
    await route.continue().catch(() => undefined);
  });
  await openInWorkspace(page, deck.name);
  await expect.poll(() => seen.length).toBe(1);
  await expect(costOf(page)).toContainText("Checking prices…");
  // The gallery's first page has arrived at the old revision, so only the cost answer can name the new one.
  await expect(page.getByText("3 copies · 1 edition")).toBeVisible();
  // The Deck changes while its first cost request is held; that answer names the newer revision.
  await pool.query(
    "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,2,1)",
    [user, deck.id, ids["reverse-holofoil"]]
  );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
  resume();
  await expect(costOf(page)).toContainText("$1.61 · 5/5 cards priced");
  await expect(costOf(page)).toContainText("2 stale cards");
  expect(seen).toHaveLength(2);
});

// --- Pokémon TCG Live --------------------------------------------------------------------------------

test("the Export dialog works from the keyboard and the Live export shows the complete text with its warnings", async ({
  page,
}) => {
  const world = liveWorld(MIXED);
  await signIn(page);
  const deck = await deckWith(page, [
    [world.mon.editions[0], 2],
    [world.mon.editions[1], 1],
    [world.promo.editions[0], 2],
    [world.trainer.editions[0], 4],
    [world.basic.editions[0], 9],
  ]);
  await openBuilder(page, deck);
  const button = exportButton(page);
  await button.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Export" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "Pokémon TCG Live" })
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();

  // Opened again (a press right after a close can race the closing dialog; see #181's brief), the Live export
  // runs from the keyboard.
  await button.click();
  await expect(dialog).toBeVisible();
  const live = dialog.getByRole("region", { name: "Pokémon TCG Live export" });
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  const output = live.getByRole("region", { name: "Live export", exact: true });
  await expect(output.getByLabel("Live export text")).toHaveText(MIXED_TEXT);
  await expect(output).toContainText("This Deck has 18 cards, not 60.");
  await expect(output).toContainText("Basic deck checks only.");
  await dialog.getByRole("button", { name: "Close export" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("a blocked Live export lists every blocker and offers no text, on a phone opened from the deck builder", async ({
  page,
}) => {
  const world = liveWorld([
    ...MIXED.slice(0, 3),
    {
      key: "alt",
      name: "Alt Art Card",
      number: "TG01",
      category: "Pokemon",
      set_name: "Trainer Gallery",
    },
    {
      key: "sus",
      name: "Furret",
      number: "136",
      category: "Pokemon",
      live: "suspended",
    },
  ]);
  await signIn(page);
  const deck = await deckWith(page, [
    [world.mon.editions[0], 1],
    [world.alt.editions[0], 2],
    [world.sus.editions[0], 3],
  ]);
  await page.setViewportSize({ width: 375, height: 812 });
  await openBuilder(page, deck);
  await expectTouchTarget(exportButton(page), ["height"]);
  const dialog = await openExport(page, "Pokémon TCG Live");
  // Full screen on a phone.
  const sheet = await dialog.boundingBox();
  expect(sheet!.x).toBeLessThanOrEqual(1);
  expect(sheet!.width).toBeGreaterThanOrEqual(370);
  const live = dialog.getByRole("region", { name: "Pokémon TCG Live export" });
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  const blockers = live.getByRole("region", { name: "Live export blockers" });
  await expect(blockers.getByRole("listitem")).toHaveCount(2);
  await expect(blockers).toContainText(
    "Alt Art Card · Trainer Gallery #TG01 · ×2"
  );
  await expect(blockers).toContainText(
    "Furret · Seed Set #136 · ×3 · source_changed"
  );
  await expect(live.getByRole("button", { name: "Copy for Live" })).toHaveCount(
    0
  );
  await expect(live.getByLabel("Live export text")).toHaveCount(0);
});

// --- No seed -----------------------------------------------------------------------------------------

test("a failed Deck read offers Retry, and an empty Deck is $0.00, with an Export that says No cards", async ({
  page,
}) => {
  await signIn(page);
  const deck = await deckWith(page, []);
  await page.route("**/api/decks/*", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ detail: { code: "UNAVAILABLE" } }),
        })
      : route.continue()
  );
  await openInWorkspace(page, deck.name);
  const alert = page.getByRole("alert").filter({
    hasText: "Deck cost is temporarily unavailable.",
  });
  await expect(alert).toBeVisible();
  await page.unroute("**/api/decks/*");
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(alert).toHaveCount(0);
  await expect(costOf(page)).toContainText("$0.00 · No cards");
  await expect(exportButton(page)).toHaveCount(0);

  // The deck builder's Export opens on an empty Deck List and says so.
  await openBuilder(page, deck);
  const dialog = await openExport(page, "Pokémon TCG Live");
  await expect(
    dialog.getByRole("region", { name: "Live export", exact: true })
  ).toContainText("No cards");
});

test("a Collection link opens that Deck once, under a banner that links to the deck builder", async ({
  page,
}) => {
  await signIn(page);
  const first = await deckWith(page, [], "0 Link");
  const second = await deckWith(page, [], "0 Link");
  await page.goto(`${ORIGIN}/collection?location=${second.id}`);
  await expect(heading(page)).toHaveText(second.name);
  await expect(page).toHaveURL(/\/collection$/);
  await expect(
    page
      .getByRole("navigation", { name: "Locations" })
      .getByRole("button", { name: second.name, exact: true })
  ).toHaveAttribute("aria-current", "page");
  await expect(costOf(page)).toContainText("$0.00 · No cards");
  const link = banner(page).getByRole("link", {
    name: "Open in the deck builder",
  });
  await expect(link).toHaveAttribute("href", `/decks/${second.id}`);

  // The link is used once: a reload opens All owned, and an unknown id falls back to All owned.
  await page.reload();
  await expect(heading(page)).toHaveText("All owned");
  await page.goto(`${ORIGIN}/collection?location=${randomUUID()}`);
  await expect(page).toHaveURL(/\/collection$/);
  await expect(heading(page)).toHaveText("All owned");
  await expect(costOf(page)).toHaveCount(0);

  // The banner's link opens the Deck in the deck builder, inside the app.
  await openInWorkspace(page, first.name);
  await banner(page)
    .getByRole("link", { name: "Open in the deck builder" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/decks/${first.id}`);
  await expect(heading(page)).toHaveText(first.name);
});

test("Escape and the backdrop close an export and return focus to Export", async ({
  page,
}) => {
  massWorld(2, { 1: 5001, 2: 5002 });
  await signIn(page);
  const deck = await deckWith(page, []);
  await put(page, deck.id, await massEdition(1), 2);
  await openBuilder(page, deck);
  const dialog = await openExport(page, "TCGplayer Mass Entry");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(exportButton(page)).toBeFocused();

  await openExport(page, "TCGplayer Mass Entry");
  const box = (await dialog.boundingBox())!;
  // Just outside the dialog box, inside the viewport.
  await page.mouse.click(Math.max(1, box.x / 2), Math.max(1, box.y / 2));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(exportButton(page)).toBeFocused();
});

test("a link to a folder opens All owned, and a link to its child Deck opens the Deck with the folder expanded", async ({
  page,
}) => {
  await signIn(page);
  const folderName = `Folder ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name: folderName,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const folderId = (await created.json()).location.id as string;
  const deck = await deckWith(page, [], "Child");
  await pool.query("UPDATE location SET parent_id=$1 WHERE id=$2", [
    folderId,
    deck.id,
  ]);
  await pool.query("UPDATE location SET kind='organization' WHERE id=$1", [
    folderId,
  ]);

  await page.goto(`${ORIGIN}/collection?location=${folderId}`);
  await expect(heading(page)).toHaveText("All owned");
  await expect(page).toHaveURL(/\/collection$/);

  await page.goto(`${ORIGIN}/collection?location=${deck.id}`);
  await expect(heading(page)).toHaveText(deck.name);
  const nav = page.getByRole("navigation", { name: "Locations" });
  await expect(
    nav.getByRole("button", { name: deck.name, exact: true })
  ).toHaveAttribute("aria-current", "page");
  await expect(
    nav.getByRole("button", { name: folderName, exact: true })
  ).toHaveAttribute("aria-expanded", "true");
});
