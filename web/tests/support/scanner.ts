import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { Pool } from "pg";
import { SCANNER_PATH } from "../../src/scanner/route";
import type {
  ScriptedFrame,
  ScannerTestScript,
} from "../../src/scanner/ui/testHooks";
import { artUpstream, PIXEL } from "./art-upstream";
import { startAsNewOwner } from "./owner";
import { signInAsOwner } from "./sign-in";

// Browser tests of the scanner screen (#318). The page is the real scanner entry on the dev server; the stub recognizer
// (web/src/scanner/testing/stubRecognizer.ts) answers from a script the test installs before the page loads, and a
// scripted source hands it frames. The manifest, printings and save routes run against the test stack.

/** A scripted frame as the specs write it: `url` (a fixture under web/tests/fixtures/scanner/, served by the dev server)
 * is filled in by `installScript` when left out: the card picture for a frame that recognizes something, the empty table
 * for one that does not. */
export type ScannedTestFrame = Omit<ScriptedFrame, "url"> & { url?: string };
export type ScriptInput = Omit<ScannerTestScript, "frames"> & {
  frames: ScannedTestFrame[];
};
export const FIXTURE_URL = "/tests/fixtures/scanner";
export const TABLE = `${FIXTURE_URL}/table.png`;
export const CARD = `${FIXTURE_URL}/card-a.png`;

export const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

/** Five tiles of the catalog fixture api/tests/test_catalog_browse.py seed_popup: Bulbasaur (MEG 001; Normal and
 * Reverse Holo active, Holo retired), Rare Candy (MEG 125), Switch (MEG 130) and Professor's Research. */
export function seedPopup() {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

/** Retires Bulbasaur's Normal Edition, as a catalog update would. */
export async function retireBulbasaurNormal() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(
      `UPDATE catalog_generation_edition SET active=false
        WHERE generation_id=(SELECT active_generation FROM catalog_state WHERE singleton)
          AND edition_id=(SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
                           WHERE p.source_id='me01-001' AND e.descriptor->>'finish'='normal')`
    );
  } finally {
    await pool.end();
  }
}

/** Signs in as a new owner (with an empty tray and no Locations of their own) and stays on Collection. */
export async function signInFresh(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  // The scanner's pictures come through /api/art, whose fetcher reads this stub; the route below still covers the
  // non-scanner pages, which load the art host directly.
  (await artUpstream()).reset();
  await page.route("https://assets.tcgdex.net/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: PIXEL,
      headers: {
        "access-control-allow-origin": "*",
        "cross-origin-resource-policy": "cross-origin",
      },
    })
  );
  await signInAsOwner(page, "/collection");
}

export type Printings = Record<string, string>;
/** Printing ids by card name, read from the catalog the way a collector's search does. */
export async function printingIds(page: Page): Promise<Printings> {
  const found: Printings = {};
  for (const name of ["Bulbasaur", "Rare Candy", "Switch"]) {
    const response = await page.request.get(
      `${ORIGIN}/api/catalog/editions?q=${encodeURIComponent(name)}`
    );
    const body = (await response.json()) as {
      editions: { name: string; printing_id: string }[];
    };
    const hit = body.editions.find((e) => e.name === name);
    expect(hit, `${name} is in the catalog fixture`).toBeTruthy();
    found[name] = hit!.printing_id;
  }
  return found;
}

/** The frames of one card held in the guide, number-backed (its OCR reads its number). */
export const holding = (id: string, frames = 4): ScannedTestFrame[] =>
  Array.from({ length: frames }, () => ({ top: [id], ocr: [id] }));
/** Frames of an empty guide: nothing found, a different picture, so the voter sees the card leave. The scripted source
 * hands out no frame while a lock waits for its answer, so the script never runs ahead of the tray. */
export const empty = (frames = 3): ScannedTestFrame[] =>
  Array.from({ length: frames }, () => ({}));
/** Cards placed one after another, each taken away before the next. After the last frame the last one repeats. */
export const placements = (...ids: string[]): ScannedTestFrame[] =>
  ids.flatMap((id) => [...holding(id), ...empty()]);

