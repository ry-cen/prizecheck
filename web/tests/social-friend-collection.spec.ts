// Ticket #250: Browse a Friend's Collection (spec "Friend-facing reads: one choke point", "Web screens"). Misty's cards
// sit loose, in a Deck and in a hidden binder; Ash opens her Collection from the Friends drawer. It shows only the
// cards she could lend now, "On my Want List" first, then All cards and a search, and never a Location or Deck name.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py): Iono PAL 185, PAL 254 and PAF 80 in one
// Reprint Group, Arven SVI 166, Boss's Orders PAL 172. The other collector signs in first, so the test's own page
// signs in afterwards as a new account.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page, Route } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import type {
  OtherCollector,
  OtherCollectorOptions,
} from "./support/collectors";
import { signInAsOwner } from "./support/sign-in";

type SignInOther = (options?: OtherCollectorOptions) => Promise<OtherCollector>;

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const PHONE = { width: 390, height: 844 };

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

async function createDeck(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  return created.location.id as string;
}

async function setLine(
  page: Page,
  deckId: string,
  edition: string,
  quantity: number
) {
  const detail = await api(page, "GET", `/api/decks/${deckId}`);
  await api(page, "POST", `/api/decks/${deckId}/deck-list/changes`, {
    revision: detail.deck_list.revision,
    idempotency_key: randomUUID(),
    changes: [{ edition_id: edition, quantity: String(quantity) }],
  });
}

/** A binder hidden from Friends; returns its id. */
async function hiddenBinder(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  await api(page, "PUT", `/api/location-tree/${location.id}/hidden`, {
    hidden: true,
    version: location.version,
    idempotency_key: randomUUID(),
  });
  return location.id;
}

const drawer = (page: Page) => page.getByRole("dialog", { name: "Friends" });

test("a Friend's Collection opens from the Friends drawer on my Want List, with All cards and a search, and names no Location or Deck", async ({
  page,
  collectors,
}) => {
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/decks" });
  const mistyHandle = await nameCollector(misty.page, "Misty W");
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  // Misty: two Iono PAL 185 and one PAL 254 loose, an Arven in a Deck for its own line, and a Boss's Orders in a
  // binder she hid from Friends.
  const loose = await unsorted(misty.page);
  await hold(misty.page, loose, ids["PAL 185"], 2);
  await hold(misty.page, loose, ids["PAL 254"], 1);
  const lugia = await createDeck(misty.page, `${secret} Deck`);
  await hold(misty.page, lugia, ids["SVI 166"], 1); // moving a copy in lists it (migration 031)
  await hold(
    misty.page,
    await hiddenBinder(misty.page, `${secret} Binder`),
    ids["PAL 172"],
    1
  );

  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  await befriend(page, misty.page);
  // Ash's Want List needs two Iono PAL 185.
  await setLine(
    page,
    await createDeck(page, "Charizard ex"),
    ids["PAL 185"],
    2
  );

  await page.reload();
  await page.getByRole("button", { name: "Friends", exact: true }).click();
  await drawer(page)
    .getByRole("button", { name: "Open Misty W's Collection" })
    .click();
  await expect(drawer(page)).toBeHidden();
  await expect(page).toHaveURL(`${ORIGIN}/friends/${mistyHandle}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Misty W");
  await expect(page.getByRole("main")).toContainText(
    `@${mistyHandle} · Cards they could lend now`
  );

  // On my Want List (the default): both Iono Printings, the other one too under Use cards I own.
  const shows = page.getByRole("group", { name: "Show cards" });
  await expect(
    shows.getByRole("button", { name: "On my Want List" })
  ).toHaveAttribute("aria-pressed", "true");
  const cards = page.getByRole("list", { name: "Misty W's cards" });
  await expect(cards.getByRole("listitem")).toHaveCount(2);
  await expect(cards.getByRole("listitem").nth(0)).toContainText("IonoPAL 185");
  await expect(cards.getByRole("listitem").nth(0)).toContainText("2 spare");
  await expect(cards.getByRole("listitem").nth(1)).toContainText("PAL 254");
  await expectPageChecks(page, "a Friend's Collection on my Want List");

  // All cards adds the Arven in her Deck, marks what Ash wants, and leaves out the hidden binder's card.
  await shows.getByRole("button", { name: "All cards" }).click();
  await expect(cards.getByRole("listitem")).toHaveCount(3);
  const arven = cards.getByRole("listitem").filter({ hasText: "Arven" });
  await expect(arven).toContainText("1 in a Deck");
  await expect(arven).not.toContainText("Want");
  await expect(
    cards.getByRole("listitem").filter({ hasText: "Want" })
  ).toHaveCount(2);
  await expect(page.getByRole("main")).not.toContainText("Boss's Orders");
  await expect(page.getByRole("main")).not.toContainText(secret);

  // Search narrows by name.
  await page
    .getByRole("searchbox", { name: "Search Misty W's cards" })
    .fill("arv");
  await expect(cards.getByRole("listitem")).toHaveCount(1);
  await expect(cards).toContainText("Arven");
  await page
    .getByRole("searchbox", { name: "Search Misty W's cards" })
    .fill("zzz");
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "No cards match “zzz”."
  );

  // On a phone: no sideways scroll and 44 px controls.
  await page.setViewportSize(PHONE);
  await page
    .getByRole("searchbox", { name: "Search Misty W's cards" })
    .fill("");
  await expect(cards.getByRole("listitem")).toHaveCount(3);
  await expectPageChecks(page, "a Friend's Collection on a phone");

  // Anyone who isn't a Friend gets one plain sentence.
  await page.goto(`${ORIGIN}/friends/nobody_${randomUUID().slice(0, 6)}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Friend's Collection"
  );
  await expect(page.getByRole("main")).toContainText(
    "This collector isn't one of your Friends."
  );
});

