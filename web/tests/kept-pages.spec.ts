import { startAsNewOwner } from "./support/owner";
import {
  api,
  seedCatalog,
  nameCollector,
  befriend,
  hold,
  unsorted,
} from "./support/loans";
import { traderIdOf } from "./support/conversations";
import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { test, expect } from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";
import { expectPageChecks } from "./support/page-check";

test.setTimeout(60_000);

const tabs = (page: Page) =>
  page.getByRole("navigation", { name: "Main views" });
const main = (page: Page) => page.locator("#main-content");
async function createDeck(page: Page, name: string) {
  const response = await page.request.post(
    new URL("/api/decks", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { name, idempotency_key: randomUUID() },
    }
  );
  expect(response.status()).toBe(201);
  return (await response.json()).location.id as string;
}
async function warmed(page: Page) {
  // Settings comes after every collector tab in the warm queue.
  await expect(
    page.locator("[hidden]").getByRole("heading", {
      name: "Settings",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(1, { timeout: 45_000 });
  await expect(
    page.locator("[hidden]").getByRole("heading", {
      name: "Sign-ins",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(1);
  await expect(
    page.locator("[hidden]").getByText("Loading Loans…", { exact: true })
  ).toHaveCount(0);
}

test("idle sign-in warms populated roots and their first opens never show loading", async ({
  page,
  collectors,
}) => {
  const ids = seedCatalog();
  const lender = await collectors.signIn();
  await nameCollector(lender.page, "Warm lender");
  await hold(lender.page, await unsorted(lender.page), ids["PAL 185"], 2);
  await signInAsOwner(page);
  await befriend(page, lender.page);
  const deckName = `Warm Deck ${randomUUID()}`;
  const deckId = await createDeck(page, deckName);
  await api(page, "POST", "/api/loans", {
    lender_id: lender.userId,
    lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
    idempotency_key: randomUUID(),
  });
  await api(
    page,
    "POST",
    `/api/social/traders/${await traderIdOf(lender.page)}/messages`,
    { body: "Warm message", idempotency_key: randomUUID() }
  );
  await api(page, "POST", "/api/missing-card-reports", {
    kind: "printing",
    set_id: "warm-set",
    collector_number: "999",
    english_name: "Warm report",
    note: "Missing card evidence",
  });
  const address = page.url();
  await page.goto("about:blank");
  const completed = new Set<string>();
  let costs = 0;
  page.on("response", async (response) => {
    if (!response.ok() || response.request().method() !== "GET") return;
    await response.finished();
    completed.add(new URL(response.url()).pathname);
    if (new URL(response.url()).pathname === `/api/decks/${deckId}/cost`)
      costs++;
  });
  await page.goto(address);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "All owned"
  );
  await page.evaluate(() => {
    document.body.style.minHeight = "4000px";
    window.scrollTo(0, 400);
    const button = document.querySelector<HTMLButtonElement>(
      'nav[aria-label="Main views"] button'
    );
    button?.focus({ preventScroll: true });
    if (button) button.dataset.focusProbe = "";
  });
  await warmed(page);
  const endpoints = [
    "/api/decks",
    "/api/social/loans",
    "/api/social/conversations",
    "/api/missing-card-reports",
    "/api/catalog/editions",
    "/auth/sign-ins",
    `/api/decks/${deckId}/cost`,
  ];
  await expect
    .poll(() => endpoints.every((path) => completed.has(path)))
    .toBe(true);
  expect(costs).toBe(1);
  expect(await page.evaluate(() => window.scrollY)).toBe(400);
  await expect(page.locator("[data-focus-probe]")).toBeFocused();
  await expect(page).toHaveURL(/\/collection$/);
  await page.evaluate(() => {
    document.documentElement.dataset.keptLoading = "false";
    new MutationObserver(() => {
      const current = document.getElementById("main-content");
      if (!current) return;
      const loading = [
        ...current.querySelectorAll("p, span, [role=status]"),
      ].find(
        (node) =>
          node.getClientRects().length > 0 &&
          /^Loading[ ….]/.test(node.textContent ?? "")
      );
      const busy = [...current.querySelectorAll('[aria-busy="true"]')].find(
        (node) => node.getClientRects().length > 0
      );
      if (
        loading ||
        busy ||
        current.firstElementChild?.getAttribute("aria-hidden") === "true"
      )
        document.documentElement.dataset.keptLoading = loading
          ? `text: ${loading.textContent}`
          : busy
            ? "busy"
            : "placeholder";
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
  });
  for (const label of [
    "Decks",
    "Loans",
    "Trades",
    "Missing cards",
    "Catalog",
    "Settings",
  ]) {
    if (label === "Settings") {
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "Settings", exact: true })
        .click();
    } else
      await tabs(page)
        .getByRole("button", { name: new RegExp(`^${label}(,|$)`) })
        .click();
    const content = main(page);
    if (label === "Decks") {
      await expect(
        content.getByRole("link", { name: deckName, exact: true })
      ).toBeVisible({ timeout: 0 });
      await expect(
        content.getByText("$0.00 to complete", { exact: true })
      ).toBeVisible({ timeout: 0 });
      expect(costs).toBe(1);
    } else if (label === "Loans")
      await expect(
        content.getByRole("link", { name: /You asked Warm lender for 1 card/ })
      ).toBeVisible({ timeout: 0 });
    else if (label === "Trades")
      await expect(
        content.getByRole("link", { name: /Warm lender/ })
      ).toBeVisible({ timeout: 0 });
    else if (label === "Missing cards")
      await expect(
        content.getByRole("row").filter({ hasText: "Warm report" })
      ).toBeVisible({ timeout: 0 });
    else if (label === "Catalog")
      await expect(content.locator("[data-edition-id]").first()).toBeVisible({
        timeout: 0,
      });
    else
      await expect(
        content
          .getByRole("region", { name: "Your sign-ins" })
          .getByRole("listitem")
          .filter({ hasText: "Google" })
      ).toBeVisible({ timeout: 0 });
    expect(
      await page.evaluate(() => document.documentElement.dataset.keptLoading),
      `loading placeholder on first ${label} open`
    ).toBe("false");
  }
  expect(
    await page.evaluate(() => {
      const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    })
  ).toEqual([]);
  await expectPageChecks(page, "warmed populated roots");
});

test("Decks keeps old data while a held re-read fetches an API change, and ignores a quiet failure", async ({
  page,
}) => {
  await signInAsOwner(page);
  const oldName = `Kept ${randomUUID()}`;
  const newName = `Added ${randomUUID()}`;
  await createDeck(page, oldName);
  // A fresh sign-in document warms the newly created Deck.
  await page.reload();
  await warmed(page);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(main(page).getByText(oldName, { exact: true })).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await createDeck(page, newName);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/decks$/, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await tabs(page)
      .getByRole("button", { name: "Decks", exact: true })
      .click();
    await expect(main(page).getByText(oldName, { exact: true })).toBeVisible();
    await expect(main(page).getByText(newName, { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
  await expect(main(page).getByText(newName, { exact: true })).toBeVisible();
  await page.unroute(/\/api\/decks$/);
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await page.route(/\/api\/decks$/, (route) =>
    route.fulfill({ status: 503, body: "{}" })
  );
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(main(page).getByText(newName, { exact: true })).toBeVisible();
  await expect(
    main(page).getByText("Decks are temporarily unavailable. Please retry.", {
      exact: true,
    })
  ).toHaveCount(0);
});

test("root state survives tab switches; details unmount, Back remounts them, and a warm Collection consumes its Location link", async ({
  page,
}) => {
  await signInAsOwner(page);
  const name = `Location ${randomUUID()}`;
  const id = await createDeck(page, name);
  await page.reload();
  await warmed(page);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await main(page)
    .getByRole("textbox", { name: "Deck name" })
    .fill("Unsubmitted draft");
  await page.evaluate(() => {
    document.body.style.minHeight = "4000px";
    window.scrollTo(0, 350);
  });
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(
    main(page).getByRole("textbox", { name: "Deck name" })
  ).toHaveValue("Unsubmitted draft");
  expect(await page.evaluate(() => window.scrollY)).toBe(350);
  await main(page).getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/decks/${id}$`));
  await tabs(page).getByRole("button", { name: "Loans", exact: true }).click();
  await page.goBack();
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(name);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(
    main(page).getByRole("textbox", { name: "Deck name" })
  ).toHaveValue("");
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Simulate the router's History API navigation without reloading the document.
  await page.evaluate((locationId) => {
    history.pushState(null, "", `/collection?location=${locationId}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, id);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(name);
  await expect(page).toHaveURL(/\/collection$/);
});

test("Save-Data skips hidden warm mounts", async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "connection", {
      value: { saveData: true },
      configurable: true,
    })
  );
  await signInAsOwner(page);
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "All owned"
  );
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestIdleCallback(() => requestIdleCallback(() => resolve()))
      )
  );
  await expect(
    page
      .locator("[hidden]")
      .getByRole("heading", { name: "Decks", exact: true, includeHidden: true })
  ).toHaveCount(0);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "Decks"
  );
});

