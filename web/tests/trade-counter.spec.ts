// Ticket #278, on the proposal builder of #284: Counter a Trade Proposal. Misty proposes her Iono for Ash's Arven. Only the
// recipient sees Counter. Ash opens the Counter builder prefilled from the Trade: leaving it unchanged asks nothing, a
// cash-only Counter is refused while Misty is not open to cash offers and leaves her proposal waiting, and after he adds
// a card, takes one more released copy of Iono and sets $5 the Counter is sent. Misty's inbox shows it as a Counter, the
// Trade screen links what it answers, she accepts it, and the original reads as countered. At desktop width and at
// 375 px. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
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

/** Misty sends Ash a Trade Proposal through the API; returns its id. */
async function propose(
  page: Page,
  to: string,
  give: [string, number][],
  get: [string, number][]
): Promise<string> {
  const line = ([edition_id, n]: [string, number]) => ({
    edition_id,
    quantity: String(n),
  });
  const trade = await api(page, "POST", "/api/trades", {
    recipient_id: to,
    you_give: give.map(line),
    you_get: get.map(line),
    idempotency_key: randomUUID(),
  });
  return trade.id as string;
}

/** The Trade as `page`'s collector reads it, through the API. */
const tradeState = async (page: Page, id: string) => {
  const trade = await api(page, "GET", `/api/social/trades/${id}`);
  return {
    state: trade.state as string,
    revision: trade.revision as number,
    actions: trade.actions as string[],
  };
};

