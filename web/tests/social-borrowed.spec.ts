// Ticket #254: Borrowed Copies across the app (spec "Inventory touch-points"). Ash borrows two Iono PAL 185 from his
// Friend Misty for his Deck, whose line lists one (request, accept and both handover confirmations through the API, as
// #252's and #253's specs cover). The Deck's line rises to two and reads "2 from Misty W"; his Collection counts only
// his own Boss's Orders, and its Borrowed entry lists the Iono where they are. He moves one to Unsorted from that list,
// and the Deck's line then reads "1 from Misty W". Before that, three Moves are refused (held back by the test): focus
// stays on Move, goes to the alert, or back to Move to, never to the page. The catalog is the Swap catalog
// (api/tests/want_list_swap_fixtures.py).
import { randomUUID } from "node:crypto";
import { expect, test } from "./support/collectors";
import {
  api,
  DESKTOP,
  ORIGIN,
  PHONE,
  befriend,
  createDeck,
  hold,
  lendHandedOver,
  nameCollector,
  seedCatalog,
  setLine,
  unsorted,
} from "./support/loans";
import { expectPageChecks } from "./support/page-check";
import { signInAsOwner } from "./support/sign-in";

test("borrowed copies fill the borrower's Deck, labelled with their lender, and move from the Borrowed list", async ({
  page,
  collectors,
}) => {
  // Two collectors in two contexts, a catalog import and page checks at both widths: well over 30 s on a loaded host.
  test.slow();
  const ids = seedCatalog();
  const s = randomUUID().slice(0, 6);
  const misty = await collectors.signIn({ next: "/loans" });
  const lender = misty.page;
  await nameCollector(lender, "Misty W");
  await hold(lender, await unsorted(lender), ids["PAL 185"], 2);

  await page.route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
    route.abort()
  );
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  const deckName = `Charizard ex ${s}`;
  const charizard = await createDeck(page, deckName);
  await setLine(page, charizard, ids["PAL 185"], 1);
  const ashUnsorted = await unsorted(page);
  await hold(page, ashUnsorted, ids["PAL 172"], 1);
  await befriend(page, lender);
  await lendHandedOver(lender, page, [[ids["PAL 185"], 2]], charizard);

  // The Deck: both copies are in it, the line rose to two as for owned copies, and it says whose they are.
  await page.goto(`${ORIGIN}/decks/${charizard}`);
  await expect(
    page
      .getByRole("button", {
        name: /^Iono,.*copy 2 of 2: in this Deck; 2 from Misty W$/,
      })
      .first()
  ).toBeVisible();

  // The Collection counts only Ash's own copies; the Borrowed entry lists Misty's, where they are.
  await page.goto(`${ORIGIN}/collection`);
  const main = page.getByRole("main");
  await expect(main).toContainText("1 copy · 1 edition");
  await expect(
    main.getByRole("button", { name: /Iono,.*borrowed from Misty W/ })
  ).toHaveCount(2);
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: /^Borrowed/ })).toHaveText(
    /Borrowed\s*2/
  );
  await sidebar.getByRole("button", { name: /^Borrowed/ }).click();
  const borrowed = page.getByRole("dialog", { name: "Borrowed" });
  const rows = borrowed
    .getByRole("list", { name: "Borrowed cards" })
    .getByRole("listitem");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(`2 from Misty W · In ${deckName}`);
  await expectPageChecks(page, "the Borrowed list");

  // Move one to Unsorted: the list shows each place. Move… puts focus in its form, and Cancel gives it back.
  const moveFromDeck = borrowed.getByRole("button", {
    name: `Move Iono from ${deckName}`,
  });
  await moveFromDeck.click();
  const form = borrowed.getByRole("form", { name: "Move Iono" });
  await expect(form.getByRole("combobox", { name: "Move to" })).toBeFocused();
  await form.getByRole("button", { name: "Cancel" }).click();
  await expect(moveFromDeck).toBeFocused();
  await moveFromDeck.click();
  await form.getByRole("combobox", { name: "Move to" }).selectOption({
    label: "Unsorted",
  });
  await form.getByRole("button", { name: "Decrease Copies" }).click();
  await expectPageChecks(page, "moving a borrowed card");
  const move = form.getByRole("button", { name: "Move", exact: true });
  const alert = borrowed.getByRole("alert");
  const MOVE = "**/api/loans/borrowed/move";
  // No answer: focus stays on Move, which stays enabled while the Move is out.
  await page.route(MOVE, (route) => route.abort(), { times: 1 });
  await move.click();
  await expect(alert).toHaveText("The cards couldn't be moved. Try again.");
  await expect(move).toBeFocused();
  // The Location is gone: the choices are read again and focus waits on Move to.
  const refuse = (code: string) =>
    page.route(
      MOVE,
      (route) => route.fulfill({ status: 409, json: { detail: { code } } }),
      { times: 1 }
    );
  await refuse("LOCATION_NOT_FOUND");
  await move.click();
  await expect(alert).toHaveText("That Location is gone. Choose another.");
  await expect(form.getByRole("combobox", { name: "Move to" })).toBeFocused();
  // The copies are no longer there: the form closes, the list is read again and the alert takes focus.
  await form.getByRole("combobox", { name: "Move to" }).selectOption({
    label: "Unsorted",
  });
  await refuse("NOT_ENOUGH_BORROWED");
  await move.click();
  await expect(alert).toHaveText(
    "Those copies aren't there any more. The list is up to date now."
  );
  await expect(alert).toBeFocused();
  await expect(form).toHaveCount(0);
  await expect(rows).toHaveCount(1);
  await moveFromDeck.click();
  await form.getByRole("combobox", { name: "Move to" }).selectOption({
    label: "Unsorted",
  });
  await form.getByRole("button", { name: "Decrease Copies" }).click();
  await move.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "In Unsorted" })).toContainText(
    "1 from Misty W"
  );
  await expect(rows.filter({ hasText: `In ${deckName}` })).toContainText(
    "1 from Misty W"
  );
  await expect(moveFromDeck).toBeFocused();
  await borrowed.getByRole("button", { name: "Close Borrowed" }).click();

  // On a phone the entry is in the locations drawer.
  await page.setViewportSize(PHONE);
  await page.getByRole("button", { name: "Open locations" }).click();
  await page.getByRole("button", { name: /^Borrowed/ }).click();
  await expect(rows).toHaveCount(2);
  await expectPageChecks(page, "the Borrowed list on a phone");
  await moveFromDeck.click();
  await expect(form.getByRole("combobox", { name: "Move to" })).toBeFocused();
  await expectPageChecks(page, "moving a borrowed card on a phone");
  await form.getByRole("button", { name: "Cancel" }).click();
  await borrowed.getByRole("button", { name: "Close Borrowed" }).click();
  await page.setViewportSize(DESKTOP);

  // The Deck keeps the one still in it.
  await page.goto(`${ORIGIN}/decks/${charizard}`);
  await expect(
    page
      .getByRole("button", {
        name: /^Iono,.*copy 2 of 2: not owned; 1 from Misty W$/,
      })
      .first()
  ).toBeVisible();
});

