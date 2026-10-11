import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
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
    const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
    const before = messages(mail).length;
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
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
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    const name = `Deck ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Deck name").fill(name);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    const checks = page.getByRole("region", { name: `Checks for ${name}` });
    await expect(checks).toContainText("0 cards · 60 cards short of 60");
    await expect(checks).toContainText(
      "Basic deck checks only. Format legality, including rotation and banned cards, is reported by the advisory format checks."
    );
    const holdings = page.getByRole("region", { name: `Cards in ${name}` });
    await holdings
      .getByRole("button", { name: "Add cards", exact: true })
      .click();
    await holdings.getByLabel("Search English card name").fill("Pika");
    await holdings.getByRole("button", { name: "Search", exact: true }).click();
    await holdings
      .getByLabel("Card Edition")
      .selectOption({ label: "Pikachu · Fixture Set #1 · finish: normal" });
    await holdings.getByLabel("Quantity", { exact: true }).fill("61");
    await holdings
      .getByRole("button", { name: "Add to Location", exact: true })
      .click();
    await expect(checks).toContainText("61 cards · 1 cards over 60");
    await expect(checks).toContainText("Over four-copy limit");
    const move = holdings.getByRole("region", { name: "Move cards" });
    await move.getByRole("button", { name: "Fan copies", exact: true }).click();
    await move
      .getByRole("button", { name: "Select 2 Pikachu copies", exact: true })
      .click();
    await move
      .getByRole("button", { name: "Move selected", exact: true })
      .click();
    // Destinations are labelled by full path, so exact "Unsorted" is the top-level leaf, never "Box / Unsorted".
    await page
      .getByRole("dialog", { name: "Choose Move destination" })
      .getByRole("button", { name: "Unsorted", exact: true })
      .click();
    await expect(checks).toContainText("59 cards · 1 cards short of 60");
    await page
      .getByRole("link", { name: `Open in workspace: ${name}` })
      .click();
    await expect(page).toHaveURL(/\/workspace$/);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("59 copies · 1 edition");
    // "Open in workspace" is a full navigation, so go back through Main views rather than goBack().
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    await page
      .getByRole("navigation", { name: "Deck index" })
      .getByRole("button", { name, exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: `Checks for ${name}` })
    ).toBeVisible();
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

test("Deck Cards panel refreshes a stale selection, then Removes and Undoes", async ({
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
    const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
    const before = messages(mail).length;
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
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
    await page.getByRole("button", { name: "Decks", exact: true }).click();
    const name = `Deck ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Deck name").fill(name);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    const holdings = page.getByRole("region", { name: `Cards in ${name}` });
    await holdings
      .getByRole("button", { name: "Add cards", exact: true })
      .click();
    await holdings.getByLabel("Search English card name").fill("Pika");
    await holdings.getByRole("button", { name: "Search", exact: true }).click();
    await holdings
      .getByLabel("Card Edition")
      .selectOption({ label: "Pikachu · Fixture Set #1 · finish: normal" });
    await holdings.getByLabel("Quantity", { exact: true }).fill("3");
    await holdings
      .getByRole("button", { name: "Add to Location", exact: true })
      .click();
    const selection = holdings.getByRole("region", { name: "Move cards" });
    const stack = holdings.locator(".holding-stack");
    await expect(stack).toContainText("×3");

    // Another tab changes the Holding after it is selected, so Move reports it and keeps the selection.
    await selection
      .getByRole("button", { name: "Select stack", exact: true })
      .click();
    const row = await pool.query(
      `SELECT l.id AS location_id, h.edition_id FROM location l
       JOIN holding h ON h.location_id=l.id WHERE l.name=$1 LIMIT 1`,
      [name]
    );
    await pool.query(
      `WITH changed AS (
         UPDATE inventory_owner SET revision=revision+1
         WHERE user_id=(SELECT owner_id FROM location WHERE id=$1) RETURNING revision
       ) UPDATE holding SET quantity=quantity+1,version=(SELECT revision FROM changed)
         WHERE location_id=$1 AND edition_id=$2`,
      [row.rows[0].location_id, row.rows[0].edition_id]
    );
    await selection
      .getByRole("button", { name: "Move selected", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Choose Move destination" })
      .getByRole("button", { name: "Unsorted", exact: true })
      .click();
    await expect(selection.getByRole("status")).toContainText(
      "selection is saved"
    );
    await selection
      .getByRole("button", { name: "Refresh selection", exact: true })
      .click();
    await expect(selection.getByRole("status")).toContainText(
      "Editions refreshed"
    );
    await expect(selection).toContainText("3 copies · 1 Editions selected");
    await expect(stack).toContainText("×4");

    // Removal asks first; Cancel leaves the count alone. The refresh keeps the 3 selected copies of the 4 now held, so Confirm removes 3 and Undo restores them.
    await selection
      .getByRole("button", { name: "Remove selected", exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "Confirm Inventory Removal",
    });
    await expect(confirmation).toContainText(
      "Remove 3 copies from your tracked Collection?"
    );
    await confirmation.getByRole("button", { name: "Cancel removal" }).click();
    await expect(stack).toContainText("×4");
    await selection
      .getByRole("button", { name: "Remove selected", exact: true })
      .click();
    await confirmation.getByRole("button", { name: "Confirm removal" }).click();
    await expect(selection.getByRole("status")).toContainText(
      "Removed 3 copies"
    );
    await expect(stack).toContainText("×1");
    await selection
      .getByRole("button", { name: "Undo", exact: true })
      .first()
      .click();
    await expect(stack).toContainText("×4");
  } finally {
    await pool.end();
  }
});
