import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Pool } from "pg";

// Publishing needs a legal result in the Deck's Target Format (ADR 0011, #178). Specs written before that gate publish
// small Deck Lists that aren't legal in any Format, and their assertions depend on exactly those lines, so they exempt
// the Decks they publish. The stack's API process honours the exemption through api/tests/catalog_process_fixture
// (publish_gate_fixture.py), which only the verification stacks load. Every other Deck meets the real gate.

/** Let the Deck `deckId` publish on this worker's stack whatever its Target Format result. */
export function exemptFromPublishGate(deckId: string) {
  const root = process.env.CATALOG_PROCESS_FIXTURE_DIR;
  if (!root)
    throw new Error(
      "CATALOG_PROCESS_FIXTURE_DIR is unset: run this spec through npm run verify"
    );
  const directory = join(root, "publish-gate-exempt");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, deckId), "");
}

/** The same, for the one Deck named `deckName` (a Deck created through the page). */
export async function exemptNamedDeck(pool: Pool, deckName: string) {
  const decks = await pool.query(
    "SELECT id FROM location WHERE kind='deck' AND name=$1",
    [deckName]
  );
  if (decks.rowCount !== 1)
    throw new Error(`expected one Deck named ${deckName}`);
  exemptFromPublishGate(decks.rows[0].id as string);
}

/** Let Discover list the snapshot `token` on this worker's stack whatever its Target Format result (#182). For specs
 * written before legal-only Discover; Discover's own spec (discover-page.spec.ts) exempts nothing. */
export function exemptFromDiscover(token: string) {
  const root = process.env.CATALOG_PROCESS_FIXTURE_DIR;
  if (!root)
    throw new Error(
      "CATALOG_PROCESS_FIXTURE_DIR is unset: run this spec through npm run verify"
    );
  const directory = join(root, "discover-exempt");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, token), "");
}

/**
 * Publish in the deck builder is disabled while the Target Format result isn't legal (#181). Specs that publish an exempt
 * (not legal) Deck through the page also show it as legal to the page: it rewrites only the page's GET
 * `/api/decks/{deckId}` answer, so the Deck's Target Format result reads legal with no issues. The server's own gate still
 * runs; the exemption above lets the Deck through it.
 */
export async function showAsLegal(page: Page, deckId: string) {
  const legal = (checks: {
    results: { status: string; issues: unknown[] }[];
  }) => {
    for (const result of checks.results) {
      result.status = "legal";
      result.issues = [];
    }
  };
  await page.route(
    (url) => url.pathname === `/api/decks/${deckId}`,
    async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      if (response.ok() && body.format_checks) legal(body.format_checks);
      await route.fulfill({ response, json: body });
    }
  );
}
