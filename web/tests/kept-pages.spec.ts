import {
  itemRow,
  itemOffer,
  itemPage,
  mockItemDetail,
} from "./support/item-thread-fixtures";
import { startAsNewOwner } from "./support/owner";
import {
  api,
  seedCatalog,
  nameCollector,
  befriend,
  hold,
  unsorted,
} from "./support/loans";
import { forTradeLeaf } from "./support/trades";
import { randomUUID } from "node:crypto";
import { type Page, type Response } from "@playwright/test";
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
  const warmLoan = await api(page, "POST", "/api/loans", {
    lender_id: lender.userId,
    lines: [{ edition_id: ids["PAL 185"], quantity: "1" }],
    idempotency_key: randomUUID(),
  });
  await hold(
    lender.page,
    await forTradeLeaf(lender.page, "Warm Trade Shelf"),
    ids["PAL 185"],
    1
  );
  await api(page, "POST", "/api/trades", {
    recipient_id: lender.userId,
    you_give: [],
    you_get: [{ edition_id: ids["PAL 185"], quantity: "1" }],
    message: "Warm message",
    idempotency_key: randomUUID(),
  });
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
    "/api/loans",
    "/api/trades",
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
    "Card reports",
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
        content.locator(`a[data-thread="${warmLoan.thread_id}"]`)
      ).toBeVisible({ timeout: 0 });
    else if (label === "Trades")
      await expect(
        content.getByRole("link", { name: /Warm lender/ })
      ).toBeVisible({ timeout: 0 });
    else if (label === "Card reports")
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
  const old = main(page)
    .getByRole("region", { name: "Pending" })
    .locator(`a[data-thread="${loan.thread_id}"]`);
  await expect(old).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await command(page, `/api/loans/${loan.thread_id}/withdraw`, {
    loan_id: loan.loan_id,
    revision: loan.revision,
    idempotency_key: randomUUID(),
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/api\/loans\?group=pending(?:&.*)?$/, async (route) => {
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
  await main(page).locator("summary").filter({ hasText: /^Done/ }).click();
  const closed = main(page).locator(`a[data-thread="${loan.thread_id}"]`);
  await expect(closed).toContainText("Closed");
  await closed.click();
  await expect(main(page).getByRole("heading", { level: 1 })).toHaveText(
    "You withdrew your request to Kept lender"
  );
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
  await page.route(/\/api\/loans\?group=pending(?:&.*)?$/, async (route) => {
    count++;
    if (count === 1) {
      arrived();
      await held;
      await route.fulfill({ json: [] });
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
      response.url().includes("/api/loans?group=pending") &&
      response.status() === 503
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
  await page.route(/\/api\/loans\?group=pending(?:&.*)?$/, (route) => {
    count++;
    return count === 1
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: [] });
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

test("a late quiet read cannot restore an open item after Withdraw completes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const row = itemRow("Pending withdrawal");
  let count = 0,
    closed = false;
  let releaseRead!: () => void,
    releaseCommand!: () => void,
    readStarted!: () => void,
    commandStarted!: () => void,
    readAnswered!: () => void;
  const heldRead = new Promise<void>((r) => (releaseRead = r)),
    heldCommand = new Promise<void>((r) => (releaseCommand = r));
  const reading = new Promise<void>((r) => (readStarted = r)),
    commanding = new Promise<void>((r) => (commandStarted = r)),
    answered = new Promise<void>((r) => (readAnswered = r));
  await mockItemDetail(page, row, () => closed);
  await page.route(/\/api\/trades\?.*$/, async (route) => {
    const group = new URL(route.request().url()).searchParams.get("group");
    const snapshot =
      group === "open" && !closed
        ? [row]
        : group === "done" && closed
          ? [{ ...row, section: "done", state: "closed" }]
          : [];
    const late = group === "open" && ++count === 2;
    if (late) {
      readStarted();
      await heldRead;
    }
    await route.fulfill({ json: snapshot });
    if (late) readAnswered();
  });
  await page.route(`**/api/trades/${row.id}/withdraw`, async (route) => {
    commandStarted();
    await heldCommand;
    closed = true;
    await route.fulfill({ json: itemOffer(row, true) });
  });
  await signInAsOwner(page);
  await warmed(page);
  await tabs(page)
    .getByRole("button", { name: /^Trades/ })
    .click();
  const open = main(page)
    .getByRole("list", { name: "Open Trades" })
    .locator(`a[data-thread="${row.id}"]`);
  await expect(open).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await tabs(page)
    .getByRole("button", { name: /^Trades/ })
    .click();
  await reading;
  try {
    await open.click();
    await main(page)
      .getByRole("button", { name: "More for this Trade" })
      .click();
    await page.getByRole("menuitem", { name: "Withdraw", exact: true }).click();
    await commanding;
    releaseCommand();
    await expect(open).toHaveCount(0);
    releaseRead();
    await answered;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    await expect(open).toHaveCount(0);
    await main(page).locator("summary", { hasText: "Done" }).click();
    await expect(
      main(page)
        .getByRole("list", { name: "Done Trades" })
        .locator(`a[data-thread="${row.id}"]`)
    ).toContainText("Closed");
  } finally {
    releaseCommand();
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

for (const first of ["withdraw", "page"] as const) {
  test(`pagination remains usable when ${first} completes first during Withdraw`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    const initial = itemRow("Withdraw row"),
      second = itemRow("Second page row"),
      third = itemRow("Third page row");
    const rows = [
      initial,
      ...Array.from({ length: 49 }, (_, i) =>
        itemRow(`First page filler ${i}`)
      ),
      second,
      ...Array.from({ length: 49 }, (_, i) =>
        itemRow(`Second page filler ${i}`)
      ),
      third,
    ];
    let closed = false,
      firstReads = 0,
      heldOnce = false,
      thirdReads = 0;
    let releasePage!: () => void,
      releaseCommand!: () => void,
      pageStarted!: () => void,
      commandStarted!: () => void,
      pageAnswered!: () => void;
    const heldPage = new Promise<void>((r) => (releasePage = r)),
      heldCommand = new Promise<void>((r) => (releaseCommand = r)),
      paging = new Promise<void>((r) => (pageStarted = r)),
      commanding = new Promise<void>((r) => (commandStarted = r)),
      answered = new Promise<void>((r) => (pageAnswered = r));
    await mockItemDetail(page, initial, () => closed);
    await page.route(/\/api\/trades\?.*$/, async (route) => {
      const query = new URL(route.request().url()).searchParams,
        group = query.get("group"),
        before = query.get("before");
      if (group !== "open")
        return route.fulfill({
          json:
            group === "done" && closed
              ? [{ ...initial, section: "done", state: "closed" }]
              : [],
        });
      if (!before) firstReads++;
      const snapshot = itemPage(
        rows.filter((row) => !closed || row.id !== initial.id),
        before
      );
      const hold = !!before && firstReads === 2 && !heldOnce;
      if (hold) {
        heldOnce = true;
        pageStarted();
        await heldPage;
      }
      if (before && snapshot.some((row) => row.id === third.id)) thirdReads++;
      await route.fulfill({ json: snapshot });
      if (hold) pageAnswered();
    });
    await page.route(`**/api/trades/${initial.id}/withdraw`, async (route) => {
      commandStarted();
      await heldCommand;
      closed = true;
      await route.fulfill({ json: itemOffer(initial, true) });
    });
    await signInAsOwner(page);
    await warmed(page);
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    await expect(
      main(page).locator(`a[data-thread="${third.id}"]`)
    ).toBeVisible();
    expect(thirdReads).toBe(1);
    await tabs(page)
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    await paging;
    const open = main(page).getByRole("list", { name: "Open Trades" });
    try {
      await open.locator(`a[data-thread="${initial.id}"]`).click();
      await main(page)
        .getByRole("button", { name: "More for this Trade" })
        .click();
      await page
        .getByRole("menuitem", { name: "Withdraw", exact: true })
        .click();
      await commanding;
      if (first === "withdraw") {
        releaseCommand();
        await expect(
          open.locator(`a[data-thread="${initial.id}"]`)
        ).toHaveCount(0);
        releasePage();
      } else {
        releasePage();
        await answered;
        await expect.poll(() => thirdReads).toBe(2);
        releaseCommand();
      }
      await expect(open.locator(`a[data-thread="${initial.id}"]`)).toHaveCount(
        0
      );
      await expect(open.locator(`a[data-thread="${second.id}"]`)).toBeVisible();
      await expect(open.locator(`a[data-thread="${third.id}"]`)).toBeVisible();
      await expect(open.getByRole("link")).toHaveCount(100);
      await answered;
    } finally {
      releasePage();
      releaseCommand();
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
  const pendingWarmCosts: Promise<PromiseSettledResult<void>[]>[] = [];
  const recordWarmCost = (response: Response) => {
    const path = new URL(response.url()).pathname;
    if (
      response.ok() &&
      [first, second].some((id) => path === `/api/decks/${id}/cost`)
    ) {
      pendingWarmCosts.push(
        // Observe immediately so a rejection before the drain remains available without becoming unhandled.
        Promise.allSettled([
          response.finished().then(() => {
            warmedCosts.add(path);
          }),
        ])
      );
    }
  };
  page.on("response", recordWarmCost);
  try {
    await page.goto(address);
    await warmed(page);
    await expect.poll(() => warmedCosts.size).toBe(2);
  } finally {
    page.off("response", recordWarmCost);
  }
  // Drain only after success so a stalled response cannot delay the original warm-up error.
  const results = (await Promise.all(pendingWarmCosts)).flat();
  const failure = results.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
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

test("a late first-page refresh cannot collapse items after pagination", async ({
  page,
}) => {
  const initial = itemRow("First-page item"),
    second = itemRow("Second-page item"),
    third = itemRow("Third-page item");
  const rows = [
    initial,
    ...Array.from({ length: 49 }, (_, i) => itemRow(`First filler ${i}`)),
    second,
    ...Array.from({ length: 49 }, (_, i) => itemRow(`Second filler ${i}`)),
    third,
  ];
  let firstReads = 0;
  let release!: () => void,
    arrived!: () => void,
    releaseTail!: () => void,
    tailArrived!: () => void;
  const held = new Promise<void>((r) => (release = r)),
    started = new Promise<void>((r) => (arrived = r)),
    tailHeld = new Promise<void>((r) => (releaseTail = r)),
    tailStarted = new Promise<void>((r) => (tailArrived = r));
  await page.route(/\/api\/trades\?.*$/, async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("group") !== "open") return route.fulfill({ json: [] });
    const before = query.get("before");
    if (!before && ++firstReads === 2) {
      arrived();
      await held;
    }
    const snapshot = itemPage(rows, before);
    if (
      before &&
      snapshot.some((row) => row.id === third.id) &&
      firstReads === 2
    ) {
      tailArrived();
      await tailHeld;
    }
    await route.fulfill({ json: snapshot });
  });
  await signInAsOwner(page);
  await warmed(page);
  await tabs(page)
    .getByRole("button", { name: /^Trades/ })
    .click();
  const secondRow = main(page).locator(`a[data-thread="${second.id}"]`),
    thirdRow = main(page).locator(`a[data-thread="${third.id}"]`);
  await expect(secondRow).toBeVisible();
  await expect(thirdRow).toBeVisible();
  await tabs(page)
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  try {
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    await started;
    await expect(secondRow).toBeVisible({ timeout: 0 });
    await expect(thirdRow).toBeVisible({ timeout: 0 });
    release();
    await tailStarted;
    await expect(secondRow).toBeVisible({ timeout: 0 });
    await tabs(page)
      .getByRole("button", { name: "Collection", exact: true })
      .click();
    await tabs(page)
      .getByRole("button", { name: /^Trades/ })
      .click();
    expect(firstReads).toBe(2);
    await expect(secondRow).toBeVisible({ timeout: 0 });
    releaseTail();
    await expect(main(page).locator("a[data-thread]")).toHaveCount(101);
    await expect(thirdRow).toBeVisible();
    await expect(
      main(page).getByText("Loading Trades…", { exact: true })
    ).toHaveCount(0);
  } finally {
    release();
    releaseTail();
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
