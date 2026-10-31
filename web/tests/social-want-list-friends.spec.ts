// Ticket #251: Friends' cards on the Want List and in the card popup (spec "Friends' cards on the Want List and in
// search", "Web screens"). Ash's Deck needs two Iono PAL 185 and a Boss's Orders. Misty's Deck holds a PAL 185 for its
// own line, and Brock has a spare PAL 254 (another Printing of Iono's Reprint Group). The Want List line shows a chip
// per Friend, spare copies first; Get from Friends shows one panel per card with the need and the Decks, and sums up
// the card no Friend can lend; Catalog's card popup lists Friends who have this, at desktop and phone widths. Without
// Friends none of it shows.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py). The other collectors sign in first, so the
// test's own page signs in afterwards as a new account.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
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

type Editions = Record<"PAL 185" | "PAL 254" | "PAL 172", string>;

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

const chips = (page: Page, card: string) =>
  page.getByRole("list", { name: `Friends who can lend ${card}` });
const views = (page: Page) =>
  page.getByRole("radiogroup", { name: "Show the Want List as" });

async function wantListFriendsExample(
  page: Page,
  collectors: { signIn: SignInOther }
) {
  const ids = seedCatalog();
  const secret = `Secret ${randomUUID().slice(0, 6)}`;
  const misty = await collectors.signIn({ next: "/decks" });
  await nameCollector(misty.page, "Misty W");
  const lugia = await createDeck(misty.page, `${secret} Deck`);
  await hold(misty.page, lugia, ids["PAL 185"], 1); // moving a copy in lists it (migration 031)
  const brock = await collectors.signIn({ next: "/decks" });
  const brockHandle = await nameCollector(brock.page, "Brock S");
  await hold(brock.page, await unsorted(brock.page), ids["PAL 254"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${randomUUID().slice(0, 6)}`;
  const charizard = await createDeck(page, deckName);
  await setLine(page, charizard, ids["PAL 185"], 2);
  await setLine(page, charizard, ids["PAL 172"], 1);

  return { misty, brock, secret, brockHandle, deckName };
}

for (const width of [1280, 390]) {
  test(`Friend chips and Get from Friends preserve facts and fit ${width}px`, async ({
    page,
    collectors,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { misty, brock, secret, brockHandle, deckName } =
      await wantListFriendsExample(page, collectors);
    // Without Friends, the Want List is as it was: no chips and no switch.
    await page.goto(`${ORIGIN}/decks/want-list`);
    await expect(
      page.getByRole("list", { name: `What ${deckName} needs` })
    ).toContainText("Iono");
    await expect(views(page)).toHaveCount(0);
    await expect(chips(page, "Iono")).toHaveCount(0);

    await befriend(page, misty.page);
    await befriend(page, brock.page);
    await page.reload();
    // Exact Edition is the default: Misty's PAL 185 matches, Brock's PAL 254 does not.
    await expect(chips(page, "Iono").getByRole("listitem")).toHaveText([
      "Misty W · 1 in a Deck",
    ]);
    const accept = page
      .getByRole("list", { name: `What ${deckName} needs` })
      .getByRole("radiogroup", { name: /^Will accept for Iono/ });
    await expect(
      accept.getByRole("radio", { name: "This exact card", exact: true })
    ).toBeChecked();
    await accept
      .getByRole("radio", { name: "Any card with the same name", exact: true })
      .check();
    // Widening from the tile updates its Friend chips without a reload.
    // Spare copies first: Brock's spare PAL 254 (another Printing, so it says which), then Misty's copy in a Deck.
    await expect(chips(page, "Iono").getByRole("listitem")).toHaveText([
      "Brock S · 1 spare · PAL 254",
      "Misty W · 1 in a Deck",
    ]);
    await expect(chips(page, "Boss's Orders")).toHaveCount(0);
    await expect(views(page).getByRole("radio", { name: "Buy" })).toBeChecked();
    await expectPageChecks(page, "the Want List with Friend chips");

    // Get from Friends: one panel per card a Friend can lend, and one line for the rest.
    await views(page).getByRole("radio", { name: "Get from Friends" }).click();
    const iono = page.getByRole("region", { name: "Iono" });
    await expect(iono).toContainText(`You need 2 · ${deckName}`);
    const rows = chips(page, "Iono").getByRole("listitem");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText(`Brock S @${brockHandle}`);
    await expect(rows.nth(0)).toContainText("1 spare");
    await expect(rows.nth(0)).toContainText("PAL 254");
    await expect(rows.nth(1)).toContainText("Misty W");
    await expect(rows.nth(1)).toContainText("1 in a Deck");
    await expect(
      page.getByRole("region", { name: "Boss's Orders" })
    ).toHaveCount(0);
    await expect(page.getByRole("main")).toContainText(
      "1 card you need isn't available from any Friend."
    );
    await expect(page.getByRole("main")).not.toContainText(secret);
    await expectPageChecks(page, "Get from Friends");

    if (width <= 760) {
      await views(page).getByRole("radio", { name: "Buy" }).click();
      await expect(chips(page, "Iono").getByRole("listitem")).toHaveCount(2);
      await expectPageChecks(
        page,
        "the Want List with Friend chips on a phone"
      );
    }

    // Narrowing from the tile refetches chips and the Friends view too, without changing the need.
    await views(page).getByRole("radio", { name: "Buy" }).click();
    await accept
      .getByRole("radio", { name: "This exact card", exact: true })
      .check();
    await expect(chips(page, "Iono").getByRole("listitem")).toHaveText([
      "Misty W · 1 in a Deck",
    ]);
    await views(page).getByRole("radio", { name: "Get from Friends" }).click();
    await expect(iono).toContainText(`You need 2 · ${deckName}`);
    await expect(chips(page, "Iono").getByRole("listitem")).toHaveCount(1);
  });
}

test("Friends who have this in the card popup fit desktop and phone widths", async ({
  page,
  collectors,
}) => {
  const { misty, brock, secret, brockHandle } = await wantListFriendsExample(
    page,
    collectors
  );
  await befriend(page, misty.page);
  await befriend(page, brock.page);
  // Catalog's card popup lists Friends who have this, for a card on the Want List or not.
  await page.goto(`${ORIGIN}/catalog`);
  const results = page.getByRole("region", { name: "Catalog results" });
  await results.getByRole("button", { name: /^Iono, PAL 254/ }).click();
  const popup = page.getByRole("dialog");
  const friends = popup.getByRole("list", { name: "Friends who have this" });
  await expect(friends.getByRole("listitem")).toHaveCount(2);
  await expect(friends.getByRole("listitem").nth(0)).toContainText(
    `Brock S @${brockHandle}`
  );
  await expect(friends.getByRole("listitem").nth(1)).toContainText("Misty W");
  await expect(friends.getByRole("listitem").nth(1)).toContainText("PAL 185");
  await expect(popup).not.toContainText(secret);
  await popup.getByRole("button", { name: /^Close/ }).click();
  await results
    .getByRole("button", { name: /^Arven/ })
    .first()
    .click();
  await expect(popup).toContainText("None of your Friends have this card.");

  // On a phone the popup is a bottom sheet, and Friends who have this fits it with no sideways scroll.
  await popup.getByRole("button", { name: /^Close/ }).click();
  await page.setViewportSize(PHONE);
  await results.getByRole("button", { name: /^Iono, PAL 254/ }).click();
  await expect(friends.getByRole("listitem")).toHaveCount(2);
  await expectPageChecks(page, "Friends who have this on a phone");
});

/** Ash with a Deck that needs Iono PAL 185 and another that needs Boss's Orders, and Misty, a Friend with a spare Iono. */
async function ashWithTwoDecks(
  page: Page,
  collectors: { signIn: SignInOther }
) {
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/decks" });
  await nameCollector(misty.page, "Misty W");
  await hold(misty.page, await unsorted(misty.page), ids["PAL 185"], 1);
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  const suffix = randomUUID().slice(0, 6);
  const first = `Charizard ${suffix}`;
  const second = `Gardevoir ${suffix}`;
  await setLine(page, await createDeck(page, first), ids["PAL 185"], 1);
  await setLine(page, await createDeck(page, second), ids["PAL 172"], 1);
  await befriend(page, misty.page);
  return { first, second };
}

test("changing the Deck scope in Get from Friends keeps the switch and the Friends view while the cards load", async ({
  page,
  collectors,
}) => {
  const { first } = await ashWithTwoDecks(page, collectors);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/social/want-list-matches**", async (route) => {
    if (new URL(route.request().url()).searchParams.has("deck")) await gate;
    await route.continue();
  });

  await page.goto(`${ORIGIN}/decks/want-list`);
  const radios = views(page);
  await radios.getByRole("radio", { name: "Get from Friends" }).click();
  await expect(page.getByRole("region", { name: "Iono" })).toBeVisible();
  await page
    .getByRole("group", { name: "Show Decks" })
    .getByRole("button", { name: first })
    .click();
  // The Want List for the Deck is in; Friends' cards for it are held back.
  await expect(
    page.getByRole("heading", { name: `Want List · ${first}` })
  ).toBeVisible();
  await expect(
    radios.getByRole("radio", { name: "Get from Friends" })
  ).toBeChecked();
  await expect(page.getByRole("main")).not.toContainText("isn't available");
  await expect(
    page.getByRole("list", { name: `What ${first} needs` })
  ).toHaveCount(0);
  release();
  await expect(page.getByRole("region", { name: "Iono" })).toBeVisible();
  await expect(
    radios.getByRole("radio", { name: "Get from Friends" })
  ).toBeChecked();
});

test("a failed Friends' cards read leaves the Want List drawn without Friends", async ({
  page,
  collectors,
}) => {
  const { first } = await ashWithTwoDecks(page, collectors);
  await page.route("**/api/social/want-list-matches**", (route) =>
    route.fulfill({ status: 500, json: {} })
  );
  await page.goto(`${ORIGIN}/decks/want-list`);
  await page
    .getByRole("group", { name: "Show Decks" })
    .getByRole("button", { name: first })
    .click();
  await expect(
    page.getByRole("list", { name: `What ${first} needs` })
  ).toContainText("Iono");
  await expect(views(page)).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: /^Friends who can lend/ })
  ).toHaveCount(0);
});
