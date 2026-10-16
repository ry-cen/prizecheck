// Ticket #252: Borrow Requests and the Loans tab (spec "Borrow Requests and Lend Offers", "Web screens"). Ash's Deck
// needs two Iono PAL 185 and a Boss's Orders PAL 172. Misty, a Friend, has a spare Iono in Unsorted, one in her Deck
// for its own line, and a spare Boss's Orders. Ash drafts a Borrow Request from the Want List (a chip, then Get from
// Friends' Ask and its stepper), reviews it in the composer and sends it for a Deck with a return-by date. Misty
// answers it on the Loans tab, leaving Boss's Orders out ("Not lent"), and her Deck's line then reads "reserved for
// Ash K" while Ash's chips no longer offer the promised Iono. A second journey drafts from a Friend's Collection and
// the card popup, is declined, edited and resent, and withdrawn. Neither side ever sees the other's Location or Deck.
// Focus never falls to the page: a sent request's toast takes it for View, asking moves it to the confirmation, Keep it
// returns it, and a step or a discarded last draft moves it to the heading. On a phone, Collection's selection strip,
// the tray and a toast stack without covering one another, and signing out forgets the drafts.
// The catalog is the Swap catalog (api/tests/want_list_swap_fixtures.py). The other collector signs in first, so the
// test's own page signs in afterwards as a new account.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./support/collectors";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

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
const tray = (page: Page) =>
  page.getByRole("region", { name: "Borrow Request drafts" });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
const title = (page: Page) => page.getByRole("heading", { level: 1 });
const loanCards = (page: Page) =>
  page.getByRole("list", { name: "Cards", exact: true }).getByRole("listitem");
const view = (page: Page) =>
  notifications(page).getByRole("button", { name: "View" });

/** Whether `upper` sits wholly above `lower` on screen, so neither covers the other. */
async function above(upper: Locator, lower: Locator): Promise<boolean> {
  const [top, bottom] = await Promise.all([
    upper.boundingBox(),
    lower.boundingBox(),
  ]);
  return !!top && !!bottom && top.y + top.height <= bottom.y;
}

/** The Borrow Request drafts this tab keeps, by sessionStorage key. */
const draftKeys = (page: Page) =>
  page.evaluate(() =>
    Object.keys(window.sessionStorage).filter((key) =>
      key.startsWith("prizecheck.borrowDrafts.")
    )
  );

