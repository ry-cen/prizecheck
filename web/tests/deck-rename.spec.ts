import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { startAsNewOwner } from "./support/owner";

// Rename on the deck builder (#291). No catalog is needed: the Decks are created through the gateway.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

async function signIn(page: Page) {
  // Card artwork never reaches the network.
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("DELETE FROM auth_send_event");
    await startAsNewOwner(pool);
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/collection");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
}

async function createDeck(page: Page, name: string): Promise<string> {
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  return (await created.json()).location.id as string;
}

async function readDeck(page: Page, deckId: string) {
  const response = await page.request.get(`${ORIGIN}/api/decks/${deckId}`);
  expect(response.status()).toBe(200);
  return (await response.json()).deck as { name: string; version: number };
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const renameButton = (page: Page) =>
  page.getByRole("button", { name: "Rename", exact: true });
const field = (page: Page) => page.getByRole("textbox", { name: "Deck name" });
const suffix = () => randomUUID().slice(0, 6);

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Rename turns the title into a field: Enter saves, Escape and Cancel keep the name, and focus returns to Rename", async ({
    page,
  }) => {
    await signIn(page);
    const before = `Before ${suffix()}`;
    const after = `After ${suffix()}`;
    const deckId = await createDeck(page, before);
    await page.goto(`${ORIGIN}/decks/${deckId}`);
    await expect(heading(page)).toHaveText(before);

    await renameButton(page).click();
    await expect(field(page)).toBeFocused();
    await expect(field(page)).toHaveValue(before);
    await expectPageChecks(page, "deck builder, renaming");
    await field(page).fill("x");
    await page.keyboard.press("Escape");
    await expect(heading(page)).toHaveText(before);
    await expect(renameButton(page)).toBeFocused();

    await renameButton(page).click();
    await field(page).fill("x");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(heading(page)).toHaveText(before);
    await expect(renameButton(page)).toBeFocused();

    await renameButton(page).click();
    await field(page).fill(after);
    // After a rename the page reads the Deck again, so Export sees the owner revision the rename moved.
    const reread = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/decks/${deckId}`
    );
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText(after);
    expect((await reread).status()).toBe(200);
    await expect(renameButton(page)).toBeFocused();
    await expect(
      page.getByRole("status").filter({ hasText: "Renamed the Deck to" })
    ).toHaveText(`Renamed the Deck to ${after}.`);
    await expect
      .poll(async () => (await readDeck(page, deckId)).name)
      .toBe(after);

    await page.getByRole("link", { name: "All Decks" }).click();
    await expect(
      page
        .getByRole("navigation", { name: "Deck index" })
        .getByRole("link", { name: after, exact: true })
    ).toBeVisible();
  });

  test("Rename shows duplicate, empty and too-long names next to the field and recovers from a stale Deck", async ({
    page,
  }) => {
    await signIn(page);
    const alpha = `Alpha ${suffix()}`;
    const beta = `Beta ${suffix()}`;
    const moved = `Moved ${suffix()}`;
    const gamma = `Gamma ${suffix()}`;
    await createDeck(page, alpha);
    const deckId = await createDeck(page, beta);
    await page.goto(`${ORIGIN}/decks/${deckId}`);
    await expect(heading(page)).toHaveText(beta);

    await renameButton(page).click();
    await field(page).fill(alpha);
    await page.keyboard.press("Enter");
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText(
      "That name is already taken. Choose a different Deck name."
    );
    await expect(field(page)).toHaveAttribute("aria-invalid", "true");
    await expect(field(page)).toHaveAccessibleDescription(
      "That name is already taken. Choose a different Deck name."
    );

    await field(page).fill("   ");
    await page.keyboard.press("Enter");
    await expect(alert).toHaveText("Enter a name for the Deck.");
    await field(page).fill("x".repeat(121));
    await page.keyboard.press("Enter");
    await expect(alert).toHaveText("Deck names can be up to 120 characters.");

    const current = await readDeck(page, deckId);
    const behind = await page.request.patch(`${ORIGIN}/api/decks/${deckId}`, {
      headers: { origin: ORIGIN },
      data: {
        name: moved,
        version: current.version,
        idempotency_key: randomUUID(),
      },
    });
    expect(behind.status()).toBe(200);

    await field(page).fill(gamma);
    await page.keyboard.press("Enter");
    await expect(alert).toHaveText(
      "This Deck changed somewhere else, so it wasn't renamed. It's up to date now: try again."
    );
    await expect(heading(page)).toHaveText(moved);
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText(gamma);
  });

  test("A rename retried after a failed request reuses its idempotency key", async ({
    page,
  }) => {
    await signIn(page);
    const before = `Retry ${suffix()}`;
    const after = `Retried ${suffix()}`;
    const deckId = await createDeck(page, before);
    const sent: { keys: string[]; bodies: string[][] } = {
      keys: [],
      bodies: [],
    };
    await page.route(`**/api/decks/${deckId}`, async (route) => {
      const request = route.request();
      if (request.method() !== "PATCH") return route.continue();
      const body = request.postDataJSON() as Record<string, string>;
      sent.keys.push(body.idempotency_key);
      sent.bodies.push(Object.keys(body).sort());
      if (sent.keys.length === 1) return route.abort();
      return route.continue();
    });
    await page.goto(`${ORIGIN}/decks/${deckId}`);

    await renameButton(page).click();
    await field(page).fill(after);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "The Deck couldn't be renamed. Check your connection and try again."
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(heading(page)).toHaveText(after);
    expect(sent.keys).toHaveLength(2);
    expect(sent.keys[0]).toBe(sent.keys[1]);
    expect(sent.bodies[1]).toEqual(["idempotency_key", "name", "version"]);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("On a phone Rename, Save and Cancel are 44 px and nothing scrolls sideways", async ({
    page,
  }) => {
    await signIn(page);
    const deckId = await createDeck(page, `Phone ${suffix()}`);
    await page.goto(`${ORIGIN}/decks/${deckId}`);
    await expectTouchTarget(renameButton(page));
    await renameButton(page).tap();
    await expectTouchTarget(
      page.getByRole("button", { name: "Save", exact: true })
    );
    await expectTouchTarget(
      page.getByRole("button", { name: "Cancel", exact: true })
    );
    await expectPageChecks(page, "deck builder, renaming, phone");
  });
});
