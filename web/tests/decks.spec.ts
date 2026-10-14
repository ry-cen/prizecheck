import { test, expect } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

// The deck builder shows the Deck List and its format result; the Deck's Holdings, with Move, Remove and Undo, stay in
// Collection under the Deck's banner (#181). Cards reach the Deck through the gateway, as a collector adds them.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function addToDeck(
  page: import("@playwright/test").Page,
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

test("physical Deck creation, actual Holdings checks, and Move out", async ({
  page,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog_search import promote
promote({'card-1': 'Pikachu', **{f'card-{i}': f'Pikachu {i:02}' for i in range(2, 52)}})`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    const name = `Deck ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Deck name").fill(name);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
    const deckId = page.url().split("/").at(-1)!;
    const count = page.getByText(/^\d+\/60 cards$/);
    await expect(count).toHaveText("0/60 cards");
    const pikachu = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
         WHERE p.source_id='card-1' AND e.descriptor->>'finish'='normal'`
      )
    ).rows[0].id as string;
    // Copies stored in a Deck put it on its Deck List (migration 031): 61 copies, more than four of one card.
    await addToDeck(page, deckId, pikachu, 61);
    await page.reload();
    await expect(count).toHaveText("61/60 cards");
    await expect(
      page
        .getByRole("group", { name: "Target Format and result" })
        .getByRole("button", { name: /result$/ })
    ).toHaveText(/Not legal/);
    // Two copies move out to the top-level Unsorted (Collection's Move, through the gateway).
    const locationTree = await (
      await page.request.get(`${ORIGIN}/api/location-tree`)
    ).json();
    const unsortedId = locationTree.locations.find(
      (row: { name: string; parent_id: string | null }) =>
        row.name === "Unsorted" && row.parent_id === null
    ).id;
    const started = await page.request.post(`${ORIGIN}/api/moves/manifests`, {
      headers: { origin: ORIGIN },
      data: { source_id: deckId },
    });
    expect(started.status()).toBe(201);
    const held = (
      await (await page.request.get(`${ORIGIN}/api/holdings/${deckId}`)).json()
    ).holdings[0];
    const moving = (await started.json()).id as string;
    expect(
      (
        await page.request.put(
          `${ORIGIN}/api/moves/manifests/${moving}/items`,
          {
            headers: { origin: ORIGIN },
            data: {
              items: [
                {
                  edition_id: held.edition_id,
                  quantity: "2",
                  expected_version: held.version,
                },
              ],
            },
          }
        )
      ).status()
    ).toBe(200);
    expect(
      (
        await page.request.post(
          `${ORIGIN}/api/moves/manifests/${moving}/commit`,
          {
            headers: { origin: ORIGIN },
            data: { destination_id: unsortedId, idempotency_key: randomUUID() },
          }
        )
      ).status()
    ).toBe(200);
    // In Collection the Deck holds 59 under its banner, whose link opens the deck builder again.
    await page.goto(`${ORIGIN}/collection?location=${deckId}`);
    await expect(page).toHaveURL(/\/collection$/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("59 copies · 1 edition");
    await page
      .getByRole("region", { name: "Deck banner" })
      .getByRole("link", { name: "Open in the deck builder" })
      .click();
    await expect(page).toHaveURL(`${ORIGIN}/decks/${deckId}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    // Fixture catalog setup may use SQL; all inventory behavior uses the real gateway.
    const gateway = (path: string) => new URL(path, page.url()).toString();
    const deckResponse = await page.request.get(gateway("/api/decks"));
    const deck = (await deckResponse.json()).decks.find(
      (item: { name: string }) => item.name === name
    );
    const catalog = await pool.query(
      `SELECT e.id, p.source_id FROM catalog_edition e
       JOIN catalog_printing p ON p.id=e.printing_id
       WHERE e.descriptor->>'finish'='normal' ORDER BY p.source_id`
    );
    const firstEdition = catalog.rows.find(
      (row) => row.source_id === "card-1"
    ).id;
    for (const edition of catalog.rows.filter(
      (row) => row.source_id !== "card-1"
    )) {
      const added = await page.request.post(gateway("/api/holdings"), {
        headers: { origin: new URL(page.url()).origin },
        data: {
          location_id: deck.id,
          edition_id: edition.id,
          quantity: "1",
          idempotency_key: randomUUID(),
        },
      });
      expect(added.status()).toBe(200);
    }
    const firstPage = await (
      await page.request.get(gateway(`/api/holdings/${deck.id}`))
    ).json();
    expect(firstPage.holdings).toHaveLength(48);
    expect(firstPage.next_cursor).toBeTruthy();
    const contentsPath = gateway(`/api/decks/${deck.id}/contents`);
    const beforeResponse = await page.request.get(contentsPath);
    expect(beforeResponse.status()).toBe(200);
    const beforeContents = await beforeResponse.json();
    expect(beforeContents.editions).toHaveLength(51);
    expect(
      beforeContents.editions.find(
        (row: { edition_id: string }) => row.edition_id === firstEdition
      ).quantity
    ).toBe("59");
    const tree = await (
      await page.request.get(gateway("/api/location-tree"))
    ).json();
    const unsorted = tree.locations.find(
      (row: { name: string }) => row.name === "Unsorted"
    );
    const headers = { origin: new URL(page.url()).origin };
    const manifestResponse = await page.request.post(
      gateway("/api/moves/manifests"),
      {
        headers,
        data: { source_id: deck.id },
      }
    );
    expect(manifestResponse.status()).toBe(201);
    const manifest = await manifestResponse.json();
    const firstHolding = firstPage.holdings.find(
      (row: { edition_id: string }) => row.edition_id === firstEdition
    );
    const secondHolding = firstPage.holdings.find(
      (row: { edition_id: string }) => row.edition_id !== firstEdition
    );
    const staged = await page.request.put(
      gateway(`/api/moves/manifests/${manifest.id}/items`),
      {
        headers,
        data: {
          items: [firstHolding, secondHolding].map((holding) => ({
            edition_id: holding.edition_id,
            quantity: "1",
            expected_version: holding.version,
          })),
        },
      }
    );
    expect(staged.status()).toBe(200);
    // One atomic Move changes two Edition quantities, so any mixture is observable.
    const [duringResponse, mutation] = await Promise.all([
      page.request.get(contentsPath),
      page.request.post(gateway(`/api/moves/manifests/${manifest.id}/commit`), {
        headers,
        data: { destination_id: unsorted.id, idempotency_key: randomUUID() },
      }),
    ]);
    expect(mutation.status()).toBe(200);
    expect(duringResponse.status()).toBe(200);
    const afterContents = await (await page.request.get(contentsPath)).json();
    expect(afterContents.owner_revision).toBe(
      beforeContents.owner_revision + 1
    );
    expect(
      afterContents.editions.find(
        (row: { edition_id: string }) => row.edition_id === firstEdition
      ).quantity
    ).toBe("58");
    expect(afterContents.editions).toHaveLength(50);
    expect(
      afterContents.editions.some(
        (row: { edition_id: string }) =>
          row.edition_id === secondHolding.edition_id
      )
    ).toBe(false);
    const duringContents = await duringResponse.json();
    expect([
      beforeContents.owner_revision,
      afterContents.owner_revision,
    ]).toContain(duringContents.owner_revision);
    expect(duringContents).toEqual(
      duringContents.owner_revision === beforeContents.owner_revision
        ? beforeContents
        : afterContents
    );
    // Delay an authentic gateway response until a later inventory revision is known.
    let releaseResponse: () => void = () => {};
    let responseCaptured: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      responseCaptured = resolve;
    });
    await page.route(contentsPath, async (route) => {
      const response = await route.fetch();
      responseCaptured();
      await released;
      await route.fulfill({ response });
    });
    const staleRead = page.evaluate(
      async ({ deckId, initialRevision }) => {
        let currentRevision = initialRevision;
        Object.assign(globalThis, {
          advanceDeckRevision: () => {
            currentRevision += 1;
          },
        });
        const modulePath = "/src/decks_generated.ts";
        const { getDeckContents } = await import(modulePath);
        try {
          await getDeckContents(deckId, () => currentRevision);
          return "accepted";
        } catch (cause) {
          return cause instanceof Error ? cause.message : "unknown failure";
        }
      },
      { deckId: deck.id, initialRevision: afterContents.owner_revision }
    );
    await captured;
    try {
      const laterMutation = await page.request.post(gateway("/api/holdings"), {
        headers: { origin: new URL(page.url()).origin },
        data: {
          location_id: deck.id,
          edition_id: firstEdition,
          quantity: "1",
          idempotency_key: randomUUID(),
        },
      });
      expect(laterMutation.status()).toBe(200);
      await page.evaluate(() =>
        Reflect.get(globalThis, "advanceDeckRevision")()
      );
    } finally {
      releaseResponse();
    }
    expect(await staleRead).toBe("INVENTORY_CHANGED");
    await page.unroute(contentsPath);
    await page.evaluate(() =>
      Reflect.deleteProperty(globalThis, "advanceDeckRevision")
    );
  } finally {
    await pool.end();
  }
});