test("Location galleries mark borrowed copies, append them in All owned and move mixed selections without Undo", async ({
  page,
  collectors,
}) => {
  // Multiple collectors and both responsive page checks on a disposable stack.
  test.slow();
  const ids = seedCatalog();
  const misty = await collectors.signIn({ next: "/loans" });
  await nameCollector(misty.page, "Misty W");
  await hold(misty.page, await unsorted(misty.page), ids["PAL 185"], 2);
  await signInAsOwner(page, "/collection");
  await nameCollector(page, "Ash K");
  await befriend(page, misty.page);
  const boxName = `0 Box ${randomUUID().slice(0, 6)}`;
  const box = (
    await api(page, "POST", "/api/location-tree", {
      name: boxName,
      parent_id: null,
      parent_version: null,
      idempotency_key: randomUUID(),
    })
  ).location.id as string;
  const deck = await createDeck(page, "Borrowed Deck");
  await hold(page, box, ids["PAL 172"], 1);
  const loan = await lendHandedOver(
    misty.page,
    page,
    [[ids["PAL 185"], 2]],
    deck
  );
  await api(page, "POST", "/api/loans/borrowed/move", {
    loan_id: loan,
    edition_id: ids["PAL 185"],
    from_location_id: deck,
    to_location_id: box,
    quantity: "1",
    idempotency_key: randomUUID(),
  });
  await page.goto(`${ORIGIN}/collection`);
  const main = page.getByRole("main");
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const tiles = main.locator("[data-gallery-tile]");
  await expect(tiles).toHaveCount(3);
  await expect(main).toContainText("1 copy · 1 edition · 2 borrowed");
  await expect(tiles.nth(0)).not.toHaveAccessibleName(/borrowed from/);
  await expect(tiles.nth(1)).toHaveAccessibleName(/borrowed from Misty W/);
  await expect(tiles.nth(2)).toHaveAccessibleName(/borrowed from Misty W/);
  await sidebar.getByRole("button", { name: boxName, exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await expect(main).toContainText("1 copy · 1 edition · 1 borrowed");
  await expect(
    tiles.nth(1).getByText("From Misty W", { exact: true })
  ).toBeVisible();
  await tiles.nth(0).click();
  await tiles.nth(1).click({ modifiers: ["ControlOrMeta"] });
  const selection = page.getByRole("region", {
    name: "Selection",
    exact: true,
  });
  await expect(selection).toContainText("· 1 borrowed");
  await selection.getByRole("button", { name: /^Actions/ }).click();
  const actions = selection.getByRole("group", {
    name: "Actions",
    exact: true,
  });
  await expect(actions.getByRole("button")).toHaveCount(2);
  await actions.getByRole("button", { name: "Move…", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Move 2 copies",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Unsorted", exact: true }).click();
  await dialog
    .getByRole("button", { name: "Move 2 copies", exact: true })
    .click();
  await expect(
    page.getByText("Moved 2 copies to Unsorted.", { exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true })
  ).toHaveCount(0);
  await expect(tiles).toHaveCount(0);
  await sidebar.getByRole("button", { name: "Unsorted", exact: true }).click();
  await expect(tiles).toHaveCount(2);
  await main
    .getByRole("button", { name: /Iono,.*borrowed from Misty W/ })
    .dragTo(sidebar.getByRole("button", { name: boxName, exact: true }));
  await expect(
    page.getByText(`Moved 1 copy to ${boxName}.`, { exact: true })
  ).toBeVisible();
  await sidebar.getByRole("button", { name: boxName, exact: true }).click();
  await expect(tiles).toHaveCount(1);
  await expect(tiles.first()).toHaveAccessibleName(/borrowed from Misty W/);
  await page.setViewportSize(DESKTOP);
  await expectPageChecks(page, "borrowed Location gallery on desktop");
  await page.setViewportSize(PHONE);
  await expectPageChecks(page, "borrowed Location gallery on phone");
});