test("Loans retains its rows while a held show-time read fetches an API change", async ({
  page,
  collectors,
}) => {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from test_catalog_search import promote\npromote({'kept-card': 'Kept Pikachu'})",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
  const lender = await collectors.signIn();
  await signInAsOwner(page);
  async function command(
    target: Page,
    path: string,
    data: object,
    method = "POST"
  ) {
    const response = await target.request.fetch(
      new URL(path, target.url()).href,
      { method, headers: { origin: new URL(target.url()).origin }, data }
    );
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  await command(
    lender.page,
    "/api/profile/display-name",
    { display_name: "Kept lender", idempotency_key: randomUUID() },
    "PUT"
  );
  const session = await (
    await page.request.get(new URL("/auth/session", page.url()).href)
  ).json();
  await command(page, "/api/social/friend-requests", {
    collector_id: lender.userId,
    idempotency_key: randomUUID(),
  });
  await command(
    lender.page,
    `/api/social/friend-requests/${session.userId}/accept`,
    { idempotency_key: randomUUID() }
  );
  const edition = (
    await collectors.pool.query(
      "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id='kept-card' AND e.descriptor->>'finish'='normal'"
    )
  ).rows[0].id as string;
  const tree = await (
    await lender.page.request.get(
      new URL("/api/location-tree", lender.page.url()).href
    )
  ).json();
  const unsorted = tree.locations.find(
    (row: { name: string }) => row.name === "Unsorted"
  ).id;
  await command(lender.page, "/api/holdings", {
    location_id: unsorted,
    edition_id: edition,
    quantity: "2",
    idempotency_key: randomUUID(),
  });
  const loan = await command(page, "/api/loans", {
    lender_id: lender.userId,
    lines: [{ edition_id: edition, quantity: "1" }],
    idempotency_key: randomUUID(),
  });
  await page.reload();
  await warmed(page);
  await tabs(page)
    .getByRole("button", { name: /^Loans/ })
    .click();
  const old = main(page).getByRole("link", {
    name: /You asked Kept lender for 1 card/,
  });
  await expect(old).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await command(page, `/api/social/loans/${loan.id}/withdraw`, {
    revision: loan.revision,
    idempotency_key: randomUUID(),
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/social\/loans$/, async (route) => {
    await held;
    await route.continue();
  });
  try {
    await tabs(page)
      .getByRole("button", { name: /^Loans/ })
      .click();
    await expect(old).toBeVisible();
    await expect(
      main(page).getByText("Loading Loans…", { exact: true })
    ).toHaveCount(0);
  } finally {
    release();
  }
  await expect(old).toHaveCount(0);
  await main(page)
    .locator("summary")
    .filter({ hasText: /^History/ })
    .click();
  await expect(
    main(page).getByRole("link", {
      name: /You withdrew your request to Kept lender/,
    })
  ).toBeVisible();
});

test("first activation keeps the warm read in flight, and a later quiet failure keeps its data", async ({
  page,
}) => {
  let count = 0;
  let arrived!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/social\/loans$/, async (route) => {
    count++;
    if (count === 1) {
      arrived();
      await held;
      await route.fulfill({ json: { loans: [], needs_you: 0 } });
    } else await route.fulfill({ status: 503, json: {} });
  });
  await signInAsOwner(page);
  await started;
  try {
    await tabs(page)
      .getByRole("button", { name: /^Loans/ })
      .click();
    expect(count).toBe(1);
    await expect(
      main(page).getByText("Loading Loans…", { exact: true })
    ).toBeVisible();
  } finally {
    release();
  }
  await expect(main(page).getByText(/^No Loans yet\./)).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  const failed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/social/loans") && response.status() === 503
  );
  await tabs(page)
    .getByRole("button", { name: /^Loans/ })
    .click();
  await failed;
  await expect(main(page).getByText(/^No Loans yet\./)).toBeVisible();
  await expect(
    main(page).getByText("Your Loans couldn't be loaded.", { exact: true })
  ).toHaveCount(0);
  expect(count).toBe(2);
});

