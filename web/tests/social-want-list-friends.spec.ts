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
import { signInAsOwner } from "./support/sign-in";

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

test("Friend chips on the Want List, the Get from Friends view and Friends who have this in the card popup", async ({
  page,
  collectors,
}) => {
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
  await expect(page.getByRole("region", { name: "Boss's Orders" })).toHaveCount(
    0
  );
  await expect(page.getByRole("main")).toContainText(
    "1 card you need isn't available from any Friend."
  );
  await expect(page.getByRole("main")).not.toContainText(secret);
  await expectPageChecks(page, "Get from Friends");

  // On a phone: the switch, the panels and the chips fit without sideways scroll, with 44 px controls.
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "Get from Friends on a phone");
  await views(page).getByRole("radio", { name: "Buy" }).click();
  await expect(chips(page, "Iono").getByRole("listitem")).toHaveCount(2);
  await expectPageChecks(page, "the Want List with Friend chips on a phone");
  await page.setViewportSize({ width: 1280, height: 800 });

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
