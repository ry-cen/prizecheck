import { test, expect, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { signInAsOwner } from "./support/sign-in";
import { openExport } from "./support/deck-builder";
import { listCards } from "./support/deck-list";
import { exemptFromPublishGate } from "./support/publish-gate";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

async function assertCopy(dialog: Locator, names: string[]) {
  const blockers = dialog.getByRole("region", { name: "Live export blockers" });
  await expect(blockers).toBeVisible();
  await expect(blockers.getByRole("listitem")).toHaveCount(names.length);
  for (const name of names) await expect(blockers).toContainText(name);
  await expect(blockers).toContainText("×2");
  await expect(blockers).toContainText("×3");
  await expect(blockers).toContainText(
    "Live export isn't available for the cards below. No export was created."
  );
  await expect(
    dialog.getByText(/rule_|_uncovered|reviewed Live data/)
  ).toHaveCount(0);
  await expect(blockers).toContainText("Basic deck checks only.");
  await expect(blockers).toContainText("advisory format checks");
  await expect(dialog.getByLabel("Live export text")).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Copy for Live", exact: true })
  ).toHaveCount(0);
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test(`blocked Live export uses collector copy on both pages, signed in and out (${viewport.width})`, async ({
    page,
    browser,
  }) => {
    await page.setViewportSize(viewport);
    await pool.query("DELETE FROM auth_send_event");
    await signInAsOwner(page, "/collection");
    const output = execFileSync(
      ".venv/bin/python",
      [
        "-c",
        `import json
from test_deck_live_export import seed_world
world, _ = seed_world([
    {"key": "a", "name": "Furret", "number": "136", "category": "Pokemon"},
    {"key": "b", "name": "Ultra Ball", "number": "196", "category": "Trainer"},
])
print("WORLD" + json.dumps(world))`,
      ],
      { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
    ).toString();
    const world = JSON.parse(output.slice(output.lastIndexOf("WORLD") + 5));
    const cards = [
      { id: world.a.editions[0], name: "Furret" },
      { id: world.b.editions[0], name: "Ultra Ball" },
    ];
    expect(cards).toHaveLength(2);
    const created = await page.request.post(`${ORIGIN}/api/decks`, {
      headers: { origin: ORIGIN },
      data: {
        name: `Live copy ${randomUUID()}`,
        idempotency_key: randomUUID(),
      },
    });
    expect(created.status()).toBe(201);
    const deck = (await created.json()).location;
    const owner = (
      await pool.query("SELECT owner_id FROM location WHERE id=$1", [deck.id])
    ).rows[0].owner_id;
    await listCards(pool, owner, deck.id, {
      [cards[0].id]: 2,
      [cards[1].id]: 3,
    });
    await page.goto(`${ORIGIN}/decks/${deck.id}`);
    const live = await openExport(page, "live");
    await live
      .getByRole("button", { name: "Export to Live", exact: true })
      .click();
    await assertCopy(
      page.getByRole("dialog", { name: "Export", exact: true }),
      cards.map((c) => c.name)
    );
    exemptFromPublishGate(deck.id);
    const published = await page.request.post(
      `${ORIGIN}/api/decks/${deck.id}/publication`,
      {
        headers: { origin: ORIGIN },
        data: { title: "Live copy", idempotency_key: randomUUID() },
      }
    );
    expect(published.status()).toBe(200);
    const { token } = await published.json();
    await page.goto(`${ORIGIN}/published/${token}`);
    await page
      .getByRole("button", { name: "Copy for TCG Live", exact: true })
      .click();
    await assertCopy(
      page.getByRole("dialog", { name: "Copy for TCG Live" }),
      cards.map((c) => c.name)
    );
    const anonymous = await browser.newContext({ viewport });
    try {
      const visitor = await anonymous.newPage();
      await visitor.goto(`${ORIGIN}/published/${token}`);
      await visitor
        .getByRole("button", { name: "Copy for TCG Live", exact: true })
        .click();
      await assertCopy(
        visitor.getByRole("dialog", { name: "Copy for TCG Live" }),
        cards.map((c) => c.name)
      );
    } finally {
      await anonymous.close();
    }
  });
}