test("a failed hidden read retries on first activation", async ({ page }) => {
  let count = 0;
  await page.route(/\/api\/social\/loans$/, (route) => {
    count++;
    return count === 1
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { loans: [], needs_you: 0 } });
  });
  await signInAsOwner(page);
  await warmed(page);
  expect(count).toBe(1);
  await tabs(page)
    .getByRole("button", { name: /^Loans/ })
    .click();
  await expect(main(page).getByText(/^No Loans yet\./)).toBeVisible();
  expect(count).toBe(2);
});

test("Settings preserves unsaved form fields across tab switches", async ({
  page,
}) => {
  await signInAsOwner(page);
  await warmed(page);
  const openSettings = async () => {
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  };
  await openSettings();
  const field = main(page).getByRole("textbox", {
    name: "Display Name",
    exact: true,
  });
  await field.fill("Unsaved collector name");
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await openSettings();
  await expect(field).toHaveValue("Unsaved collector name");
});

test("a late quiet read cannot restore a conversation after Archive completes", async ({
  page,
}) => {
  const id = randomUUID();
  const row = {
    id,
    other: {
      trader_id: randomUUID(),
      display_name: "Pending archive",
      friend: false,
      handle: null,
      band: null,
      completed_trades: 0,
    },
    status: "open",
    last_message: null,
    open_trades: 0,
    waiting_on_you: 0,
    unread: false,
    archived: false,
    last_activity_at: new Date().toISOString(),
  };
  let count = 0;
  let archiveComplete = false;
  let releaseRead!: () => void;
  let releaseArchive!: () => void;
  let readStarted!: () => void;
  let archiveStarted!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const heldArchive = new Promise<void>((resolve) => {
    releaseArchive = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const archiving = new Promise<void>((resolve) => {
    archiveStarted = resolve;
  });
  await page.route(/\/api\/social\/conversations(?:\?.*)?$/, async (route) => {
    const rows = archiveComplete ? [] : [row];
    count++;
    if (count === 2) {
      readStarted();
      await heldRead;
    }
    await route.fulfill({
      json: { conversations: rows, next_before: null, suspended: false },
    });
  });
  await page.route(
    `**/api/social/conversations/${id}/archive`,
    async (route) => {
      archiveStarted();
      await heldArchive;
      archiveComplete = true;
      await route.fulfill({ json: { ...row, archived: true } });
    }
  );
  await signInAsOwner(page);
  await warmed(page);
  await tabs(page)
    .getByRole("button", { name: /^Trades/ })
    .click();
  const conversation = main(page).getByRole("link", {
    name: /Pending archive/,
  });
  await expect(conversation).toBeVisible();
  try {
    await main(page)
      .getByRole("button", { name: /Archive.*Pending archive/ })
      .click();
    await archiving;
    await tabs(page)
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    await reading;
    releaseArchive();
    await expect(conversation).toHaveCount(0);
    const answered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/social/conversations"
    );
    releaseRead();
    await answered;
    // Allow the response body and React's commit to finish before checking the stale row stayed discarded.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(conversation).toHaveCount(0);
  } finally {
    releaseArchive();
    releaseRead();
  }
});

function pricedEdition(): string {
  const output = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `import json
from datetime import datetime, timezone
from test_prices import ui_world, ui_apply
ids = ui_world()
now = datetime.now(timezone.utc).isoformat()
ui_apply([dict(op='quote', edition=ids['normal'], amount='0.25', updated=now, checked=now)])
print('COSTWORLD' + json.dumps(ids))`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  ).toString();
  return JSON.parse(output.slice(output.lastIndexOf("COSTWORLD") + 9))
    .normal as string;
}

