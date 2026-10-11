import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { listCards } from "./support/deck-list";

// Ticket 14: a Published Deck's TCGplayer Mass Entry export, read by an anonymous visitor against the real stack.
// Real TCGplayer is never contacted.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const BASE = "https://www.tcgplayer.com/massentry?productline=Pokemon&c=";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Ids = {
  normal: string;
  "reverse-holofoil": string;
  unspecified: string;
};
const python = (code: string, argument: unknown) => {
  const path = `${process.env.TMPDIR || "/tmp"}/published-mass-entry-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
};
function seed(): Ids {
  const out = python(
    `import json, sys
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world()))`,
    {}
  );
  return JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5));
}
function quarantineMapping(edition: string) {
  python(
    `import json, sys
from app import public_catalog
from app.main import connect
edition = json.load(open(sys.argv[1]))
with connect() as conn:
    conn.execute("UPDATE catalog_edition_metadata SET mapping_state='quarantined',mapping_reason='candidate_changed',auto_closed=true WHERE edition_id=%s", (edition,))
with connect() as conn:
    public_catalog.drain(conn)`,
    edition
  );
}
const lastOtp = () =>
  JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;

async function signIn(page: Page) {
  await pool.query("DELETE FROM auth_send_event");
  await page.goto(`${ORIGIN}/locations`);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  await page.getByLabel("Six-digit code").fill(lastOtp());
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
const owner = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** A Deck whose Deck List is `{edition: quantity}` and which holds none of those cards, written straight to PostgreSQL. */
async function deckWith(page: Page, quantities: Record<string, number>) {
  const name = `Mass ${randomUUID().slice(0, 8)}`;
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const id = (await created.json()).location.id as string;
  await listCards(pool, await owner(), id, quantities);
  return { id, name };
}

test.afterEach(async () => {
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
});
test.afterAll(async () => {
  await pool.end();
});

/** Publish (POST), republish (PUT) or revoke (DELETE) through the owner's session; returns the JSON. */
async function publication(
  page: Page,
  method: "POST" | "PUT" | "DELETE",
  deckId: string
) {
  const response = await page.request.fetch(
    `${ORIGIN}/api/decks/${deckId}/publication`,
    {
      method,
      headers: { origin: ORIGIN },
      data:
        method === "DELETE"
          ? { idempotency_key: randomUUID() }
          : { title: "Mass entry public deck", idempotency_key: randomUUID() },
    }
  );
  expect(response.status()).toBe(200);
  return response.json();
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

test("an anonymous visitor opens an all-mapped Published Deck in TCGplayer only after the guidance, gets complete text once a mapping is quarantined, and never shows an answer for another version", async ({
  page,
  browser,
}) => {
  const ids = seed();
  await signIn(page);
  const deck = await deckWith(page, {
    [ids.normal]: 3,
    [ids["reverse-holofoil"]]: 2,
  });
  const token = (await publication(page, "POST", deck.id)).token as string;

  const products = (
    await pool.query(
      "SELECT edition_id::text AS id, product_id FROM catalog_edition_metadata WHERE edition_id = ANY($1::uuid[])",
      [[ids.normal, ids["reverse-holofoil"]]]
    )
  ).rows as { id: string; product_id: number }[];
  const totals = new Map<number, number>();
  for (const row of products)
    totals.set(
      row.product_id,
      (totals.get(row.product_id) ?? 0) + (row.id === ids.normal ? 3 : 2)
    );
  const entries = [...totals.entries()].sort((a, b) => a[0] - b[0]);
  const url = BASE + entries.map(([p, q]) => `${q}-${p}`).join("%7C%7C");

  const anonymous = await browser.newContext();
  await anonymous.route("https://www.tcgplayer.com/**", (route) =>
    route.abort()
  );
  const visitor = await anonymous.newPage();
  await stubClipboard(visitor, "reject");
  await visitor.goto(`${ORIGIN}/published/${token}`);

  const region = visitor.getByRole("region", {
    name: "TCGplayer export",
    exact: true,
  });
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText(
    "Every card has a verified TCGplayer product (1 Printings, 5 copies)."
  );
  await region.getByRole("button", { name: "Open in TCGplayer" }).click();
  const dialog = visitor.getByRole("dialog", {
    name: "Before you open TCGplayer",
  });
  await expect(dialog).toContainText(
    "does not guarantee the finish or condition"
  );
  const link = visitor.getByRole("link", { name: "Continue to TCGplayer" });
  await expect(link).toHaveAttribute("href", url);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);

  quarantineMapping(ids.normal);
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText(
    "No TCGplayer link is offered because at least one card has no verified TCGplayer product."
  );
  await expect(region).toContainText("Less specific: 1 of 1 rows");
  await expect(region).toContainText("This Deck has 5 cards, not 60");
  await expect(region).toContainText("Basic deck checks only");
  await expect(
    region.getByRole("button", { name: "Open in TCGplayer" })
  ).toHaveCount(0);
  await expect(region.getByLabel("TCGplayer Mass Entry text")).toHaveText(
    "5 Furret"
  );
  await region.getByRole("button", { name: "Copy text" }).click();
  await expect(region).toContainText("Copy failed");
  await expect(
    region.getByRole("textbox", { name: "TCGplayer Mass Entry text" })
  ).toHaveValue("5 Furret");

  // An answer for another version is discarded.
  await visitor.route("**/versions/1/exports/tcgplayer", (route) =>
    route.fulfill({
      status: 200,
      json: {
        version: 2,
        digest: "0".repeat(64),
        status: "link",
        url: BASE + "5-1",
        fallback_reason: null,
        text: null,
        inline: true,
        byte_length: 8,
        lines: [{ quantity: "5", text: "5 Furret", less_specific: true }],
        line_count: 1,
        less_specific_count: 1,
        total_copies: "5",
      },
    })
  );
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText("Published Deck changed; export again");
  await expect(
    region.getByRole("button", { name: "Open in TCGplayer" })
  ).toHaveCount(0);
  await visitor.unroute("**/versions/1/exports/tcgplayer");

  // Large output: the page offers the real download.
  await visitor.route("**/versions/1/exports/tcgplayer", (route) =>
    route.fulfill({
      status: 200,
      json: {
        version: 1,
        digest: "0".repeat(64),
        status: "text",
        url: null,
        fallback_reason: "missing_mapping",
        text: null,
        inline: false,
        byte_length: 300000,
        lines: [],
        line_count: 1,
        less_specific_count: 1,
        total_copies: "5",
      },
    })
  );
  await region
    .getByRole("button", { name: "Prepare TCGplayer export" })
    .click();
  await expect(region).toContainText("This export is too large to show here.");
  const download = region.getByRole("link", { name: "Download text" });
  const href = `/api/public/decks/${token}/versions/1/exports/tcgplayer.txt`;
  await expect(download).toHaveAttribute("href", href);
  const response = await visitor.request.get(ORIGIN + href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(await response.text()).toBe("5 Furret");
  await visitor.unroute("**/versions/1/exports/tcgplayer");
  await anonymous.close();
});
