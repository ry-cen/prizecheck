// Ticket #253: Handover (spec "Loan steps", "Web screens"). Misty, a Friend, holds two Iono PAL 185 in her Deck and a
// Boss's Orders PAL 172 in Unsorted, and accepted Ash's Borrow Request for one of each (sent and accepted through the
// API, as #252's spec covers). She then moves the Boss's Orders into her Deck, so its pick is out of date: the Loan
// screen says so and offers Use suggested picks before Mark as handed over. She confirms, takes it back and confirms
// again; her Collection's Lent out entry lists both cards and links to the Loan, and her Deck's lines read "lent out"
// and "lent to Ash K", never "not owned". Ash confirms with Yes, I have them, and the Loan is out on both sides.
// Neither side ever sees the other's Location or Deck. Each step that lands moves focus to the Loan's heading. The
// catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py).
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

type Editions = Record<"PAL 185" | "PAL 172", string>;

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

/** Gives the signed-in collector this Display Name and a new Handle. */
async function nameCollector(page: Page, name: string) {
  // Ten random consonants: never a word the name filter refuses.
  const tail = Array.from(
    { length: 10 },
    () => "bcdfghjklmnpqrstvwxz"[randomInt(20)]
  ).join("");
  await api(page, "PUT", "/api/profile/display-name", {
    display_name: name,
    idempotency_key: randomUUID(),
  });
  await api(page, "PUT", "/api/profile/handle", {
    handle: `${name.split(" ")[0].toLowerCase()}_${tail}`,
    idempotency_key: randomUUID(),
  });
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

/** Moves `quantity` copies of an Edition from one Location to another through a Move manifest. */
async function move(
  page: Page,
  from: string,
  to: string,
  edition: string,
  quantity: number
) {
  const held = (
    (await api(page, "GET", `/api/holdings/${from}`)).holdings as {
      edition_id: string;
      version: number;
    }[]
  ).find((row) => row.edition_id === edition)!;
  const manifest = (await api(page, "POST", "/api/moves/manifests", {
    source_id: from,
  })) as { id: string };
  await api(page, "PUT", `/api/moves/manifests/${manifest.id}/items`, {
    items: [
      {
        edition_id: edition,
        quantity: String(quantity),
        expected_version: held.version,
      },
    ],
  });
  await api(page, "POST", `/api/moves/manifests/${manifest.id}/commit`, {
    destination_id: to,
    idempotency_key: randomUUID(),
  });
}

const title = (page: Page) => page.getByRole("heading", { level: 1 });
const loanCards = (page: Page) =>
  page.getByRole("list", { name: "Cards", exact: true }).getByRole("listitem");

test("both sides confirm a handover for their own inventory, after the lender fixes an out-of-date pick and takes a confirmation back", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and five page checks: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const s = randomUUID().slice(0, 6);
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  const lugiaName = `Lugia ${s}`;
  const lugia = await createDeck(lender, lugiaName);
  await hold(lender, lugia, ids["PAL 185"], 2); // moving copies in lists them (migration 031)
  const mistyUnsorted = await unsorted(lender);
  await hold(lender, mistyUnsorted, ids["PAL 172"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/loans");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${s}`;
  const charizard = await createDeck(page, deckName);
  await setLine(page, charizard, ids["PAL 185"], 1);
  await setLine(page, charizard, ids["PAL 172"], 1);
  await befriend(page, lender);

  // Ash asks for one of each for his Deck, and Misty accepts all of it: Iono from her Deck, Boss's Orders from Unsorted.
  const sent = await api(page, "POST", "/api/loans", {
    lender_id: await accountId(lender),
    lines: [
      { edition_id: ids["PAL 185"], quantity: "1" },
      { edition_id: ids["PAL 172"], quantity: "1" },
    ],
    deck_id: charizard,
    idempotency_key: randomUUID(),
  });
  const asked = await api(lender, "GET", `/api/social/loans/${sent.id}`);
  await api(lender, "POST", `/api/loans/${sent.id}/accept`, {
    revision: asked.revision,
    idempotency_key: randomUUID(),
    lines: [
      { edition_id: ids["PAL 185"], promised: "1" },
      { edition_id: ids["PAL 172"], promised: "1" },
    ],
  });
  // Then she moves the Boss's Orders into her Deck, so its pick is out of date.
  await move(lender, mistyUnsorted, lugia, ids["PAL 172"], 1);

  // Misty: the pick is flagged with where the suggested picks take it from, and the next step is Use suggested picks.
  await lender.goto(`${ORIGIN}/loans/${sent.id}`);
  await expect(title(lender)).toHaveText("You're lending Ash K 2 cards");
  const boss = loanCards(lender).nth(1);
  await expect(boss).toContainText("From Unsorted");
  await expect(boss).toContainText("Unsorted has no Boss's Orders now");
  await expect(boss).toContainText(`Suggested: From ${lugiaName}`);
  await expect(lender.getByRole("main")).toContainText(
    "A pick is out of date."
  );
  await expect(
    lender.getByRole("button", { name: "Mark as handed over" })
  ).toHaveCount(0);
  await expect(lender.getByRole("main")).not.toContainText(deckName);
  await expectPageChecks(lender, "a Loan with an out-of-date pick");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "a Loan with an out-of-date pick on a phone");
  await lender.setViewportSize(DESKTOP);
  await lender.getByRole("button", { name: "Use suggested picks" }).click();
  await expect(boss).toContainText(`From ${lugiaName}`);
  // The step's button now reads Mark as handed over: focus goes to the heading instead, never onto the next step.
  await expect(title(lender)).toBeFocused();
  await expect(boss).not.toContainText("has no");
  await expect(loanCards(lender).nth(0)).toContainText(`From ${lugiaName}`);

  // She marks it handed over, takes that back, and marks it again: then she waits for Ash.
  await lender.getByRole("button", { name: "Mark as handed over" }).click();
  await expect(lender.getByRole("main")).toContainText(
    "Waiting for Ash K to confirm"
  );
  await expect(title(lender)).toBeFocused();
  await lender.getByRole("button", { name: "More for this Loan" }).click();
  await lender
    .getByRole("menuitem", { name: "Take back my confirmation" })
    .click();
  await lender.getByRole("button", { name: "Mark as handed over" }).click();
  await expect(lender.getByRole("main")).toContainText(
    "Waiting for Ash K to confirm"
  );

  // Her Collection: Lent out counts the copies, and its list links to the Loan; her Deck's line says where they are.
  await lender.goto(`${ORIGIN}/collection`);
  await expect(lender.getByRole("main")).toContainText("· 2 lent out");
  const sidebar = lender.getByRole("complementary", { name: "Sidebar" });
  await sidebar.getByRole("button", { name: /^Lent out/ }).click();
  const lentOut = lender.getByRole("dialog", { name: "Lent out" });
  const lentCards = lentOut
    .getByRole("list", { name: "Lent cards" })
    .getByRole("link");
  await expect(lentCards).toHaveCount(2);
  await expect(lentCards.filter({ hasText: "Iono" })).toContainText(
    "1 lent to Ash K"
  );
  await expect(lentCards.filter({ hasText: "Boss's Orders" })).toContainText(
    "1 lent to Ash K"
  );
  await expectPageChecks(lender, "the Lent out list");
  await lentOut.getByRole("button", { name: "Close Lent out" }).click();
  await lender.setViewportSize(PHONE);
  await lender.getByRole("button", { name: "Open locations" }).click();
  await lender.getByRole("button", { name: /^Lent out/ }).click();
  await expect(lentOut).toBeVisible();
  await expectPageChecks(lender, "the Lent out list on a phone");
  await lentCards.filter({ hasText: "Iono" }).click();
  await expect(lender).toHaveURL(`${ORIGIN}/loans/${sent.id}`);
  await expect(title(lender)).toHaveText("You're lending Ash K 2 cards");
  await lender.setViewportSize(DESKTOP);
  await lender.goto(`${ORIGIN}/decks/${lugia}`);
  await expect(
    lender.getByRole("button", { name: /lent out; 1 lent to Ash K$/ }).first()
  ).toBeVisible();
  // Lent copies are missing from the Deck, but still hers: never "not owned", never drawn as cards to buy ($).
  await expect(
    lender.getByRole("button", { name: /^(Iono|Boss's Orders),.*not owned/ })
  ).toHaveCount(0);
  await lender.getByRole("radio", { name: "Stacked" }).click();
  const bossPile = lender.getByRole("button", { name: /^Boss's Orders,/ });
  await expect(bossPile).toContainText("×1 1 lent");
  await expect(bossPile).not.toContainText("$");

  // Ash: the Loan needs him; Yes, I have them puts it out on both sides.
  await page.goto(`${ORIGIN}/loans`);
  const needsYou = page.getByRole("region", { name: "Needs you" });
  await expect(needsYou.getByRole("link")).toContainText(
    "Misty W says they handed you 2 cards"
  );
  await needsYou.getByRole("link").click();
  await expect(page.getByRole("main")).toContainText(
    `You're borrowing · For ${deckName}`
  );
  await expect(page.getByRole("main")).not.toContainText(lugiaName);
  await expect(page.getByRole("main")).not.toContainText("Unsorted");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "a handover to confirm on a phone");
  await page.setViewportSize(DESKTOP);
  await page.getByRole("button", { name: "Yes, I have them" }).click();
  await expect(title(page)).toHaveText("You have 2 cards of Misty W's");
  await expect(
    page.getByRole("button", { name: "More for this Loan" })
  ).toHaveCount(0);
  await page.getByRole("link", { name: "All Loans" }).click();
  await expect(
    page.getByRole("region", { name: "Out now" }).getByRole("link")
  ).toContainText("You have 2 cards of Misty W's");

  await lender.goto(`${ORIGIN}/loans/${sent.id}`);
  await expect(title(lender)).toHaveText("Ash K has 2 cards of yours");
  await expect(lender.getByRole("main")).not.toContainText("Waiting for");
  await expect(
    lender.getByRole("button", { name: "More for this Loan" })
  ).toHaveCount(0);
});