for (const mode of ["failed", "held"] as const) {
  test(`a ${mode} warm tile cost recovers on first show without duplicating an in-flight read`, async ({
    page,
    collectors,
  }) => {
    await startAsNewOwner(collectors.pool);
    await signInAsOwner(page);
    const name = `Retry cost ${randomUUID()}`;
    const id = await createDeck(page, name);
    const address = page.url();
    await page.goto("about:blank");
    let count = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/decks/${id}/cost`, async (route) => {
      count++;
      if (count === 1 && mode === "failed")
        await route.fulfill({ status: 503, json: {} });
      else {
        if (count === 1 && mode === "held") await held;
        await route.continue();
      }
    });
    await page.goto(address);
    try {
      await warmed(page);
      await expect.poll(() => count).toBe(1);
      if (mode === "failed")
        await expect(
          page
            .locator("[hidden]")
            .getByText("Price to complete unavailable", { exact: true })
        ).toHaveCount(1);
      await tabs(page)
        .getByRole("button", { name: "Decks", exact: true })
        .click();
      if (mode === "held") {
        expect(count).toBe(1);
        release();
      }
      await expect(
        main(page).getByText("$0.00 to complete", { exact: true })
      ).toBeVisible();
      expect(count).toBe(mode === "failed" ? 2 : 1);
    } finally {
      release();
    }
  });
}

test("costs refresh after API inventory removal and a counting-settings change, but not for unchanged inputs", async ({
  page,
  collectors,
}) => {
  const edition = pricedEdition();
  await startAsNewOwner(collectors.pool);
  await signInAsOwner(page);
  const name = `Fresh cost ${randomUUID()}`;
  const id = await createDeck(page, name);
  const detail = await api(page, "GET", `/api/decks/${id}`);
  await api(page, "POST", `/api/decks/${id}/deck-list/changes`, {
    revision: detail.deck_list.revision,
    changes: [{ edition_id: edition, quantity: "1" }],
    idempotency_key: randomUUID(),
  });
  const leaf = await unsorted(page);
  await hold(page, leaf, edition, 1);
  const address = page.url();
  await page.goto("about:blank");
  let count = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/decks/${id}/cost`) count++;
  });
  await page.goto(address);
  await warmed(page);
  await expect(
    page.locator("[hidden]").getByText("$0.00 to complete", { exact: true })
  ).toHaveCount(1);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(
    main(page).getByText("$0.00 to complete", { exact: true })
  ).toBeVisible({ timeout: 0 });
  expect(count).toBe(1);
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  const holdings = await api(page, "GET", `/api/holdings/${leaf}`);
  const holding = holdings.holdings.find(
    (row: { edition_id: string }) => row.edition_id === edition
  );
  const manifest = await api(page, "POST", "/api/moves/manifests", {
    source_id: leaf,
  });
  await api(page, "PUT", `/api/moves/manifests/${manifest.id}/items`, {
    items: [
      { edition_id: edition, quantity: "1", expected_version: holding.version },
    ],
  });
  await api(page, "POST", `/api/moves/manifests/${manifest.id}/remove`, {
    idempotency_key: randomUUID(),
  });
  let probes = 0;
  await page.route(`**/api/decks/${id}/format-checks`, (route) =>
    ++probes === 1 ? route.fulfill({ status: 503, json: {} }) : route.continue()
  );
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(
    main(page).getByText("$0.25 to complete (1/1 priced)", { exact: true })
  ).toBeVisible();
  expect(count).toBe(2);
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  const settings = await api(page, "GET", "/api/settings");
  await api(page, "PUT", "/api/settings/want-list-counting", {
    want_list_counting:
      settings.want_list_counting === "all_at_once"
        ? "one_at_a_time"
        : "all_at_once",
    revision: settings.revision,
    idempotency_key: randomUUID(),
  });
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect.poll(() => count).toBe(3);
  await expect(
    main(page).getByText("$0.25 to complete (1/1 priced)", { exact: true })
  ).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  const checked = page.waitForResponse((response) =>
    response.url().includes(`/api/decks/${id}/format-checks`)
  );
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await (await checked).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  expect(count).toBe(3);
});

