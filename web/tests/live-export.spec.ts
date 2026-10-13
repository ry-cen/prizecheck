import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { openDeckTools } from "./support/deck-builder";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Card = {
  key: string;
  name: string;
  number: string;
  category: string;
  live?: { name: string; set_code: string; number: string } | "suspended";
  finishes?: object[];
  set_name?: string;
};
type World = Record<string, { printing: string; editions: string[] }>;

/** Fixture catalog setup may use SQL: the shipped rule v1 is activated and Live identities are maintainer `correct` decisions. */
function seed(cards: Card[], bulk = false): World {
  const out = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json, sys
from test_deck_live_export import seed_world
spec = json.load(open(sys.argv[1]))
world, _ = seed_world(spec['cards'], bulk=spec['bulk'])
print('WORLD' + json.dumps(world))`,
      writeSpec({ cards, bulk }),
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }
  ).toString();
  return JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5));
}

function writeSpec(spec: object): string {
  const path = `${process.env.TMPDIR || "/tmp"}/live-export-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(spec));
  return path;
}

const lastOtp = () =>
  JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;

async function signIn(page: Page) {
  await pool.query("DELETE FROM auth_send_event");
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

const userId = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** Creates a Deck through the gateway and stores Holdings by SQL (editions: [edition id, quantity]). */
async function makeDeck(
  page: Page,
  quantities: [string, string][]
): Promise<{ id: string; name: string }> {
  const name = `Live ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).location.id as string;
  const owner = await userId();
  for (const [edition, quantity] of quantities)
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,$4,1)",
      [owner, id, edition, quantity]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [owner]
  );
  return { id, name };
}

async function openDeck(page: Page, name: string) {
  await page.getByRole("button", { name: "Decks", exact: true }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await openDeckTools(page);
  await expect(
    page.getByRole("region", { name: `Checks for ${name}` })
  ).toBeVisible();
  return page.getByRole("region", { name: "Pokémon TCG Live export" });
}

/** Replace the clipboard: writeText records its argument and either waits for release() or rejects. */
async function stubClipboard(page: Page, mode: "defer" | "reject") {
  await page.addInitScript((m) => {
    const state = { texts: [] as string[], release: () => {} };
    (window as unknown as { __clip: typeof state }).__clip = state;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          state.texts.push(text);
          if (m === "reject") return Promise.reject(new Error("denied"));
          return new Promise<void>((resolve) => {
            state.release = resolve;
          });
        },
      },
    });
  }, mode);
}

const MIXED: Card[] = [
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
const mixedQuantities = (world: World): [string, string][] => [
  [world.mon.editions[0], "2"],
  [world.mon.editions[1], "1"],
  [world.promo.editions[0], "2"],
  [world.trainer.editions[0], "4"],
  [world.basic.editions[0], "9"],
];

test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

test("Copy reports success only after the clipboard write resolves, with exact text and non-60 warnings", async ({
  page,
}) => {
  const world = seed(MIXED);
  await stubClipboard(page, "defer");
  await signIn(page);
  const deck = await makeDeck(page, mixedQuantities(world));
  const live = await openDeck(page, deck.name);
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  const output = live.getByRole("region", { name: "Live export", exact: true });
  await expect(output.getByLabel("Live export text")).toHaveText(MIXED_TEXT);
  await expect(output).toContainText("This Deck has 18 cards, not 60.");
  await expect(output).toContainText("Basic deck checks only.");
  // The disclaimer points to format checks; the export itself never claims a card or deck is legal.
  await expect(output).not.toContainText(/\blegal\b/i);
  await output.getByRole("button", { name: "Copy for Live" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__clip.texts.length))
    .toBe(1);
  expect(
    await page.evaluate(() => (window as any).__clip.texts[0] as string)
  ).toBe(MIXED_TEXT);
  await expect(output.getByRole("status")).not.toContainText("Copied");
  await page.evaluate(() => (window as any).__clip.release());
  await expect(output.getByRole("status")).toContainText("Copied to clipboard");
});

test("a denied clipboard shows the failure and the complete selectable text", async ({
  page,
}) => {
  const world = seed(MIXED);
  await stubClipboard(page, "reject");
  await signIn(page);
  const deck = await makeDeck(page, mixedQuantities(world));
  const live = await openDeck(page, deck.name);
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  const output = live.getByRole("region", { name: "Live export", exact: true });
  await output.getByRole("button", { name: "Copy for Live" }).click();
  await expect(output.getByRole("status")).toContainText("Copy failed");
  await expect(output.getByRole("status")).not.toContainText("Copied");
  const area = output.getByRole("textbox", { name: "Live export text" });
  await expect(area).toHaveValue(MIXED_TEXT);
});

test("blocked Decks list every blocker and offer no text", async ({ page }) => {
  const world = seed([
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
  const deck = await makeDeck(page, [
    [world.mon.editions[0], "1"],
    [world.alt.editions[0], "2"],
    [world.sus.editions[0], "3"],
  ]);
  const live = await openDeck(page, deck.name);
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

test("an empty Deck disables the export with No cards", async ({ page }) => {
  seed(MIXED);
  await signIn(page);
  const deck = await makeDeck(page, []);
  await openDeck(page, deck.name);
  const output = page.getByRole("region", { name: "Live export", exact: true });
  await expect(output).toContainText("No cards");
  await expect(
    output.getByRole("button", { name: "Copy for Live" })
  ).toBeDisabled();
});

test("every Edition is exported across Holdings pages", async ({ page }) => {
  const cards: Card[] = Array.from({ length: 52 }, (_, index) => ({
    key: `c${index}`,
    name: `Card ${String(index).padStart(2, "0")}`,
    number: String(index + 1),
    category: "Trainer",
    live: {
      name: `Card ${String(index).padStart(2, "0")}`,
      set_code: "TST",
      number: String(index + 1),
    },
  }));
  const world = seed(cards);
  await signIn(page);
  const deck = await makeDeck(
    page,
    cards.map((card, index) => [world[card.key].editions[0], String(index + 1)])
  );
  const live = await openDeck(page, deck.name);
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  const text = await live.getByLabel("Live export text").textContent();
  const lines = text!.split("\n");
  expect(lines).toHaveLength(53);
  expect(lines[0]).toBe(`Trainer: ${(52 * 53) / 2}`);
  expect(lines).toContain("52 Card 51 TST 52");
});

test("an inventory change discards the export", async ({ page }) => {
  const world = seed(MIXED);
  await signIn(page);
  const deck = await makeDeck(page, mixedQuantities(world));
  const live = await openDeck(page, deck.name);
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(live.getByLabel("Live export text")).toBeVisible();
  const added = await page.request.post(`${ORIGIN}/api/holdings`, {
    headers: { origin: ORIGIN },
    data: {
      location_id: deck.id,
      edition_id: world.trainer.editions[0],
      quantity: "1",
      idempotency_key: randomUUID(),
    },
  });
  expect(added.status()).toBe(200);
  await page.getByRole("button", { name: "Refresh checks" }).click();
  await expect(live.getByLabel("Live export text")).toHaveCount(0);
  await expect(live.getByRole("status")).toContainText(
    "Deck changed; export again"
  );
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(live.getByLabel("Live export text")).toContainText(
    "5 Ultra Ball SVI 196"
  );
});

test("an export that changed before it arrived is discarded", async ({
  page,
}) => {
  const world = seed(MIXED);
  await signIn(page);
  const deck = await makeDeck(page, mixedQuantities(world));
  const live = await openDeck(page, deck.name);
  // Let the page finish loading, then the server inventory moves on while the page keeps its old revision.
  await expect(page.getByText("Ultra Ball · Seed Set #196 · ×4")).toBeVisible();
  let addedStatus = 0;
  await page.route("**/api/decks/*/exports/live", async (route) => {
    const added = await page.request.post(`${ORIGIN}/api/holdings`, {
      headers: { origin: ORIGIN },
      data: {
        location_id: deck.id,
        edition_id: world.trainer.editions[0],
        quantity: "1",
        idempotency_key: randomUUID(),
      },
    });
    addedStatus = added.status();
    await route.continue();
  });
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(live.getByRole("status")).toContainText(
    "Deck changed; export again"
  );
  expect(addedStatus).toBe(200);
  await expect(live.getByLabel("Live export text")).toHaveCount(0);
});

// @slow (capacity): builds and downloads more than 256 KiB of export text (300 rows of ~1 KB names).
// A fresh ANALYZE keeps the planner current after the SQL bulk load.
test(
  "output beyond 256 KiB is not shown inline and downloads complete",
  { tag: "@slow" },
  async ({ page }) => {
    test.setTimeout(240_000);
    const long = "X".repeat(1000);
    const cards: Card[] = Array.from({ length: 300 }, (_, index) => {
      const name = `${long} ${String(index).padStart(4, "0")}`;
      return {
        key: `b${index}`,
        name,
        number: String(index + 1),
        category: "Trainer",
        live: { name, set_code: "BIG", number: String(index + 1) },
      };
    });
    const world = seed(cards, true);
    await signIn(page);
    const deck = await makeDeck(
      page,
      cards.map((card) => [world[card.key].editions[0], "1"])
    );
    // The fixture bulk-loads by SQL; give the planner current statistics, as a long-lived database would have.
    await pool.query("ANALYZE");
    const live = await openDeck(page, deck.name);
    await live
      .getByRole("button", { name: "Export to Live", exact: true })
      .click();
    await expect(live.getByLabel("Live export text")).toHaveCount(0);
    await expect(live).toContainText("too large to show here");
    const meta = await (
      await page.request.get(`${ORIGIN}/api/decks/${deck.id}/exports/live`)
    ).json();
    expect(meta.inline).toBe(false);
    expect(meta.byte_length).toBeGreaterThan(256 * 1024);
    const downloading = page.waitForEvent("download");
    await live.getByRole("link", { name: "Download Live export" }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("deck-live-export.txt");
    const path = await download.path();
    expect(statSync(path).size).toBe(meta.byte_length);
    const body = readFileSync(path, "utf8");
    expect(body.startsWith("Trainer: 300\n")).toBe(true);
    expect(body.split("\n")).toHaveLength(301);
  }
);
