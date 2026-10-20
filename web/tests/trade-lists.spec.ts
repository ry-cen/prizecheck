// Ticket #269: My Trade List and a Friend's Trade List (Trading spec "For trade Locations and the Trade List",
// prototype verdict variant A). Misty marks a binder For trade, and a binder she hid from Friends too; her Trade List
// under the Trades tab shows each with its cards, says which one is hidden, and leaves out the cards she didn't mark.
// Ash, her Friend, opens her Trade List from her Collection: cards and counts grouped by card, a search, and never a
// Location name or id. Brock, who isn't her Friend, gets the plain unknown-Handle sentence. Ash's own Trade List is
// empty. At desktop width and at 375 px. The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py): Iono
// PAL 185 and PAL 254, Arven SVI 166, Boss's Orders PAL 172. The other collectors sign in first, so the test's own page
// signs in afterwards as a new account.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const HIDDEN_MARK = "Hidden from Friends · still on your Trade List";

type Editions = Record<
  "PAL 185" | "PAL 254" | "PAF 80" | "SVI 166" | "PAL 172",
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

async function unsorted(page: Page): Promise<string> {
  const tree = await api(page, "GET", "/api/location-tree");
  return (tree.locations as { id: string; name: string }[]).find(
    (location) => location.name === "Unsorted"
  )!.id;
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

/** A top-level binder, marked For trade and, with `hidden`, hidden from Friends; returns its id. */
async function forTradeBinder(
  page: Page,
  name: string,
  { hidden = false }: { hidden?: boolean } = {}
): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  let location = created.location as { id: string; version: number };
  if (hidden)
    location = (
      await api(page, "PUT", `/api/location-tree/${location.id}/hidden`, {
        hidden: true,
        version: location.version,
        idempotency_key: randomUUID(),
      })
    ).location;
  await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
    for_trade: true,
    version: location.version,
    idempotency_key: randomUUID(),
  });
  return location.id;
}