for (const first of ["archive", "page"] as const) {
  test(`pagination remains usable when ${first} completes first during Archive`, async ({
    page,
  }) => {
    const makeRow = (name: string) => ({
      id: randomUUID(),
      other: {
        trader_id: randomUUID(),
        display_name: name,
        friend: false,
        handle: null,
        band: null,
        completed_trades: 0,
      },
      status: "open",
      last_message: null,
      open_trades: 0,
      waiting_on_you: 0,
      unread: false,
      archived: false,
      last_activity_at: new Date().toISOString(),
    });
    const initial = makeRow("Archive row"),
      second = makeRow("Second page row"),
      third = makeRow("Third page row");
    let releasePage!: () => void, releaseArchive!: () => void;
    let pageStarted!: () => void, archiveStarted!: () => void;
    const heldPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    const heldArchive = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    const paging = new Promise<void>((resolve) => {
      pageStarted = resolve;
    });
    const archiving = new Promise<void>((resolve) => {
      archiveStarted = resolve;
    });
    await page.route(
      /\/api\/social\/conversations(?:\?.*)?$/,
      async (route) => {
        const before = new URL(route.request().url()).searchParams.get(
          "before"
        );
        if (before === "page-2") {
          pageStarted();
          await heldPage;
        }
        await route.fulfill({
          json: {
            conversations:
              before === "page-3"
                ? [third]
                : before
                  ? [initial, second]
                  : [initial],
            next_before:
              before === "page-3" ? null : before ? "page-3" : "page-2",
            suspended: false,
          },
        });
      }
    );
    await page.route(
      `**/api/social/conversations/${initial.id}/archive`,
      async (route) => {
        archiveStarted();
        await heldArchive;
        await route.fulfill({ json: { ...initial, archived: true } });
      }
    );
    await signInAsOwner(page);
    await warmed(page);
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    const more = main(page).getByRole("button", {
      name: "Show more conversations",
      exact: true,
    });
    try {
      await more.click();
      await paging;
      await main(page)
        .getByRole("button", {
          name: "Archive conversation with Archive row",
          exact: true,
        })
        .click();
      await archiving;
      if (first === "archive") {
        releaseArchive();
        await expect(
          main(page).getByRole("link", { name: /^Archive row/ })
        ).toHaveCount(0);
        releasePage();
      } else {
        releasePage();
        await expect(
          main(page).getByRole("link", { name: /^Second page row/ })
        ).toBeVisible();
        releaseArchive();
      }
      await expect(
        main(page).getByRole("link", { name: /^Second page row/ })
      ).toBeVisible();
      await expect(
        main(page).getByRole("link", { name: /^Archive row/ })
      ).toHaveCount(0);
      await expect(more).toBeEnabled();
      await more.click();
      await expect(
        main(page).getByRole("link", { name: /^Third page row/ })
      ).toBeVisible();
    } finally {
      releasePage();
      releaseArchive();
    }
  });
}

