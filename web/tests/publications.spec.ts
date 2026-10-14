import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";
import { exemptNamedDeck, showAsLegal } from "./support/publish-gate";

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

/** Stores `quantity` copies of the catalog's one Pikachu Edition in the Deck through the gateway. */
async function addToDeck(page: Page, deckId: string, quantity: number) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let edition: string;
  try {
    edition = (
      await pool.query(
        `SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
         WHERE p.source_id='card-1' ORDER BY e.descriptor->>'finish'='normal' DESC LIMIT 1`
      )
    ).rows[0].id;
  } finally {
    await pool.end();
  }
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

/** The deck builder's Publish dialog, titled "Publish" before publishing and "Published Deck" after. */
const publishDialog = (page: Page) =>
  page.getByRole("dialog", { name: /^(Publish|Published Deck)$/ });

test("Unlisted snapshot is anonymous, escaped, intentional, and permanently revocable", async ({
  page,
  browser,
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
  const anonymous = await browser.newContext();
  const publicPage = await anonymous.newPage();
  try {
    await pool.query("DELETE FROM auth_send_event");
    const mail = process.env.MAIL_FILE || "/tmp/tcg-ticket01-mail";
    const before = messages(mail).length;
    await page.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/locations`
    );
    await expect(page).toHaveURL(/\/collection(\?|$)/);
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
    const privateName = `Private ${randomUUID().slice(0, 8)}`;
    await page.getByLabel("Deck name").fill(privateName);
    await page
      .getByRole("button", { name: "Create Deck", exact: true })
      .click();
    // The deck builder has no Holdings panel (#181): cards reach the Deck through the gateway, as Collection adds them.
    await expect(page).toHaveURL(/\/decks\/[^/?#]+$/);
    const deckId = page.url().split("/").at(-1)!;
    await addToDeck(page, deckId, 59);
    // Publishing freezes the Deck List; list the cards just added.
    await listHoldings(pool, privateName, 59);
    await exemptNamedDeck(pool, privateName); // not a legal Deck List in any Format
    // Publish waits for a legal result; the exempt Deck is shown to the page as legal (support/publish-gate.ts).
    await showAsLegal(page, deckId);
    await page.reload();
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    const publishing = publishDialog(page);
    await publishing.getByLabel("Public title").fill("Friends & rivals");
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .click();
    const link = publishing.getByRole("link", { name: "View public snapshot" });
    await expect(link).toBeVisible();
    const firstUrl = (await link.getAttribute("href"))!;
    await publicPage.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}${firstUrl}`
    );
    await expect(
      publicPage.getByRole("heading", { name: "Friends & rivals", exact: true })
    ).toBeVisible();
    await expect(publicPage.getByRole("main")).toContainText("59 cards");
    await expect(publicPage.getByRole("main")).not.toContainText(privateName);
    await expect(publicPage.getByLabel("Email")).toHaveCount(0);
    await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow"
    );
    // Signed in, the owner reads the same Published Deck inside the shell (#163).
    const ownerView = await page.context().newPage();
    await ownerView.goto(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}${firstUrl}`
    );
    await expect(
      ownerView.getByRole("heading", { name: "Friends & rivals", exact: true })
    ).toBeVisible();
    await expect(
      ownerView.getByRole("navigation", { name: "Main views" })
    ).toBeVisible();
    await expect(
      ownerView.getByRole("navigation", { name: "Public pages" })
    ).toHaveCount(0);
    await ownerView.close();
    // The read-only deck panel (#183): the List line, then the card popup with its Edition.
    const publicList = publicPage.getByRole("region", { name: "Deck List" });
    await publicPage
      .getByRole("radiogroup", { name: "Deck List view" })
      .getByRole("radio", { name: "List" })
      .click();
    const pikachu = publicList
      .getByRole("listitem")
      .filter({ hasText: "Pikachu" });
    await expect(pikachu).toContainText("59");
    await pikachu.getByRole("button").click();
    await expect(
      publicPage.getByRole("dialog", { name: "Pikachu" })
    ).toContainText("Fixture Set");
    await publicPage.keyboard.press("Escape");
    const token = firstUrl.split("/").at(-1)!;
    const snapshotResponse = await anonymous.request.get(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/public/decks/${token}`
    );
    expect(snapshotResponse.headers()["cache-control"]).toContain("no-store");
    expect(snapshotResponse.headers()["x-robots-tag"]).toBe(
      "noindex, nofollow"
    );
    const frozen = await snapshotResponse.json();
    const reference = frozen.identities[0].editions[0];
    expect(reference.edition_ref).toMatch(/^[0-9a-f]{48}$/);
    expect(reference.printing_ref).toMatch(/^[0-9a-f]{48}$/);
    expect(reference.edition_ref).not.toBe(reference.printing_ref);
    expect(reference.printing_name).toBe("Pikachu");
    expect(Object.keys(reference).sort()).toEqual([
      "card_kind",
      "collector_number",
      "edition_ref",
      "evolution_root",
      "evolution_stage",
      "evolves_from",
      "image_url",
      "printing_name",
      "printing_ref",
      "quantity",
      "set_id",
      "set_name",
      "trainer_type",
      "variant",
    ]);
    expect(
      (
        await anonymous.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/catalog/status`
        )
      ).status()
    ).toBe(401);
    await addToDeck(page, deckId, 2);
    await listHoldings(pool, privateName, 61);
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText("59 cards");
    const stillFrozen = await anonymous.request.get(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/public/decks/${token}`
    );
    expect(await stillFrozen.json()).toEqual(frozen);
    await publishing
      .getByRole("button", { name: "Republish snapshot", exact: true })
      .click();
    await expect(publishing).toContainText(
      "Friends & rivals · Unlisted · version 2"
    );
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText("61 cards");
    const republished = await anonymous.request.get(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/public/decks/${token}`
    );
    const newReference = (await republished.json()).identities[0].editions[0];
    expect(newReference.edition_ref).toBe(reference.edition_ref);
    expect(newReference.printing_ref).toBe(reference.printing_ref);
    expect(newReference.quantity).toBe("61");
    await publishing
      .getByRole("button", { name: "Revoke: Friends & rivals", exact: true })
      .click();
    await publishing
      .getByRole("button", { name: "Revoke for good", exact: true })
      .click();
    await expect(publishing).toContainText("revoked permanently");
    await publicPage.reload();
    await expect(
      publicPage.getByRole("heading", {
        level: 1,
        name: "This deck isn't published anymore",
      })
    ).toBeVisible();
    await publishing.getByLabel("Public title").fill("New friends");
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .click();
    await expect(link).toBeVisible();
    await expect(link).not.toHaveAttribute("href", firstUrl);
    await publicPage.reload();
    await expect(
      publicPage.getByRole("heading", {
        level: 1,
        name: "This deck isn't published anymore",
      })
    ).toBeVisible();
  } finally {
    await anonymous.close();
    await pool.end();
  }
});
