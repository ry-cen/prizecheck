import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { exemptFromPublishGate } from "./support/publish-gate";
import { listCards, raiseLine } from "./support/deck-list";

// Ticket 13: a Published Deck's Pokémon TCG Live export, read by an anonymous visitor (second browser context, no
// cookie) against the real stack. Live eligibility is a maintainer `correct` decision under the shipped rule v1,
// delivered to the stack's record store, so nothing waits and the file runs in the parallel pass.
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type Ids = {
  normal: string;
  "reverse-holofoil": string;
  unspecified: string;
};
const python = (code: string, argument: object) => {
  const path = `${process.env.TMPDIR || "/tmp"}/published-live-export-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  return execFileSync(".venv/bin/python", ["-c", code, path], {
    env: { ...process.env, PYTHONPATH: "api:api/tests" },
    maxBuffer: 64 * 1024 * 1024,
  }).toString();
};
function seed(): Ids {
  const out = python(
    `import json
from test_published_live_export import ui_live_world
print('WORLD' + json.dumps(ui_live_world()))`,
    {}
  );
  return JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5));
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
const owner = async () =>
  (await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL]))
    .rows[0].id as string;

/** A Deck whose Deck List is `{edition: quantity}` and which holds none of those cards, written straight to PostgreSQL. */
async function deckWith(page: Page, quantities: Record<string, number>) {
  const name = `Live ${randomUUID().slice(0, 8)}`;
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
  if (method !== "DELETE") exemptFromPublishGate(deckId); // a small Deck List, not legal in any Format
  const response = await page.request.fetch(
    `${ORIGIN}/api/decks/${deckId}/publication`,
    {
      method,
      headers: { origin: ORIGIN },
      data:
        method === "DELETE"
          ? { idempotency_key: randomUUID() }
          : { title: "Live public deck", idempotency_key: randomUUID() },
    }
  );
  expect(response.status()).toBe(200);
  return response.json();
}
const bump = async () =>
  pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [await owner()]
  );

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

test("an anonymous visitor copies complete Live text of the frozen snapshot, keeps selectable text when the clipboard is denied, and follows a republish and a revoke", async ({
  page,
  browser,
}) => {
  const ids = seed();
  await signIn(page);
  const deck = await deckWith(page, {
    [ids.normal]: 3,
    [ids["reverse-holofoil"]]: 2,
    [ids.unspecified]: 1,
  });
  const token = (await publication(page, "POST", deck.id)).token as string;
  const addNormal = async () => {
    await raiseLine(pool, deck.id, ids.normal, 1);
    await bump();
  };
  // A private edit after publishing changes nothing the visitor sees.
  await raiseLine(pool, deck.id, ids.normal, 4);
  await bump();

  const anonymous = await browser.newContext();
  const visitor = await anonymous.newPage();
  await stubClipboard(visitor, "reject");
  await visitor.goto(`${ORIGIN}/published/${token}`);
  const live = visitor.getByRole("region", { name: "Pokémon TCG Live export" });
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  const output = live.getByRole("region", { name: "Live export", exact: true });
  await expect(output.getByLabel("Live export text")).toHaveText(
    "Pokémon: 6\n5 Furret DAA 136\n1 Furret DAA 2"
  );
  await expect(output).toContainText("This Deck has 6 cards, not 60.");
  await expect(output).toContainText("Basic deck checks only.");
  // The disclaimer points to format checks; the export itself never claims a card or deck is legal.
  await expect(output).not.toContainText(/\blegal\b/i);

  // A denied clipboard leaves selectable text.
  await output.getByRole("button", { name: "Copy for Live" }).click();
  await expect(output.getByRole("status")).toContainText("Copy failed");
  await expect(
    output.getByRole("textbox", { name: "Live export text" })
  ).toHaveValue("Pokémon: 6\n5 Furret DAA 136\n1 Furret DAA 2");

  // A republish between the page load and the export: 409, then the page reads version 2.
  await visitor.route("**/versions/1/exports/live", async (route) => {
    await addNormal();
    await publication(page, "PUT", deck.id);
    await route.continue();
  });
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(visitor.getByRole("main")).toContainText("Snapshot version 2");
  await expect(live).toContainText("Published Deck changed; export again");
  await visitor.unroute("**/versions/1/exports/live");
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(
    live
      .getByRole("region", { name: "Live export", exact: true })
      .getByLabel("Live export text")
  ).toHaveText("Pokémon: 11\n10 Furret DAA 136\n1 Furret DAA 2");

  // Large output: the wiring offers the complete .txt download of this version.
  await visitor.route("**/versions/2/exports/live", (route) =>
    route.fulfill({
      status: 200,
      json: {
        version: 2,
        digest: "0".repeat(64),
        status: "ok",
        text: null,
        inline: false,
        byte_length: 300000,
        total_copies: "11",
        blockers: [],
      },
    })
  );
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(live).toContainText("This export is too large to show here.");
  const link = live.getByRole("link", { name: "Download Live export" });
  const href = `/api/public/decks/${token}/versions/2/exports/live.txt`;
  await expect(link).toHaveAttribute("href", href);
  const download = await visitor.request.get(ORIGIN + href);
  expect(download.status()).toBe(200);
  expect(download.headers()["content-disposition"]).toMatch(/^attachment/);
  expect(await download.text()).toBe(
    "Pokémon: 11\n10 Furret DAA 136\n1 Furret DAA 2"
  );
  await visitor.unroute("**/versions/2/exports/live");

  // A revoke between the page load and the export: 404, and the page reads its snapshot again.
  await visitor.route("**/versions/2/exports/live", async (route) => {
    await publication(page, "DELETE", deck.id);
    await route.continue();
  });
  await live
    .getByRole("button", { name: "Export to Live", exact: true })
    .click();
  await expect(
    visitor.getByRole("heading", {
      level: 1,
      name: "This deck isn't published anymore",
    })
  ).toBeVisible();
  await anonymous.close();
});