test("an Owner action failing after leaving cannot put its message on Catalog", async ({
  page,
  collectors,
}) => {
  await startAsNewOwner(collectors.pool);
  await signInAsOwner(page);
  const session = await api(page, "GET", "/auth/session");
  await collectors.pool.query(
    "INSERT INTO owner_binding(singleton,user_id) VALUES(true,$1) ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id",
    [session.userId]
  );
  await page.reload();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/admin/catalog-runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await held;
    await route.fulfill({ status: 503, json: {} });
  });
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Owner controls", exact: true })
    .click();
  try {
    const started = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        request.url().endsWith("/api/admin/catalog-runs")
    );
    await main(page)
      .getByRole("button", { name: "Start full pull", exact: true })
      .click();
    await started;
    await tabs(page)
      .getByRole("button", { name: "Catalog", exact: true })
      .click();
    const failed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/admin/catalog-runs")
    );
    release();
    await (await failed).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(
      main(page)
        .getByRole("alert")
        .filter({ hasText: "Unable to start catalog pull" })
    ).toHaveCount(0);
  } finally {
    release();
  }
});

test("a new activation recovers while superseded format checks are still held", async ({
  page,
  collectors,
}) => {
  await startAsNewOwner(collectors.pool);
  await signInAsOwner(page);
  const first = await createDeck(page, `Held format A ${randomUUID()}`);
  const second = await createDeck(page, `Held format B ${randomUUID()}`);
  const address = page.url();
  await page.goto("about:blank");
  const warmedCosts = new Set<string>();
  page.on("response", async (response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.ok() &&
      [first, second].some((id) => path === `/api/decks/${id}/cost`)
    ) {
      await response.finished();
      warmedCosts.add(path);
    }
  });
  await page.goto(address);
  await warmed(page);
  await expect.poll(() => warmedCosts.size).toBe(2);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldChecks = 0;
  await page.route(
    /\/api\/decks\/[^/]+\/format-checks(?:\?.*)?$/,
    async (route) => {
      if (heldChecks < 2) {
        heldChecks++;
        await held;
      }
      await route.continue().catch(() => undefined);
    }
  );
  try {
    await tabs(page)
      .getByRole("button", { name: "Decks", exact: true })
      .click();
    await expect.poll(() => heldChecks).toBe(2);
    await tabs(page)
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    const name = `Recovered format ${randomUUID()}`;
    await createDeck(page, name);
    await tabs(page)
      .getByRole("button", { name: "Decks", exact: true })
      .click();
    // Both old route handlers are still held. Recovery must come from cancellation, not their deadlines.
    await expect(
      main(page).getByRole("link", { name, exact: true })
    ).toBeVisible({ timeout: 2000 });
  } finally {
    release();
  }
});