const bell = (on: Page) => on.getByRole("button", { name: /^Inbox/ });
const drawer = (on: Page) => on.getByRole("dialog", { name: "Inbox" });
const waitingOn = (on: Page) =>
  drawer(on).getByRole("region", { name: "Waiting on you" }).getByRole("link");

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
  // 1: Ash lists two Arven, Misty three Iono, and they are Friends.
  const ids = seedCatalog();
  const ash = await collectors.signIn({ contextOptions });
  await nameCollector(ash.page, "Ash K");
  const shelf = await forTradeBinder(ash.page, "Ash Shelf");
  await hold(ash.page, shelf, ids["SVI 166"], 2);

  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Misty W");
  const binder = await forTradeBinder(page, "Misty Binder");
  await hold(page, binder, ids["PAL 185"], 3);
  await hold(page, binder, ids["SVI 166 Reverse Holo"], 1);
  await befriend(page, ash.page);

  // 2: Misty proposes one Iono for one Arven.
  const original = await propose(
    page,
    await accountId(ash.page),
    [
      [ids["PAL 185"], 1],
      [ids["SVI 166 Reverse Holo"], 1],
    ],
    [[ids["SVI 166"], 1]]
  );
  const originalAddress = `${ORIGIN}/trades/${original}`;

  // 3: only the recipient may counter.
  await page.goto(originalAddress);
  await expect(heading(page)).toHaveText("Waiting for Ash K to answer");
  await expect(
    page.getByRole("main").getByRole("button", { name: "Counter", exact: true })
  ).toHaveCount(0);
  await ash.page.goto(originalAddress);
  await expect(heading(ash.page)).toHaveText(
    "Misty W sent you a Trade Proposal"
  );
  const answers = ash.page.getByRole("main");
  await expect(answers.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(
    answers.getByRole("button", { name: "Counter", exact: true })
  ).toBeVisible();
  await expect(answers.getByRole("button", { name: "Decline" })).toBeVisible();
  await expectPageChecks(ash.page, `a proposal Ash can counter at ${width}`);

  // 4: the Counter builder is prefilled, and leaving it unchanged asks nothing.
  const counterButton = () =>
    answers.getByRole("button", { name: "Counter", exact: true });
  await counterButton().click();
  await expect(ash.page).toHaveURL(`${originalAddress}/counter`);
  await expect(heading(ash.page)).toHaveText("Counter to Misty W");
  await show(ash.page, "Proposal");
  await expect(region(ash.page, "You get")).toContainText("Iono");
  await expect(region(ash.page, "You give")).toContainText("Arven");
  await expect(ash.page.getByRole("radio", { name: "No cash" })).toBeChecked();
  const sendCounter = ash.page.getByRole("button", { name: "Send Counter" });
  const backToProposal = ash.page.getByRole("link", {
    name: "Misty W's Trade Proposal",
  });
  await backToProposal.click();
  await expect(ash.page.getByRole("dialog")).toHaveCount(0);
  await expect(ash.page).toHaveURL(originalAddress);
  await counterButton().click();
  await expect(heading(ash.page)).toHaveText("Counter to Misty W");
  // An unchanged Counter can't be sent; a change makes it available.
  await expect(sendCounter).toBeDisabled();
  await expect(ash.page.getByRole("main")).toContainText(
    "Change a card, a quantity or the cash to send a Counter."
  );
  await ash.page.getByRole("radio", { name: "You pay" }).click();
  await expect(sendCounter).toBeEnabled();
  await ash.page.getByRole("radio", { name: "No cash" }).click();
  await expect(sendCounter).toBeDisabled();

  // 5: a Counter where Ash gives only cash is refused while Misty is not open to cash offers, and her proposal waits.
  await show(ash.page, "Proposal");
  await ash.page
    .getByRole("button", { name: "Decrease Arven (SVI 166) you give" })
    .click();
  await ash.page.getByRole("radio", { name: "You pay" }).click();
  const amount = ash.page.getByRole("textbox", {
    name: "Amount in US dollars",
  });
  await amount.fill("15");
  const send = ash.page.getByRole("button", { name: "Send Counter" });
  await send.click();
  await expect(ash.page.getByRole("main").getByRole("alert")).toHaveText(
    "Misty W isn't open to cash offers, so you can't give only cash. Add a card from your Trade List, or remove the cash."
  );
  expect((await tradeState(ash.page, original)).state).toBe("proposed");
  await backToProposal.click();
  const discard = ash.page.getByRole("dialog", {
    name: "Discard this Counter to Misty W?",
  });
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep editing" }).click();
  await expect(discard).toHaveCount(0);
  await expectPageChecks(ash.page, `a refused cash-only Counter at ${width}`);

  // 6: Ash gives his Arven again, takes a second Iono (Misty lists 3, one reserved by her proposal and released by the
  // Counter), sets $5 and sends.
  // Misty lists exactly one Reverse Holo Arven and the proposal holds it: Ash takes that line out, finds its tile
  // again in Their Trade List, adds it back, and takes it out for good.
  const holoLine = (verb: "Decrease" | "Increase") =>
    ash.page.getByRole("button", {
      name: `${verb} Arven (SVI 166, Reverse Holo) you get`,
    });
  await show(ash.page, "Proposal");
  await holoLine("Decrease").click();
  await expect(region(ash.page, "You get")).not.toContainText("Reverse Holo");
  await show(ash.page, "Cards");
  await ash.page.getByRole("radio", { name: "Their Trade List" }).click();
  const holoTile = tile(
    ash.page.getByRole("list", { name: "Misty W's Trade List" }),
    "get",
    "Arven, SVI 166, .+?, Reverse Holo"
  );
  await expect(holoTile).toHaveAccessibleName(/1 available/);
  await holoTile.click();
  await expect(holoTile).toHaveAccessibleName(/1 of 1 in You get/);
  await show(ash.page, "Proposal");
  await holoLine("Decrease").click();
  await expect(region(ash.page, "You get")).not.toContainText("Reverse Holo");
  await show(ash.page, "Cards");
  await ash.page.getByRole("radio", { name: "My Trade List" }).click();
  await tile(
    ash.page.getByRole("list", { name: "Your Trade List" }),
    "give",
    "Arven, SVI 166, .+?, Normal"
  ).click();
  await ash.page.getByRole("radio", { name: "Their Trade List" }).click();
  const iono = tile(
    ash.page.getByRole("list", { name: "Misty W's Trade List" }),
    "get",
    "Iono, PAL 185, .+?, Normal"
  );
  await expect(iono).toHaveAccessibleName(/1 of 3 in You get/);
  await iono.click();
  await expect(iono).toHaveAccessibleName(/2 of 3 in You get/);
  await show(ash.page, "Proposal");
  await amount.fill("5");
  await send.click();
  await expect(toast(ash.page)).toContainText("Counter sent to Misty W");
  await expect(ash.page).toHaveURL(
    new RegExp(`^${ORIGIN}/trades/[0-9a-f-]{36}$`)
  );
  await expect(ash.page).not.toHaveURL(originalAddress);
  await expect(heading(ash.page)).toHaveText("Waiting for Misty W to answer");
  await expect(ash.page.getByRole("main")).toContainText(
    "This is your Counter to Misty W's Trade Proposal."
  );
  await expect(region(ash.page, "Cash")).toContainText("You pay Misty W $5.00");
  await expectPageChecks(ash.page, `a sent Counter at ${width}`);

  // 7: Misty's inbox shows a Counter, and the Trade screen says what it answers.
  await page.goto(`${ORIGIN}/collection`);
  await expect(bell(page)).toHaveAccessibleName("Inbox, 1 waiting");
  await bell(page).click();
  await expect(waitingOn(page)).toHaveText([
    /^Ash K · Answer Counter\s*You give 2 cards · You get 1 card · Ash K pays you \$5\.00/,
  ]);
  await expectPageChecks(page, `a Counter in the inbox at ${width}`);
  await waitingOn(page).click();
  await expect(heading(page)).toHaveText("Ash K countered your Trade Proposal");
  await expect(page.getByRole("main")).toContainText(
    "This is a Counter to your Trade Proposal."
  );
  await expect(region(page, "Cash")).toContainText("Ash K pays you $5.00");

  // 8: she accepts it whole, and a Trade that is no longer waiting offers no Counter.
  await page.getByRole("main").getByRole("button", { name: "Accept" }).click();
  await expect(toast(page)).toContainText(
    "Accepted. Swap the cards in person, then confirm."
  );
  await expect(heading(page)).toHaveText("Ready to swap with Ash K");
  await expect(
    page.getByRole("main").getByRole("button", { name: "Counter", exact: true })
  ).toHaveCount(0);

  // 9: the link goes back to her original, which reads as countered.
  await page
    .getByRole("main")
    .getByRole("link", { name: "your Trade Proposal" })
    .click();
  await expect(page).toHaveURL(originalAddress);
  await expect(heading(page)).toHaveText("Ash K countered this");
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("Ash counters Misty's proposal with cash after a cash-only Counter is refused, and Misty sees the Counter in her inbox and accepts it", async ({
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