/** Misty with one loose Iono PAL 185 and Ash as her Friend; returns Misty's Handle. Ash's page is signed in. */
async function befriendMisty(
  page: Page,
  collectors: { signIn: SignInOther }
): Promise<string> {
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/decks" });
  const handle = await nameCollector(misty.page, "Misty W");
  await hold(misty.page, await unsorted(misty.page), ids["PAL 185"], 1);
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  await befriend(page, misty.page);
  return handle;
}

/**
 * Answers every Friend's Collection read for real but says there is a second page, and hands the second page to
 * `second`, which decides what it answers.
 */
async function withSecondPage(
  page: Page,
  second: (route: Route) => Promise<void>
) {
  await page.route("**/api/social/collections/**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("page") === "2")
      return second(route);
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, next_page: 2 } });
  });
}

const STALE_PAGE = {
  collector_id: "stale",
  handle: "stale",
  display_name: "Misty W",
  show: "all",
  cards: [
    {
      edition_id: "stale",
      name: "Stale Card",
      set_code: "XXX",
      set_name: "Stale",
      collector_number: "1",
      descriptor: {},
      image_url: null,
      spare: "1",
      in_deck: "0",
      wanted: false,
    },
  ],
  next_page: null,
};

test("a Show more answer that arrives after the filter changed is dropped", async ({
  page,
  collectors,
}) => {
  const handle = await befriendMisty(page, collectors);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await withSecondPage(page, async (route) => {
    await gate;
    await route.fulfill({ json: STALE_PAGE });
  });

  await page.goto(`${ORIGIN}/friends/${handle}`);
  await page
    .getByRole("group", { name: "Show cards" })
    .getByRole("button", { name: "All cards" })
    .click();
  const cards = page.getByRole("list", { name: "Misty W's cards" });
  await expect(cards.getByRole("listitem")).toHaveCount(1);
  const more = page.getByRole("button", { name: "Show more cards" });
  await more.click();
  const searched = page.waitForResponse(
    (response) =>
      response.url().includes("/api/social/collections/") &&
      response.url().includes("q=iono")
  );
  await page
    .getByRole("searchbox", { name: "Search Misty W's cards" })
    .fill("iono");
  await searched;
  await expect(cards).toHaveAttribute("aria-busy", "false");
  const late = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("page") === "2"
  );
  release();
  await late;
  // Let the late answer reach the page before looking for it.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => done(null)))
  );
  await expect(cards.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("main")).not.toContainText("Stale Card");
  await expect(more).toBeVisible();
});

test("Show more after the Friend is no longer a Friend says so instead of offering a retry", async ({
  page,
  collectors,
}) => {
  const handle = await befriendMisty(page, collectors);
  await withSecondPage(page, (route) =>
    route.fulfill({
      status: 404,
      json: { detail: { code: "FRIEND_NOT_FOUND" } },
    })
  );
  await page.goto(`${ORIGIN}/friends/${handle}`);
  await page
    .getByRole("group", { name: "Show cards" })
    .getByRole("button", { name: "All cards" })
    .click();
  await expect(
    page.getByRole("list", { name: "Misty W's cards" }).getByRole("listitem")
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Show more cards" }).click();
  await expect(page.getByRole("main")).toContainText(
    "This collector isn't one of your Friends."
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});