/**
 * Installs the script before the page loads. `afterReload` is what a reloaded page plays instead (default: an empty
 * guide), so a reload does not scan the same cards again.
 */
export async function installScript(
  page: Page,
  input: ScriptInput,
  afterInput: ScriptInput = { frames: [{}] }
) {
  const withPictures = (s: ScriptInput): ScannerTestScript => ({
    ...s,
    frames: (s.frames.length ? s.frames : [{}]).map((f) => ({
      ...f,
      url: f.url ?? (f.top?.length ? CARD : TABLE),
    })),
  });
  const script = withPictures(input);
  const afterReload = withPictures(afterInput);
  await page.addInitScript(
    ([first, later]) => {
      const key = "scanner-test-played";
      const played = sessionStorage.getItem(key) !== null;
      sessionStorage.setItem(key, "1");
      (
        window as unknown as Record<string, unknown>
      ).__PRIZECHECK_SCANNER_TEST__ = { script: played ? later : first };
    },
    [script, afterReload] as const
  );
}

export async function openScanner(page: Page) {
  await page.goto(new URL(SCANNER_PATH, ORIGIN).href);
  await expect(page.getByTestId("scanner-page")).toBeVisible();
}

export const trayPeek = (page: Page): Locator =>
  page.getByRole("region", { name: "Tray" });
export const trayOpen = (page: Page): Locator =>
  page.getByRole("dialog", { name: "Tray" });
export const hintPill = (page: Page): Locator =>
  page.getByRole("status", { name: "Scanner hint" });

/** Opens the tray from its peek. */
export async function reviewTray(page: Page) {
  await trayPeek(page).getByRole("button", { name: "Review" }).click();
  await expect(trayOpen(page)).toBeVisible();
}

/** The collector's Locations, by name. */
export async function locationIds(page: Page) {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  const { locations } = (await response.json()) as {
    locations: {
      id: string;
      name: string;
      parent_id: string | null;
      version: number;
    }[];
  };
  return locations;
}

export async function createLeaf(page: Page, name: string): Promise<string> {
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { location: { id: string } }).location.id;
}

export async function deleteLocation(page: Page, id: string) {
  const node = (await locationIds(page)).find((n) => n.id === id)!;
  const response = await page.request.delete(
    `${ORIGIN}/api/location-tree/${id}`,
    {
      headers: { origin: ORIGIN },
      data: {
        name: node.name,
        version: node.version,
        idempotency_key: randomUUID(),
      },
    }
  );
  expect(response.status(), await response.text()).toBe(200);
}

/** Copies held in a Location, by card name. */
export async function held(page: Page, locationId: string) {
  const response = await page.request.get(
    `${ORIGIN}/api/holdings/${locationId}`
  );
  const { holdings } = (await response.json()) as {
    holdings: { printing_name: string; quantity: string }[];
  };
  return holdings.map((h) => `${h.quantity} ${h.printing_name}`).sort();
}

/** The frames of one card matched by its artwork alone (#319): the ranking is `ids`, the OCR reads no number, so the
 * scanner suggests instead of locking. */
export const imageOnly = (ids: string[], frames = 4): ScannedTestFrame[] =>
  Array.from({ length: frames }, () => ({ top: ids, ocr: [] }));

/** The Scan Suggestion card on the scanner screen. */
export const suggestionCard = (page: Page): Locator =>
  page.getByRole("group", { name: "Is it one of these?" });

/** Waits until the scripted source has handed out `n` more frames, counted from now. */
export async function framesPlayed(page: Page, n: number) {
  const start = await page.evaluate(
    () =>
      (
        window as unknown as {
          __PRIZECHECK_SCANNER_TEST__: { played?: number };
        }
      ).__PRIZECHECK_SCANNER_TEST__.played ?? 0
  );
  await page.waitForFunction(
    ([from, count]) =>
      ((
        window as unknown as {
          __PRIZECHECK_SCANNER_TEST__: { played?: number };
        }
      ).__PRIZECHECK_SCANNER_TEST__.played ?? 0) >=
      from + count,
    [start, n] as const
  );
}