const tradesTab = (page: Page) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: "Trades", exact: true });
const heading = (page: Page) => page.getByRole("heading", { level: 1 });
const noArtwork = (page: Page) =>
  page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) => route.abort());

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
  const brock = await collectors.signIn({ contextOptions });
  await nameCollector(brock.page, "Brock T");
  const misty = await collectors.signIn({ contextOptions });
  const mistyHandle = await nameCollector(misty.page, "Misty W");
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  // Misty: two Iono PAL 185 and one PAL 254 in a For trade binder, a Boss's Orders in a For trade binder she hid from
  // Friends, and an Arven loose, which isn't For trade.
  const binder = await forTradeBinder(misty.page, `${secret} Binder`);
  await hold(misty.page, binder, ids["PAL 185"], 2);
  await hold(misty.page, binder, ids["PAL 254"], 1);
  const vault = await forTradeBinder(misty.page, `${secret} Vault`, {
    hidden: true,
  });
  await hold(misty.page, vault, ids["PAL 172"], 1);
  await hold(misty.page, await unsorted(misty.page), ids["SVI 166"], 1);

  // A: Misty's own Trade List, from the Trades tab.
  await noArtwork(misty.page);
  await misty.page.goto(`${ORIGIN}/collection`);
  await tradesTab(misty.page).click();
  await expect(misty.page).toHaveURL(`${ORIGIN}/trades`);
  await expect(heading(misty.page)).toHaveText("Trades");
  await expect(
    misty.page.getByRole("tab", { name: "My Trade List", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  const main = misty.page.getByRole("main");
  // The view has its own address too.
  await misty.page.goto(`${ORIGIN}/trades/list`);
  await expect(heading(misty.page)).toHaveText("Trades");
  await expect(
    misty.page.getByRole("tab", { name: "My Trade List", exact: true })
  ).toHaveAttribute("aria-selected", "true");
  await expect(tradesTab(misty.page)).toHaveAttribute("aria-current", "page");
  await expect(
    main.getByRole("list", { name: `${secret} Binder` })
  ).toBeVisible();
  await expect(main).toContainText(
    "Friends see the cards and counts, never where they are."
  );
  const binderPanel = main.getByRole("list", { name: `${secret} Binder` });
  await expect(binderPanel.getByRole("listitem")).toHaveCount(2);
  await expect(
    binderPanel.getByRole("listitem").filter({ hasText: "PAL 185" })
  ).toContainText("×2");
  await expect(
    binderPanel.getByRole("listitem").filter({ hasText: "PAL 254" })
  ).toContainText("×1");
  const vaultPanel = main.getByRole("region", { name: `${secret} Vault` });
  await expect(vaultPanel).toContainText(HIDDEN_MARK);
  await expect(vaultPanel).toContainText("Boss's Orders");
  await expect(
    main.getByRole("region", { name: `${secret} Binder` })
  ).not.toContainText(HIDDEN_MARK);
  await expect(main).not.toContainText("Arven");
  await expect(main).toContainText(
    "Cards promised to a Trade or Loan leave this list until they're released."
  );
  await expectPageChecks(misty.page, `My Trade List at ${width}`);

  // B: Ash, Misty's Friend, opens her Trade List from her Collection.
  await noArtwork(page);
  await signInAsOwner(page, "/collection");
  const ashHandle = await nameCollector(page, "Ash K");
  await befriend(page, misty.page);
  const pending: Promise<string>[] = [];
  page.on("response", (response) => {
    if (response.url().includes("/api/social/trade-lists/"))
      pending.push(response.text());
  });
  await page.goto(`${ORIGIN}/friends/${mistyHandle}`);
  await page
    .getByRole("main")
    .getByRole("link", { name: "See Misty W's Trade List" })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/friends/${mistyHandle}/trade-list`);
  await expect(heading(page)).toHaveText("Misty W's Trade List");
  const friendMain = page.getByRole("main");
  await expect(friendMain).toContainText(`@${mistyHandle}`);
  const iono = friendMain.getByRole("list", { name: "Iono", exact: true });
  await expect(iono.getByRole("listitem")).toHaveCount(2);
  await expect(
    iono.getByRole("listitem").filter({ hasText: "PAL 185" })
  ).toContainText("×2");
  // The hidden binder's card is on her Trade List too; where it sits isn't.
  await expect(
    friendMain.getByRole("list", { name: "Boss's Orders", exact: true })
  ).toContainText("×1");
  await expect(friendMain).not.toContainText("Arven");
  await expect(friendMain).not.toContainText(secret);
  await expect(friendMain).not.toContainText("Hidden from Friends");
  await expectPageChecks(page, `a Friend's Trade List at ${width}`);

  // Search narrows by card name.
  const search = page.getByRole("searchbox", { name: "Search by card name" });
  await search.fill("ion");
  await expect(
    friendMain.getByRole("list", { name: "Boss's Orders", exact: true })
  ).toHaveCount(0);
  await expect(iono.getByRole("listitem")).toHaveCount(2);
  await search.fill("zzz");
  await expect(friendMain.getByRole("status")).toHaveText(
    "No cards match that name."
  );
  // What reached Ash's browser names no Location of Misty's, by name or by id.
  const answers = await Promise.all(pending);
  expect(answers.length).toBeGreaterThan(0);
  for (const answer of answers) {
    expect(answer).not.toContain(secret);
    expect(answer).not.toContain(binder);
    expect(answer).not.toContain(vault);
  }

  // A Friend who lists nothing says so even while a search is typed.
  await misty.page.goto(`${ORIGIN}/friends/${ashHandle}/trade-list`);
  await expect(misty.page.getByRole("status")).toHaveText(
    "Ash K has nothing on their Trade List."
  );
  await misty.page
    .getByRole("searchbox", { name: "Search by card name" })
    .fill("zzz");
  await expect(misty.page.getByRole("status")).toHaveText(
    "Ash K has nothing on their Trade List."
  );

  // Ash's own Trade List is empty and says how to fill it.
  await tradesTab(page).click();
  await expect(page).toHaveURL(`${ORIGIN}/trades`);
  await expect(page.getByRole("main")).toContainText(
    "Your Trade List is empty. Mark a Location For trade in Collection, and its cards show here."
  );
  await page
    .getByRole("main")
    .getByRole("button", { name: "Open Collection", exact: true })
    .click();
  await expect(page).toHaveURL(`${ORIGIN}/collection`);

  // C: Brock isn't Misty's Friend, so her Trade List is the unknown-Handle page.
  await noArtwork(brock.page);
  await brock.page.goto(`${ORIGIN}/friends/${mistyHandle}/trade-list`);
  await expect(heading(brock.page)).toHaveText("Friend's Trade List");
  await expect(brock.page.getByRole("main")).toContainText(
    "This collector isn't one of your Friends."
  );
  await expect(brock.page.getByRole("main")).not.toContainText("Iono");
  await expectPageChecks(brock.page, `a stranger's Trade List at ${width}`);
}

test.describe("desktop", () => {
  const size = { viewport: { width: 1280, height: 800 } };
  test.use(size);

  test("my Trade List shows each For trade binder with its cards and says which is hidden; a Friend sees cards and counts only, and a stranger gets the unknown-Handle page", async ({
    page,
    collectors,
  }) => {
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
    await story(page, collectors, size, "375 px");
  });
});