test("an open Deck in Collection keeps its Holdings with Move, Remove and Undo under its banner", async ({
  page,
}) => {
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
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    const name = `Deck ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Deck name").fill(name);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
    const deckId = page.url().split("/").at(-1)!;
    const pikachu = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
         WHERE p.source_id='card-1' AND e.descriptor->>'finish'='normal'`
      )
    ).rows[0].id as string;
    await addToDeck(page, deckId, pikachu, 3);
    await page.goto(`${ORIGIN}/collection?location=${deckId}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Deck banner" })
    ).toBeVisible();
    const cards = page.getByRole("region", { name: "Cards" });
    const tiles = cards.getByRole("button");
    const bar = page.getByRole("region", { name: "Selection" });
    const toast = page
      .getByRole("region", { name: "Notifications" })
      .getByRole("paragraph")
      .filter({ hasText: /Moved|Removed|Undo/ });
    await expect(tiles).toHaveCount(3);

    // Move one copy out to the top-level Unsorted, then Undo puts it back.
    await tiles.nth(0).click();
    await bar.getByRole("button", { name: "Actions" }).click();
    await bar.getByRole("button", { name: "Move…" }).click();
    const move = page.getByRole("dialog", { name: "Move 1 copy" });
    await move.getByRole("button", { name: "Unsorted", exact: true }).click();
    await move.getByRole("button", { name: "Move 1 copy" }).click();
    await expect(toast).toHaveText("Moved 1 copy to Unsorted.");
    await expect(tiles).toHaveCount(2);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast).toHaveText("Undo restored 1 copy to 1 location.");
    await expect(tiles).toHaveCount(3);

    // Removal asks first; Cancel leaves the copies. Confirming removes them, and Undo restores them.
    await tiles.nth(0).click();
    await tiles.nth(2).click({ modifiers: ["Shift"] });
    await expect(bar).toContainText("3 copies selected");
    await bar.getByRole("button", { name: "Actions" }).click();
    await bar.getByRole("button", { name: "Inventory Removal…" }).click();
    const removal = page.getByRole("dialog", {
      name: "Remove 3 copies from your Collection",
    });
    await removal.getByRole("button", { name: "Cancel" }).click();
    await expect(tiles).toHaveCount(3);
    await bar.getByRole("button", { name: "Actions" }).click();
    await bar.getByRole("button", { name: "Inventory Removal…" }).click();
    await removal.getByRole("button", { name: "Remove 3 copies" }).click();
    await expect(toast).toHaveText("Removed 3 copies from your Collection.");
    await expect(tiles).toHaveCount(0);
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(toast).toHaveText("Undo restored 3 copies to 1 location.");
    await expect(tiles).toHaveCount(3);
    await expect(page.getByRole("main")).toContainText("3 copies · 1 edition");
  } finally {
    await pool.end();
  }
});
