import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listHoldings } from "./support/deck-list";

function messages(path: string): string[] {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

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
    const holdings = page.getByRole("region", {
      name: `Cards in ${privateName}`,
    });
    await holdings
      .getByRole("button", { name: "Add cards", exact: true })
      .click();
    await holdings.getByLabel("Search English card name").fill("Pika");
    await holdings.getByRole("button", { name: "Search", exact: true }).click();
    await holdings
      .getByLabel("Card Edition")
      .selectOption({ label: "Pikachu · Fixture Set #1 · finish: normal" });
    await holdings.getByLabel("Quantity", { exact: true }).fill("59");
    await holdings
      .getByRole("button", { name: "Add to Location", exact: true })
      .click();
    // Publishing freezes the Deck List; list the cards just added.
    await listHoldings(pool, privateName, 59);
    const publishing = page.getByRole("region", {
      name: "Publish Deck",
      exact: true,
    });
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
    await expect(publicPage.getByRole("main")).toContainText(
      "59 cards · 1 cards short of 60"
    );
    await expect(publicPage.getByRole("main")).not.toContainText(privateName);
    await expect(publicPage.getByLabel("Email")).toHaveCount(0);
    await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute(
      "content",
      "noindex, nofollow"
    );
    await publicPage.getByText("Pikachu · 59 copies", { exact: true }).click();
    await expect(
      publicPage.getByRole("region", { name: "Published cards" })
    ).toContainText("Fixture Set");
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
      "collector_number",
      "edition_ref",
      "image_url",
      "printing_name",
      "printing_ref",
      "quantity",
      "set_id",
      "set_name",
      "variant",
    ]);
    expect(
      (
        await anonymous.request.get(
          `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/catalog/status`
        )
      ).status()
    ).toBe(401);
    await holdings
      .getByRole("button", { name: "Add cards", exact: true })
      .click();
    await holdings.getByLabel("Search English card name").fill("Pika");
    await holdings.getByRole("button", { name: "Search", exact: true }).click();
    await holdings
      .getByLabel("Card Edition")
      .selectOption({ label: "Pikachu · Fixture Set #1 · finish: normal" });
    await holdings.getByLabel("Quantity", { exact: true }).fill("2");
    await holdings
      .getByRole("button", { name: "Add to Location", exact: true })
      .click();
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
    await expect(publishing).toContainText("Snapshot version 2");
    await publicPage.reload();
    await expect(publicPage.getByRole("main")).toContainText(
      "61 cards · 1 cards over 60"
    );
    const republished = await anonymous.request.get(
      `${process.env.TEST_ORIGIN || "http://localhost:5173"}/api/public/decks/${token}`
    );
    const newReference = (await republished.json()).identities[0].editions[0];
    expect(newReference.edition_ref).toBe(reference.edition_ref);
    expect(newReference.printing_ref).toBe(reference.printing_ref);
    expect(newReference.quantity).toBe("61");
    await publishing
      .getByRole("button", { name: "Revoke public link", exact: true })
      .click();
    await expect(publishing.getByRole("status")).toContainText(
      "revoked permanently"
    );
    await publicPage.reload();
    await expect(publicPage.getByRole("status")).toContainText(
      "Published Deck not found."
    );
    await publishing.getByLabel("Public title").fill("New friends");
    await publishing
      .getByRole("button", { name: "Publish Unlisted snapshot", exact: true })
      .click();
    await expect(link).toBeVisible();
    await expect(link).not.toHaveAttribute("href", firstUrl);
    await publicPage.reload();
    await expect(publicPage.getByRole("status")).toContainText(
      "Published Deck not found."
    );
  } finally {
    await anonymous.close();
    await pool.end();
  }
});
