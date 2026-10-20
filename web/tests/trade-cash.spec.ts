// Ticket #277, on the proposal builder of #284: cash on a Trade Proposal, each side's estimated total, and Open to cash
// offers (Trading spec "Cash" and "Value cues"). Misty builds a proposal for Ash that asks for his Arven and adds cash
// she pays, so one side gives only cash. The first Estimated total is the real, gateway-budgeted answer and the partial
// note comes from a mocked one. Her cash amount is refused locally when it is $0, then by Ash's setting. Ash turns on
// Open to cash offers at the top of My Trade List and the same send succeeds: the Trade screen shows the Cash block and
// the liability notice, and Ash sees the proposal as a cash purchase from his side. A new builder shows no notice until
// a payer is chosen. At desktop width and at 375 px. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { BrowserContextOptions, Locator, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";

type Editions = Record<
  | "PAL 185"
  | "PAL 254"
  | "PAF 80"
  | "SVI 166"
  | "SVI 166 Reverse Holo"
  | "PAL 172",
  string
>;

/** The Swap catalog through the real catalog import (it replaces the catalog); returns the Edition ids by key. */
function seedCatalog(): Editions {
  const out = execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from want_list_swap_fixtures import print_swap_catalog\nprint_swap_catalog()",
    ],
    {
      env: { ...process.env, PYTHONPATH: "api:api/tests" },
      maxBuffer: 64 * 1024 * 1024,
    }
  ).toString();
  return JSON.parse(out.slice(out.lastIndexOf("SWAP") + 4)) as Editions;
}

async function api(
  page: Page,
  method: "GET" | "POST" | "PUT",
  path: string,
  data?: object
) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(
    true
  );
  return response.json();
}

/** Gives the signed-in collector this Display Name and a new Handle, and returns the Handle. */
async function nameCollector(page: Page, name: string): Promise<string> {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  const handle = `${name.split(" ")[0].toLowerCase()}_${tail}`;
  await api(page, "PUT", "/api/profile/display-name", {
    display_name: name,
    idempotency_key: randomUUID(),
  });
  await api(page, "PUT", "/api/profile/handle", {
    handle,
    idempotency_key: randomUUID(),
  });
  return handle;
}

async function accountId(page: Page): Promise<string> {
  return (await api(page, "GET", "/auth/session")).userId as string;
}

/** A Friend Request from `from`, accepted by `to`, through the API. */
async function befriend(from: Page, to: Page) {
  await api(from, "POST", "/api/social/friend-requests", {
    collector_id: await accountId(to),
    idempotency_key: randomUUID(),
  });
  await api(
    to,
    "POST",
    `/api/social/friend-requests/${await accountId(from)}/accept`,
    { idempotency_key: randomUUID() }
  );
}

const hold = (
  page: Page,
  location: string,
  edition: string,
  quantity: number
) =>
  api(page, "POST", "/api/holdings", {
    location_id: location,
    edition_id: edition,
    quantity: String(quantity),
    idempotency_key: randomUUID(),
  });

/** A top-level binder, marked For trade; returns its id. */
async function forTradeBinder(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
    for_trade: true,
    version: location.version,
    idempotency_key: randomUUID(),
  });
  return location.id;
}

const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1280) <= 760;

/** On a phone, selects the builder's pane (the other one is hidden, so out of the accessibility tree). */
async function show(page: Page, pane: "Proposal" | "Cards") {
  if (!isPhone(page)) return;
  await page
    .getByRole("tablist", { name: "Proposal builder" })
    .getByRole("tab", {
      name: pane === "Cards" ? "Cards" : /^Proposal/,
      exact: pane === "Cards",
    })
    .click();
}

/** The library tile that adds `card` (a regex fragment such as "Arven, SVI 166, .+?, Normal") to You get or You give. */
const tile = (scope: Locator, side: "get" | "give", card: string) =>
  scope.getByRole("button", {
    name: new RegExp(`^Add to You ${side}, ${card}, `),
  });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

const region = (page: Page, name: "You get" | "You give" | "Cash") =>
  page.getByRole("main").getByRole("region", { name, exact: true });
/** A side's estimated total: the last paragraph of its section. */
const total = (page: Page, name: "You get" | "You give") =>
  region(page, name).locator("p").last();

const NOTICE = "only records the cash amount you agree on";
const PARTIAL = "Estimated $0.50 for 1 of 2 cards";
const VALUE_URL = `${ORIGIN}/api/trades/value`;