test("a timed-out format request still permits the tile's healthy cost read", async ({
  page,
  collectors,
}) => {
  await startAsNewOwner(collectors.pool);
  await signInAsOwner(page);
  const name = `Independent cost ${randomUUID()}`;
  const id = await createDeck(page, name);
  const address = page.url();
  await page.goto("about:blank");
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let costReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/decks/${id}/cost`)
      costReads++;
  });
  await page.route(`**/api/decks/${id}/format-checks`, async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.goto(address);
    await warmed(page);
    await expect(
      page.locator("[hidden]").getByText("$0.00 to complete", { exact: true })
    ).toHaveCount(1, { timeout: 7000 });
    expect(costReads).toBe(1);
    await tabs(page)
      .getByRole("button", { name: "Decks", exact: true })
      .click();
    await expect(
      main(page).getByText("$0.00 to complete", { exact: true })
    ).toBeVisible({ timeout: 0 });
    expect(costReads).toBe(1);
  } finally {
    release();
  }
});

test("slow but healthy tile reads all finish, since waiting for a worker does not count against a read", async ({
  page,
  collectors,
}) => {
  await startAsNewOwner(collectors.pool);
  await signInAsOwner(page);
  await Promise.all([
    createDeck(page, `Slow tile A ${randomUUID()}`),
    createDeck(page, `Slow tile B ${randomUUID()}`),
    createDeck(page, `Slow tile C ${randomUUID()}`),
  ]);
  const address = page.url();
  await page.goto("about:blank");
  let costReads = 0;
  page.on("request", (request) => {
    if (/\/api\/decks\/[^/]+\/cost$/.test(new URL(request.url()).pathname))
      costReads++;
  });
  await page.route(
    /\/api\/decks\/[^/]+\/format-checks(?:\?.*)?$/,
    async (route) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
      await route.continue();
    }
  );
  await page.route(/\/api\/decks\/[^/]+\/cost$/, async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 2200));
    await route.continue();
  });
  await page.goto(address);
  await warmed(page);
  await expect(
    page.locator("[hidden]").getByText("$0.00 to complete", { exact: true })
  ).toHaveCount(3, { timeout: 20000 });
  await expect(
    page.locator("[hidden]").getByText(/Result unavailable/)
  ).toHaveCount(0);
  expect(costReads).toBe(3);
  await tabs(page).getByRole("button", { name: "Decks", exact: true }).click();
  await expect(
    main(page).getByText("$0.00 to complete", { exact: true })
  ).toHaveCount(3, { timeout: 0 });
  for (const cost of await main(page)
    .getByText("$0.00 to complete", { exact: true })
    .all())
    await expect(cost).toBeVisible({ timeout: 0 });
  expect(costReads).toBe(3);
});

test("a late first-page refresh cannot collapse conversations after pagination", async ({
  page,
}) => {
  const row = (name: string) => ({
    id: randomUUID(),
    other: {
      trader_id: randomUUID(),
      display_name: name,
      friend: false,
      handle: null,
      band: null,
      completed_trades: 0,
    },
    status: "open",
    last_message: null,
    open_trades: 0,
    waiting_on_you: 0,
    unread: false,
    archived: false,
    last_activity_at: new Date().toISOString(),
  });
  const initial = row("First-page conversation"),
    second = row("Second-page conversation"),
    third = row("Third-page conversation");
  let firstReads = 0;
  let release!: () => void, arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route(/\/api\/social\/conversations(?:\?.*)?$/, async (route) => {
    const before = new URL(route.request().url()).searchParams.get("before");
    if (!before && ++firstReads === 2) {
      arrived();
      await held;
    }
    await route.fulfill({
      json: {
        conversations:
          before === "page-3" ? [third] : before ? [second] : [initial],
        next_before: before === "page-3" ? null : before ? "page-3" : "page-2",
        suspended: false,
      },
    });
  });
  await signInAsOwner(page);
  await warmed(page);
  await tabs(page)
    .getByRole("button", { name: /^Trades/ })
    .click();
  await expect(
    main(page).getByRole("link", { name: /^First-page conversation/ })
  ).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  try {
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    await started;
    const more = main(page).getByRole("button", {
      name: "Show more conversations",
      exact: true,
    });
    await more.click();
    await expect(
      main(page).getByRole("link", { name: /^Second-page conversation/ })
    ).toBeVisible();
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/social/conversations" &&
        !new URL(response.url()).searchParams.has("before")
    );
    release();
    await (await refreshed).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(
      main(page).getByRole("link", { name: /^Second-page conversation/ })
    ).toBeVisible({ timeout: 0 });
    await expect(more).toBeEnabled();
    await tabs(page)
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    expect(firstReads).toBe(2);
    await expect(
      main(page).getByRole("link", { name: /^Second-page conversation/ })
    ).toBeVisible({ timeout: 0 });
    await more.click();
    await expect(
      main(page).getByRole("link", { name: /^Third-page conversation/ })
    ).toBeVisible();
  } finally {
    release();
  }
});

test("Settings quietly refreshes read-only lists after API changes and preserves drafts and old data on failure", async ({
  page,
  collectors,
}) => {
  const other = await collectors.signIn();
  await nameCollector(other.page, "Quiet blocked");
  await signInAsOwner(page);
  const locationName = `Quiet summary ${randomUUID()}`;
  const created = await api(page, "POST", "/api/location-tree", {
    name: locationName,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const address = page.url();
  await page.goto("about:blank");
  let blockReads = 0;
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      new URL(request.url()).pathname === "/api/social/blocks"
    )
      blockReads++;
  });
  await page.goto(address);
  await warmed(page);
  await expect(
    page
      .locator("[hidden]")
      .getByRole("region", {
        name: "Blocked collectors",
        exact: true,
        includeHidden: true,
      })
      .getByText(/^You haven't blocked anyone\./)
  ).toHaveCount(1);
  const openSettings = async () => {
    await page.getByRole("button", { name: "Account", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  };
  await expect.poll(() => blockReads).toBe(1);
  await openSettings();
  expect(blockReads).toBe(1);
  const field = main(page).getByRole("textbox", {
    name: "Display Name",
    exact: true,
  });
  await field.fill("Unsaved summary draft");
  const blocked = main(page).getByRole("region", {
    name: "Blocked collectors",
    exact: true,
  });
  const hidden = main(page).getByRole("region", {
    name: "Hidden from Friends",
    exact: true,
  });
  const forTrade = main(page).getByRole("region", {
    name: "For trade",
    exact: true,
  });
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await api(page, "POST", "/api/social/blocks", {
    collector_id: other.userId,
    idempotency_key: randomUUID(),
  });
  const changed = await api(
    page,
    "PUT",
    `/api/location-tree/${created.location.id}/hidden`,
    {
      hidden: true,
      version: created.location.version,
      idempotency_key: randomUUID(),
    }
  );
  await api(
    page,
    "PUT",
    `/api/location-tree/${created.location.id}/for-trade`,
    {
      for_trade: true,
      version: changed.location.version,
      idempotency_key: randomUUID(),
    }
  );
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listRoutes = /\/api\/(social\/blocks|location-tree)$/;
  await page.route(listRoutes, async (route) => {
    if (route.request().method() === "GET") await held;
    await route.continue();
  });
  try {
    await openSettings();
    await expect(field).toHaveValue("Unsaved summary draft", { timeout: 0 });
    await expect(blocked.getByRole("listitem")).toHaveCount(0);
    await expect(hidden.getByRole("listitem")).toHaveCount(0);
    await expect(forTrade.getByRole("listitem")).toHaveCount(0);
    await expect(main(page).getByText(/^Loading/)).toHaveCount(0);
  } finally {
    release();
  }
  await expect(
    blocked.getByRole("listitem").filter({ hasText: "Quiet blocked" })
  ).toBeVisible();
  await expect(
    hidden.getByRole("listitem").filter({ hasText: locationName })
  ).toBeVisible();
  await expect(
    forTrade.getByRole("listitem").filter({ hasText: locationName })
  ).toBeVisible();
  await expect(field).toHaveValue("Unsaved summary draft");
  await page.unroute(listRoutes);
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await page.route(listRoutes, (route) =>
    route.fulfill({ status: 503, json: {} })
  );
  const failed = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/social/blocks") && response.status() === 503
  );
  await openSettings();
  await (await failed).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  );
  await expect(
    blocked.getByRole("listitem").filter({ hasText: "Quiet blocked" })
  ).toBeVisible();
  await expect(
    hidden.getByRole("listitem").filter({ hasText: locationName })
  ).toBeVisible();
  await expect(
    forTrade.getByRole("listitem").filter({ hasText: locationName })
  ).toBeVisible();
  await expect(
    main(page)
      .getByRole("alert")
      .filter({ hasText: /temporarily unavailable/ })
  ).toHaveCount(0);
  await expect(field).toHaveValue("Unsaved summary draft");
});

test("hidden galleries do not request per-card prices or art after their warm first read", async ({
  page,
  collectors,
}) => {
  seedCatalog();
  await startAsNewOwner(collectors.pool);
  await signInAsOwner(page);
  const address = page.url();
  await page.goto("about:blank");
  const prices: string[] = [];
  const art: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/prices/editions") prices.push(request.url());
    if (url.pathname.startsWith("/api/art/")) art.push(request.url());
  });
  await page.route("**/api/catalog/editions", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        editions: body.editions.map((edition: object) => ({
          ...edition,
          image_url: "/api/art/kept-visibility.png",
        })),
      },
    });
  });
  await page.route("**/api/art/kept-visibility.png", (route) =>
    route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=",
        "base64"
      ),
    })
  );
  await page.goto(address);
  await warmed(page);
  await expect(
    page.locator("[hidden]").locator(".edition-price")
  ).not.toHaveCount(0);
  expect(prices).toEqual([]);
  expect(art).toEqual([]);
  await tabs(page)
    .getByRole("button", { name: "Catalog", exact: true })
    .click();
  await expect.poll(() => prices.length).toBeGreaterThan(0);
  await expect.poll(() => art.length).toBeGreaterThan(0);
  await expect(main(page).locator("img").first()).toBeVisible();
});
