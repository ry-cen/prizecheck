import { test, expect, type Page } from "@playwright/test";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";

// Ticket 08 AC9 against the live stack: a hard price row admits a real runner (launched by the stack's API), whose
// fetch hangs at a fake TCGdex server. The page renders at once, each price slot shows its pending text, and then the
// server's labelled fallback replaces it; the rest of the page never waits. The fake origin reaches the launched runner
// through the CI fixture's origin file in the stack's PRICE_RUNNER_LOCK_DIR (the launcher's allowlist drops env hooks).
const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";
const LOCK_DIR = process.env.PRICE_RUNNER_LOCK_DIR || "";
const ORIGIN_FILE = join(LOCK_DIR, "fixture-source-origin"); // price_fixture.ORIGIN_FILE
const PIDS = join(LOCK_DIR, "runner-pids"); // price_fixture.PIDS_DIR
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const run = promisify(execFile);

const fetched: string[] = [];
let source: Server;

const python = (code: string, argument: object) => {
  const path = `${process.env.TMPDIR || "/tmp"}/price-refresh-${randomUUID()}.json`;
  writeFileSync(path, JSON.stringify(argument));
  try {
    return execFileSync(".venv/bin/python", ["-c", code, path], {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } finally {
    rmSync(path, { force: true });
  }
};
function seed(): { normal: string; "reverse-holofoil": string } {
  const out = python(
    `import json, sys
from test_prices import ui_world
print('WORLD' + json.dumps(ui_world(0)))`,
    {}
  );
  return JSON.parse(out.slice(out.lastIndexOf("WORLD") + 5));
}

/** Runners registered by the fixture in the stack's lock directory that are still alive (scoped; no host-wide search). */
async function liveRunners() {
  if (!existsSync(PIDS)) return [];
  const pids = readdirSync(PIDS).filter((name) => /^\d+$/.test(name));
  if (!pids.length) return [];
  let out = "";
  try {
    out = (await run("ps", ["-o", "pid=,stat=,args=", "-p", pids.join(",")]))
      .stdout;
  } catch (error: any) {
    out = error?.stdout ?? "";
  }
  return out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line))
    .filter(
      (found) =>
        found &&
        !found[2].startsWith("Z") &&
        found[3].includes("app.price_runner")
    )
    .map((found) => Number(found![1]));
}

async function signIn(page: Page) {
  await pool.query("DELETE FROM auth_send_event");
  await page.goto(`${ORIGIN}/locations`);
  await page.getByLabel("Email", { exact: true }).fill(OWNER_EMAIL);
  await page.getByRole("button", { name: "Send code", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("code has been sent");
  const otp = JSON.parse(
    readFileSync(process.env.MAIL_FILE!, "utf8").trim().split("\n").at(-1)!
  ).otp as string;
  await page.getByLabel("Six-digit code").fill(otp);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function hold(editions: string[]) {
  const user = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [OWNER_EMAIL])
  ).rows[0].id;
  // The top-level Unsorted leaf that openRootUnsorted() opens; there is one per owner (one_unsorted_root_per_owner).
  const leaf = (
    await pool.query(
      "SELECT id FROM location WHERE owner_id=$1 AND parent_id IS NULL AND name='Unsorted' AND kind='storage_leaf'",
      [user]
    )
  ).rows[0]?.id;
  if (!leaf) throw new Error("The owner has no top-level Unsorted leaf");
  for (const edition of editions)
    await pool.query(
      "INSERT INTO holding(owner_id,location_id,edition_id,quantity,version) VALUES($1,$2,$3,1,1) ON CONFLICT(owner_id,location_id,edition_id) DO NOTHING",
      [user, leaf, edition]
    );
  await pool.query(
    "UPDATE inventory_owner SET revision=revision+1 WHERE user_id=$1",
    [user]
  );
}

/** Opens the owner's top-level Unsorted leaf, the one hold() stocks. Specs that ran earlier on this stack can leave
 * nested Locations named "Unsorted" that sort ahead of it in the tree, so only a top-level row counts. */
async function openRootUnsorted(page: Page) {
  await page
    .getByRole("navigation", { name: "Location tree" })
    .locator(":scope > ul > li > button", { hasText: /^Unsorted$/ })
    .click();
  await expect(
    page
      .getByRole("navigation", { name: "Location breadcrumbs" })
      .getByRole("button")
  ).toHaveText(["All Locations", "Unsorted"]);
}

test.beforeAll(async () => {
  test.skip(!LOCK_DIR, "needs the CI stack's PRICE_RUNNER_LOCK_DIR");
  // Every request hangs: the runner's own 2 s deadline ends each fetch.
  source = createServer((request) => {
    fetched.push(request.url ?? "");
  });
  await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
  const { port } = source.address() as { port: number };
  writeFileSync(ORIGIN_FILE, `http://127.0.0.1:${port}`);
});

test.afterAll(async () => {
  if (LOCK_DIR) {
    rmSync(ORIGIN_FILE, { force: true });
    // Later specs share this stack: let our runners finish (fetch deadline, then 2 s idle) before handing it over.
    const end = Date.now() + 15_000;
    while ((await liveRunners()).length && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
  source?.closeAllConnections();
  await new Promise((resolve) =>
    source ? source.close(resolve) : resolve(null)
  );
  await pool.query("UPDATE catalog_rule_state SET activation_id=NULL");
  await pool.end();
});

// @serial: the label depends on a real runner's 2 s source deadline ending inside the server's 2.5 s wait window and
// 3 s budget; CPU load from parallel stacks could push the answer past the client's own timeout.
// @slow (process): a real runner against a hanging source.
test(
  "the page renders at once, price slots show their pending text, then the server's labelled fallback",
  { tag: ["@serial", "@slow"] },
  async ({ page }) => {
    const ids = seed();
    await signIn(page);
    await hold([ids.normal, ids["reverse-holofoil"]]);
    await page.reload();
    const answers: number[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith("/api/prices/editions"))
        answers.push(response.status());
    });
    await openRootUnsorted(page);
    const panel = page.getByRole("region", { name: "Cards in Unsorted" });
    // Non-price content is there while every price slot is still pending.
    await expect(panel.locator(".holding-grid > li")).toHaveCount(2);
    await expect(panel.getByText("Furret").first()).toBeVisible();
    await expect(panel.getByText("Checking prices…")).toHaveCount(2);
    await expect(panel.locator('[data-price-status="checking"]')).toHaveCount(
      2
    );
    // Then the labelled fallback from the server (not the client's own timeout), inside the gateway deadline.
    const slots = panel.locator(".edition-price");
    await expect(panel.getByText("Checking prices…")).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(slots).toHaveCount(2);
    for (const slot of await slots.all()) {
      await expect(slot).toContainText("No cached price yet");
      await expect(slot.locator(".price-refresh")).toHaveAttribute(
        "data-refresh",
        /^(timeout|failed)$/
      );
      await expect(slot).toContainText(/Refresh timed out|Last refresh failed/);
    }
    await expect(panel).not.toContainText("Price check timed out");
    await expect(panel).not.toContainText("$0.00");
    expect(answers).toEqual([200]);
    // A real runner fetched the card once for both Editions (one claim per source card).
    expect(fetched).toEqual(["/v2/en/cards/meta-1"]);
    await expect(panel.locator(".holding-grid > li")).toHaveCount(2);
  }
);