test("a Borrow Request drafted on the Want List is sent for a Deck, accepted in part, and reserves the lender's copies", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and eight page checks: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const s = randomUUID().slice(0, 6);
  const misty = await collectors.signIn({ next: "/loans" });
  await nameCollector(misty.page, "Misty W");
  const lugiaName = `Lugia ${s}`;
  const lugia = await createDeck(misty.page, lugiaName);
  await hold(misty.page, lugia, ids["PAL 185"], 1); // moving a copy in lists it (migration 031)
  const mistyUnsorted = await unsorted(misty.page);
  await hold(misty.page, mistyUnsorted, ids["PAL 185"], 1);
  await hold(misty.page, mistyUnsorted, ids["PAL 172"], 1);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/decks");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${s}`;
  const charizard = await createDeck(page, deckName);
  await setLine(page, charizard, ids["PAL 185"], 2);
  await setLine(page, charizard, ids["PAL 172"], 1);
  await befriend(page, misty.page);

  // A chip asks for one copy and ticks; the tray names the draft.
  await page.goto(`${ORIGIN}/decks/want-list`);
  const chip = chips(page, "Iono").getByRole("button", { name: /^Misty W/ });
  await expect(chip).toHaveText("Misty W · 1 spare · 1 in a Deck");
  await expect(chip).toHaveAttribute("aria-pressed", "false");
  await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", "true");
  await expect(tray(page)).toContainText("Borrow Request to Misty W");
  await expect(tray(page)).toContainText("1 card");

  // Get from Friends: the panel counts what the drafts ask, Ask turns into a stepper capped at what Misty could lend.
  await views(page).getByRole("radio", { name: "Get from Friends" }).click();
  const iono = page.getByRole("region", { name: "Iono" });
  await expect(iono).toContainText("1 of 2 asked");
  const more = iono.getByRole("button", {
    name: "Increase Copies of Iono to ask Misty W for",
  });
  await more.click();
  await expect(iono).toContainText("2 of 2 asked");
  await expect(more).toBeDisabled();
  const boss = page.getByRole("region", { name: "Boss's Orders" });
  await boss
    .getByRole("button", { name: "Ask Misty W for Boss's Orders" })
    .click();
  await expect(
    boss.getByRole("group", {
      name: "Copies of Boss's Orders to ask Misty W for",
    })
  ).toBeVisible();
  await expect(tray(page)).toContainText("3 cards");
  await expectPageChecks(page, "Get from Friends with a draft");

  // On a phone the tray is one bar above the tab bar.
  await page.setViewportSize(PHONE);
  const bar = (await tray(page).boundingBox())!;
  const tabs = (await page
    .getByRole("navigation", { name: "Main views" })
    .boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(tabs.y);
  await expectPageChecks(page, "the drafts tray on a phone");
  await page.setViewportSize(DESKTOP);

  // The composer: a stepper per line, capped; For Deck; Return by; Send.
  await tray(page)
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  const composer = page.getByRole("dialog", {
    name: "Borrow Request to Misty W",
  });
  await expect(
    composer
      .getByRole("list", { name: "Cards to borrow" })
      .getByRole("listitem")
  ).toHaveCount(2);
  await expect(
    composer.getByRole("button", { name: /^Increase Copies of Iono,/ })
  ).toBeDisabled();
  await composer.getByLabel("For Deck").selectOption({ label: deckName });
  await composer.getByLabel("Return by (optional)").fill("2099-01-31");
  await expectPageChecks(page, "the Borrow Request composer");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "the Borrow Request composer on a phone");
  await page.setViewportSize(DESKTOP);
  await composer.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(composer).toBeHidden();
  await expect(tray(page)).toHaveCount(0);
  await expect(notifications(page)).toContainText(
    "Borrow Request sent to Misty W."
  );
  // The tray's Review went with the draft: the toast takes focus for View.
  await expect(view(page)).toBeFocused();
  await view(page).click();
  await expect(page).toHaveURL(/\/loans\/[0-9a-f-]+$/);
  await expect(title(page)).toHaveText("You asked Misty W for 3 cards");
  await expect(page.getByRole("main")).toContainText(
    `You're borrowing · For ${deckName} · Due back Jan 31, 2099`
  );
  await expect(page.getByRole("main")).toContainText(
    "Waiting for Misty W to answer"
  );
  const loanUrl = page.url();

  // Misty: Needs you lists it; she leaves Boss's Orders out and accepts the rest.
  const lender = misty.page;
  await lender.goto(`${ORIGIN}/loans`);
  const needsYou = lender.getByRole("region", { name: "Needs you" });
  await expect(needsYou.getByRole("link")).toHaveCount(1);
  await expect(needsYou.getByRole("link")).toContainText(
    "Ash K wants to borrow 3 cards"
  );
  await expect(lender.getByRole("main")).not.toContainText(deckName);
  await expectPageChecks(lender, "the Loans tab");
  await needsYou.getByRole("link").click();
  await expect(title(lender)).toHaveText("Ash K wants to borrow 3 cards");
  await expect(lender.getByRole("main")).not.toContainText(deckName);
  await lender
    .getByRole("button", { name: /^Decrease Copies of Boss's Orders,/ })
    .click();
  await expect(loanCards(lender).nth(1)).toContainText("Not lent");
  await expectPageChecks(lender, "answering a Borrow Request");
  await lender.setViewportSize(PHONE);
  await expectPageChecks(lender, "answering a Borrow Request on a phone");
  await lender.setViewportSize(DESKTOP);
  await lender.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(title(lender)).toHaveText("You're lending Ash K 2 cards");
  await expect(title(lender)).toBeFocused();
  await expect(loanCards(lender).nth(0)).toContainText(
    `From ${lugiaName} (1) · Unsorted (1)`
  );
  await expect(loanCards(lender).nth(1)).toContainText("Not lent");

  // Her Deck's line says the copy in it is reserved for Ash.
  await lender.goto(`${ORIGIN}/decks/${lugia}`);
  await expect(
    lender.getByRole("button", { name: /1 reserved for Ash K/ }).first()
  ).toBeVisible();

  // Ash: the Loan is accepted; Misty's Locations never show; the promised Iono is no longer offered.
  await page.goto(loanUrl);
  await expect(title(page)).toHaveText("Misty W is lending you 2 cards");
  await expect(loanCards(page).nth(1)).toContainText("Not lent");
  await expect(page.getByRole("main")).not.toContainText(lugiaName);
  await expect(page.getByRole("main")).not.toContainText("From ");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "a Loan on a phone");
  await page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: "Loans", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Pending" }).getByRole("link")
  ).toContainText("Misty W is lending you 2 cards");
  await expectPageChecks(page, "the Loans tab on a phone");
  await page.setViewportSize(DESKTOP);
  await page.goto(`${ORIGIN}/decks/want-list`);
  await expect(
    page.getByRole("list", { name: `What ${deckName} needs` })
  ).toContainText("Iono");
  await expect(chips(page, "Iono")).toHaveCount(0);

  // Misty can't remove copies she promised.
  await lender.goto(`${ORIGIN}/collection`);
  await lender
    .getByRole("region", { name: "Cards" })
    .getByRole("button", { name: /^Iono, .*Unsorted$/ })
    .click();
  await lender
    .getByRole("region", { name: "Selection" })
    .getByRole("button", { name: "Actions" })
    .click();
  await lender
    .getByRole("region", { name: "Selection" })
    .getByRole("button", { name: "Inventory Removal…" })
    .click();
  const removal = lender.getByRole("dialog", {
    name: "Remove 1 copy from your Collection",
  });
  await removal.getByRole("button", { name: "Remove 1 copy" }).click();
  await expect(removal).toContainText(
    "to a Loan, so they can't all be removed. Nothing was removed."
  );
});