/** The whole story, with every collector at `contextOptions`' size (the test's own page is set by its describe). */
async function story(
  page: Page,
  collectors: {
    signIn: (options?: {
      next?: string;
      contextOptions?: BrowserContextOptions;
    }) => Promise<{ page: Page }>;
  },
  contextOptions: BrowserContextOptions,
  width: string
) {
  const ids = seedCatalog();
  const ash = await collectors.signIn({ contextOptions });
  const ashHandle = await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, "Ash Shelf");
  await hold(ash.page, shelf, ids["SVI 166"], 2);

  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const binder = await forTradeBinder(page, "Misty Binder");
  await hold(page, binder, ids["PAL 185"], 3);
  await befriend(page, ash.page);

  // 2: the first total is the real answer through the gateway, which budgets and signs the route (a route missing from
  // its list answers 401). The Swap catalog has no quotes, so which figure comes back is not asserted.
  await page.goto(`${ORIGIN}/trades/new/${ashHandle}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  const answered = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/trades/value") && r.request().method() === "POST"
  );
  await show(page, "Cards");
  await tile(
    page.getByRole("list", { name: "Ash K's Trade List" }),
    "get",
    "Arven, SVI 166, .+?, Normal"
  ).click();
  expect((await answered).status()).toBe(200);
  await show(page, "Proposal");
  await expect(total(page, "You get")).toHaveText(/^(Estimat|No estimate)/);

  // 3: a mocked partial answer shows the note, and nothing is shown for the empty side.
  await page.route(VALUE_URL, (route) =>
    route.fulfill({
      json: {
        you_give: {
          status: "empty",
          display_total: "$0.00",
          priced_copies: "0",
          total_copies: "0",
        },
        you_get: {
          status: "priced",
          display_total: "$0.50",
          priced_copies: "1",
          total_copies: "2",
        },
      },
    })
  );
  await page
    .getByRole("button", { name: "Increase Arven (SVI 166) you get" })
    .click();
  await expect(total(page, "You get")).toHaveText(PARTIAL);
  await expect(region(page, "You give")).not.toContainText("Estimated");
  await page.unroute(VALUE_URL);

  // 4: cash only, refused locally for $0 and then by Ash's setting.
  await page.getByRole("radio", { name: "You pay" }).click();
  await expect(page.getByRole("main").getByRole("note")).toContainText(NOTICE);
  const amount = page.getByRole("textbox", { name: "Amount in US dollars" });
  const send = page.getByRole("button", { name: "Send Trade Proposal" });
  // A decimal comma is refused, not read as $150.00.
  await amount.fill("1,50");
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Enter an amount from $0.01 to $999,999.99."
  );
  await amount.fill("0");
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Enter an amount from $0.01 to $999,999.99."
  );
  await amount.fill("15");
  await send.click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(
    "Ash K isn't open to cash offers, so you can't give only cash. Add a card from your Trade List, or remove the cash."
  );
  await expectPageChecks(page, `the proposal builder with cash at ${width}`);

  // 5: Ash turns on Open to cash offers at the top of My Trade List.
  await ash.page.goto(`${ORIGIN}/trades/list`);
  const open = ash.page.getByRole("checkbox", { name: "Open to cash offers" });
  await expect(open).toBeVisible();
  await expect(open).not.toBeChecked();
  await open.check();
  await expect(toast(ash.page)).toContainText(
    "Friends can now send you Trade Proposals where one side gives only cash."
  );
  await ash.page.reload();
  await expect(open).toBeChecked();
  await expectPageChecks(
    ash.page,
    `My Trade List with Open to cash offers at ${width}`
  );

  // 6: the same send succeeds.
  await show(page, "Proposal");
  await send.click();
  await expect(toast(page)).toContainText("Trade Proposal sent to Ash K");
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`));
  await expect(region(page, "Cash")).toContainText("You pay Ash K $15.00");
  await expect(page.getByRole("main").getByRole("note")).toContainText(NOTICE);
  await expect(total(page, "You get")).toHaveText(/^(Estimat|No estimate)/);
  await expectPageChecks(page, `the Trade screen with cash at ${width}`);

  // 7: Ash sees a cash purchase from his side.
  await ash.page.goto(`${ORIGIN}/trades`);
  const row = ash.page
    .getByRole("list", { name: "Needs you" })
    .getByRole("listitem")
    .filter({ hasText: "Misty W would pay $15.00 for 2 cards" });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Misty W pays you $15.00");
  await row.getByRole("link").first().click();
  await expect(ash.page.getByRole("main").getByRole("note")).toBeVisible();
  await expect(region(ash.page, "Cash")).toContainText(
    "Misty W pays you $15.00"
  );

  // 8: a new builder has no notice until a payer is chosen.
  await page.goto(`${ORIGIN}/trades/new/${ashHandle}`);
  await expect(heading(page)).toHaveText("Trade Proposal to Ash K");
  await show(page, "Proposal");
  await expect(page.getByRole("main").getByRole("note")).toHaveCount(0);
  await page.getByRole("radio", { name: "You pay" }).click();
  await expect(page.getByRole("main").getByRole("note")).toHaveCount(1);
  await page.getByRole("radio", { name: "No cash" }).click();
  await expect(page.getByRole("main").getByRole("note")).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Amount in US dollars" })
  ).toHaveCount(0);
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("a cash-only proposal is refused until the Friend turns on Open to cash offers, each side shows its estimated total, and the liability notice shows only with cash", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed and several page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "desktop width");
  });
});

test.describe("phone", () => {
  const size = {
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  };
  test.use(size);

  test("the same at 375 px, with no sideways scroll and touch-sized controls", async ({
    page,
    collectors,
  }) => {
    // Two collectors in two contexts, a catalog seed and several page checks: well over 30 s on a loaded host.
    test.slow();
    await story(page, collectors, size, "375 px");
  });
});