test("a Borrow Request drafted from a Friend's Collection and the card popup is declined, edited and resent, and withdrawn", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import, page checks and a phone layout: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  const mistyHandle = await nameCollector(misty.page, "Misty W");
  const mistyUnsorted = await unsorted(misty.page);
  await hold(misty.page, mistyUnsorted, ids["PAL 185"], 1);
  await hold(misty.page, mistyUnsorted, ids["PAL 172"], 2);
  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await hold(page, await unsorted(page), ids["PAL 185"], 1); // to select on Collection
  await befriend(page, misty.page);

  // A Friend's Collection: Ask to borrow, then a stepper.
  await page.goto(`${ORIGIN}/friends/${mistyHandle}`);
  await page.getByRole("button", { name: "All cards", exact: true }).click();
  await page
    .getByRole("button", { name: "Ask to borrow Boss's Orders from Misty W" })
    .click();
  await expect(
    page.getByRole("group", {
      name: "Copies of Boss's Orders to ask Misty W for",
    })
  ).toBeVisible();
  await expect(tray(page)).toContainText("1 card");
  await expectPageChecks(page, "a Friend's Collection with a draft");

  // The card popup's Friends who have this.
  await page.goto(`${ORIGIN}/catalog`);
  await page
    .getByRole("region", { name: "Catalog results" })
    .getByRole("button", { name: /^Iono, PAL 185/ })
    .click();
  const popup = page.getByRole("dialog");
  await popup
    .getByRole("button", { name: "Ask to borrow Iono from Misty W" })
    .click();
  await expect(
    popup.getByRole("group", { name: "Copies of Iono to ask Misty W for" })
  ).toBeVisible();
  await popup.getByRole("button", { name: /^Close/ }).click();
  // The drafts outlive a reload in this tab.
  await page.reload();
  await expect(tray(page)).toContainText("2 cards");
  await tray(page)
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  const composer = page.getByRole("dialog", {
    name: "Borrow Request to Misty W",
  });
  await composer.getByRole("button", { name: "Send Borrow Request" }).click();
  await expect(notifications(page)).toContainText(
    "Borrow Request sent to Misty W."
  );
  await expect(view(page)).toBeFocused();

  // Another draft while that toast is up. On a phone, with Collection's selection strip up too, the three stack:
  // the strip, the tray above it, the toast above both.
  await page
    .getByRole("region", { name: "Catalog results" })
    .getByRole("button", { name: /^Iono, PAL 185/ })
    .click();
  await popup
    .getByRole("button", { name: "Ask to borrow Iono from Misty W" })
    .click();
  await popup.getByRole("button", { name: /^Close/ }).click();
  await expect(tray(page)).toContainText("1 card");
  await page.setViewportSize(PHONE);
  await page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name: "Collection", exact: true })
    .click();
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await page
    .getByRole("region", { name: "Cards" })
    .getByRole("button", { name: /^Iono, / })
    .click();
  const strip = page.getByRole("region", { name: "Selection" });
  await expect(strip).toContainText("1 copy selected");
  await expect(notifications(page)).toContainText(
    "Borrow Request sent to Misty W."
  );
  await expect.poll(() => above(tray(page), strip)).toBe(true);
  await expect.poll(() => above(notifications(page), tray(page))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(strip).toHaveCount(0);
  await page.setViewportSize(DESKTOP);

  // Discarding the last draft takes the tray and its Review with it: focus goes to the page's heading.
  await tray(page)
    .getByRole("button", { name: "Review Borrow Request to Misty W" })
    .click();
  await expect(
    composer.getByRole("button", { name: "Keep draft" })
  ).toBeVisible();
  await composer.getByRole("button", { name: "Discard" }).click();
  await expect(tray(page)).toHaveCount(0);
  await expect(title(page)).toBeFocused();

  // Misty declines, after a confirmation.
  const lender = misty.page;
  await lender.goto(`${ORIGIN}/loans`);
  await lender
    .getByRole("region", { name: "Needs you" })
    .getByRole("link")
    .click();
  const decline = lender.getByRole("button", { name: "Decline", exact: true });
  await decline.click();
  const confirm = lender.getByRole("group", { name: "Decline" });
  await expect(confirm).toContainText("Decline Ash K's request?");
  await expect(
    confirm.getByRole("button", { name: "Decline", exact: true })
  ).toBeFocused();
  // Keep it returns focus to Decline.
  await confirm.getByRole("button", { name: "Keep it" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(decline).toBeFocused();
  await decline.click();
  await confirm.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(title(lender)).toHaveText(
    "You declined Ash K's request for 2 cards"
  );
  await expect(title(lender)).toBeFocused();

  // Ash finds it under History and edits and resends it.
  await page.goto(`${ORIGIN}/loans`);
  await page.locator("summary", { hasText: "History" }).click();
  await page
    .getByRole("link", { name: /Misty W declined your request for 2 cards/ })
    .click();
  await page.getByRole("button", { name: "More for this Loan" }).click();
  await page.getByRole("menuitem", { name: "Edit and resend" }).click();
  await expect(
    composer
      .getByRole("list", { name: "Cards to borrow" })
      .getByRole("listitem")
  ).toHaveCount(2);
  await composer.getByRole("button", { name: "Send Borrow Request" }).click();
  await view(page).click();
  await expect(title(page)).toHaveText("You asked Misty W for 2 cards");

  // And withdraws it: Keep it returns focus to ⋯, and the step moves it to the heading.
  const more = page.getByRole("button", { name: "More for this Loan" });
  const withdraw = page.getByRole("group", { name: "Withdraw request" });
  await more.click();
  await page.getByRole("menuitem", { name: "Withdraw request" }).click();
  await expect(
    withdraw.getByRole("button", { name: "Withdraw request" })
  ).toBeFocused();
  await withdraw.getByRole("button", { name: "Keep it" }).click();
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole("menuitem", { name: "Withdraw request" }).click();
  await withdraw.getByRole("button", { name: "Withdraw request" }).click();
  await expect(title(page)).toHaveText("You withdrew your request to Misty W");
  await expect(title(page)).toBeFocused();
  await expect(more).toBeVisible();

  // Keep draft keeps an edited request as a draft; signing out forgets it.
  await more.click();
  await page.getByRole("menuitem", { name: "Edit and resend" }).click();
  await composer.getByRole("button", { name: "Keep draft" }).click();
  await expect(composer).toBeHidden();
  await expect(tray(page)).toContainText("2 cards");
  await expect.poll(() => draftKeys(page)).toHaveLength(1);
  await page.getByRole("button", { name: "Account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(
    page.getByRole("link", { name: "Continue with Google" })
  ).toBeVisible();
  await expect.poll(() => draftKeys(page)).toEqual([]);
});
