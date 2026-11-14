// Ticket #175: batch add and Add mode (spec "Catalog": Add mode; "Collection": Add cards; "Batch add and Gather
// Undo"). Catalog's Browse / Add to a Location switch; the Add mode bar stuck to the top (Adding to [Location], the
// queued cards, Clear and Add N cards, which a phone shows once something is queued); every tile's + that becomes a
// −/N/+ stepper, with queued tiles outlined; the popup's Add row starting on the target; Add N cards as one batch add
// with one Undo toast; and Collection's Add cards opening the same gallery over Collection, set to the open Location
// or with a Location picker, closing on Add N cards and leaving the collector in the Location with one Undo toast.
// The shared page check runs on each state at 1280×800 and 375×812, dialogs open and closed.
import { expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";
import { test, artUpstream } from "./support/art-upstream";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
/** Five tiles (api/tests/test_catalog_browse.py seed_popup): Bulbasaur Normal and Reverse Holo (MEG 001), Rare Candy
 * (MEG 125) and Switch (MEG 130), then Professor's Research (Professor Juniper). */
function seedPopup() {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_popup\nseed_popup()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

/** 70 Printings with one Edition each, newest set first (seed_gallery): more than the first page of 60. */
function seedGallery() {
  execFileSync(
    ".venv/bin/python",
    ["-c", "from test_catalog_browse import seed_gallery\nseed_gallery()"],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

/** Signs in at /catalog as a new owner, who owns nothing yet, and lands on Catalog. */
async function signIn(page: Page) {
  // Card art comes through the art route; the API fetches it from the art stub (a 1×1 PNG).
  (await artUpstream()).reset();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/catalog");
  await expect(page).toHaveURL(/\/catalog$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Catalog");
}

type TreeNode = { id: string; name: string; version: number };

/** Makes a Location through the API (inside `parentId`, an empty Storage Leaf that becomes a folder) and returns
 * its id. */
async function createLocation(
  page: Page,
  name: string,
  parentId: string | null = null
): Promise<string> {
  let parentVersion: number | null = null;
  if (parentId) {
    const tree = await page.request.get(`${ORIGIN}/api/location-tree`);
    parentVersion = (
      (await tree.json()) as { locations: TreeNode[] }
    ).locations.find((node) => node.id === parentId)!.version;
  }
  const response = await page.request.post(`${ORIGIN}/api/location-tree`, {
    headers: { origin: ORIGIN },
    data: {
      name,
      parent_id: parentId,
      parent_version: parentVersion,
      idempotency_key: randomUUID(),
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { location: TreeNode }).location.id;
}

/** Every Holding in a Location, as "<quantity> <name>" lines, sorted. */
async function held(page: Page, locationId: string): Promise<string[]> {
  const response = await page.request.get(
    `${ORIGIN}/api/holdings/${locationId}`
  );
  const { holdings } = (await response.json()) as {
    holdings: { printing_name: string; quantity: string }[];
  };
  return holdings
    .map((holding) => `${holding.quantity} ${holding.printing_name}`)
    .sort();
}

async function ownerRevision(page: Page): Promise<number> {
  const response = await page.request.get(`${ORIGIN}/api/collection/revision`);
  return ((await response.json()) as { owner_revision: number }).owner_revision;
}

const results = (scope: Page | Locator) =>
  scope.getByRole("region", { name: "Catalog results" });
/** A Catalog tile by the start of its accessible name: "Name, Set Number, Set name, Variant, …". */
const tile = (scope: Page | Locator, start: string): Locator =>
  results(scope).getByRole("button", {
    name: new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  });
const more = (scope: Page | Locator, words: string) =>
  results(scope).getByRole("button", {
    name: `One more ${words}`,
    exact: true,
  });
const fewer = (scope: Page | Locator, words: string) =>
  results(scope).getByRole("button", {
    name: `One fewer ${words}`,
    exact: true,
  });
const addBar = (scope: Page | Locator) =>
  scope.getByRole("region", { name: "Add to a Location" });
const queued = (scope: Page | Locator) =>
  addBar(scope)
    .getByRole("list", { name: "Cards to add" })
    .getByRole("listitem");
const mode = (page: Page, name: string) =>
  page
    .getByRole("radiogroup", { name: "Catalog mode" })
    .getByRole("radio", { name });
/** The toast's message in the app's one toast host. */
const toast = (page: Page) =>
  page.getByRole("region", { name: "Notifications" }).getByRole("paragraph");
const undo = (page: Page) =>
  page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: "Undo", exact: true });
const addRow = (page: Page) =>
  page
    .getByRole("dialog")
    .last()
    .getByRole("group", { name: "Add to Collection" });
const sidebarButton = (page: Page, name: string) =>
  page
    .getByRole("complementary", { name: "Sidebar" })
    .getByRole("navigation", { name: "Locations" })
    .getByRole("button", { name, exact: true });
const cards = (page: Page) =>
  page.getByRole("region", { name: "Cards" }).getByRole("button");

const BULBASAUR = "Bulbasaur MEG 001 Normal";
const CANDY = "Rare Candy MEG 125 Normal";
const SWITCH = "Switch MEG 130 Normal";

/** What one batch add request meets, in order: "lost" commits on the server and loses the answer, "dropped" never
 * reaches it, "pass" goes through, and an object is the answer instead. Returns the idempotency keys it saw. */
type Step = "lost" | "dropped" | "pass" | { status: number; body: object };
async function scriptBatch(page: Page, steps: Step[]): Promise<string[]> {
  const keys: string[] = [];
  await page.route("**/api/holdings/batch", async (route) => {
    keys.push(
      (route.request().postDataJSON() as { idempotency_key: string })
        .idempotency_key
    );
    const step = steps[keys.length - 1] ?? "pass";
    if (step === "lost") {
      await route.fetch();
      await route.abort("failed");
    } else if (step === "dropped") await route.abort("failed");
    else if (step === "pass") await route.continue();
    else
      await route.fulfill({
        status: step.status,
        contentType: "application/json",
        body: JSON.stringify(step.body),
      });
  });
  return keys;
}

async function unsortedId(page: Page): Promise<string> {
  const response = await page.request.get(`${ORIGIN}/api/location-tree`);
  return ((await response.json()) as { locations: TreeNode[] }).locations.find(
    (node) => node.name === "Unsorted"
  )!.id;
}

const MAY_HAVE_COMPLETED =
  "Adding may have completed. Press Add again to check safely.";

/** Whether the page asks before a reload or close (the beforeunload event is cancelled). */
const warns = (page: Page) =>
  page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Add mode queues cards from the tiles, and Add N cards adds them to one Location with one Undo", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const trade = await createLocation(page, "Trade box");
    await page.reload();
    await expect(results(page).getByRole("listitem")).toHaveCount(5);
    await expect(more(page, BULBASAUR)).toHaveCount(0);

    // The switch in the page header turns Add mode on: the bar, set to Unsorted, with nothing queued yet.
    await mode(page, "Add to a Location").click();
    await expect(mode(page, "Add to a Location")).toHaveAttribute(
      "aria-checked",
      "true"
    );
    const bar = addBar(page);
    await expect(bar).toContainText("Adding to");
    await expect(bar).toContainText("Use + on cards, then add them together.");
    const picker = bar.getByRole("combobox", { name: "Location to add to" });
    await expect(picker.locator("option:checked")).toHaveText("Unsorted");
    await expect(bar.getByRole("button", { name: "Clear" })).toBeDisabled();
    await expect(bar.getByRole("button", { name: "Add cards" })).toBeDisabled();
    await expectPageChecks(page, "Catalog, Add mode, nothing queued");
    await picker.selectOption({ label: "Trade box" });

    // + queues a copy and becomes − N +; the tile is outlined and says how many it will add.
    expect(await warns(page)).toBe(false);
    await more(page, BULBASAUR).click();
    // The queue lives only on this page: reload or close asks first while cards wait in it.
    expect(await warns(page)).toBe(true);
    await more(page, BULBASAUR).click();
    await expect(
      results(page).getByRole("group", { name: `${BULBASAUR}: 2 to add` })
    ).toBeVisible();
    await expect(
      tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal")
    ).toHaveAccessibleName(
      "Bulbasaur, MEG 001, Mega Evolution, Normal, not owned, 2 to add"
    );
    await more(page, CANDY).click();
    await expect(queued(page)).toHaveText([`2× ${BULBASAUR}`, `1× ${CANDY}`]);
    await fewer(page, CANDY).click();
    await expect(fewer(page, CANDY)).toHaveCount(0);
    await expect(queued(page)).toHaveText([`2× ${BULBASAUR}`]);
    await more(page, CANDY).click();

    // A new search keeps the queue.
    const search = page.getByRole("searchbox", { name: "Search the catalog" });
    await search.fill("Switch");
    await expect(results(page).getByRole("listitem")).toHaveCount(1);
    await more(page, SWITCH).click();
    await expect(queued(page)).toHaveText([
      `2× ${BULBASAUR}`,
      `1× ${CANDY}`,
      `1× ${SWITCH}`,
    ]);
    await search.fill("");
    await expect(results(page).getByRole("listitem")).toHaveCount(5);
    await expect(fewer(page, BULBASAUR)).toBeVisible();
    await expectPageChecks(page, "Catalog, Add mode, cards queued");

    // The popup still opens, and its Add row starts on the target Location.
    await tile(
      page,
      "Bulbasaur, MEG 001, Mega Evolution, Reverse Holo"
    ).click();
    await expect(
      addRow(page).getByRole("combobox", { name: "Location" })
    ).toHaveValue(trade);
    await expectPageChecks(page, "Catalog, Add mode, card popup open");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Add N cards is one batch add: one owner revision, one Undo toast, and the queue empties.
    const revision = await ownerRevision(page);
    await bar.getByRole("button", { name: "Add 4 cards" }).click();
    await expect(toast(page)).toHaveText("Added 4 cards to Trade box.");
    await expect(undo(page)).toBeVisible();
    await expect(bar).toContainText("Use + on cards, then add them together.");
    expect(await warns(page)).toBe(false);
    await expect(
      tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal")
    ).toHaveAccessibleName(
      "Bulbasaur, MEG 001, Mega Evolution, Normal, 2 owned"
    );
    expect(await held(page, trade)).toEqual([
      "1 Rare Candy",
      "1 Switch",
      "2 Bulbasaur",
    ]);
    expect(await ownerRevision(page)).toBe(revision + 1);
    await expectPageChecks(page, "Catalog, Add mode, Undo toast");

    // Undo takes exactly those copies out again, and the tiles drop back.
    await undo(page).click();
    await expect(toast(page)).toHaveText(
      "Undo removed 4 cards from Trade box."
    );
    expect(await held(page, trade)).toEqual([]);
    await expect(
      tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal")
    ).toHaveAccessibleName(
      "Bulbasaur, MEG 001, Mega Evolution, Normal, not owned"
    );

    // Browse hides the bar and the quick buttons.
    await mode(page, "Browse").click();
    await expect(addBar(page)).toHaveCount(0);
    await expect(more(page, BULBASAUR)).toHaveCount(0);
  });

  test("Collection's Add cards opens the gallery set to the open Location, and Add N cards leaves you there with one Undo", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const trade = await createLocation(page, "Trade box");
    await page.goto(`${ORIGIN}/collection`);
    await sidebarButton(page, "Trade box").click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Trade box"
    );
    const opener = page.getByRole("button", { name: "Add cards", exact: true });
    await opener.click();
    const add = page.getByRole("dialog", { name: "Add cards to Trade box" });
    await expect(add).toBeVisible();
    await expect(
      add.getByRole("searchbox", { name: "Search the catalog" })
    ).toBeFocused();
    // Set to the open Location: no picker.
    await expect(addBar(add)).toContainText("Adding to Trade box");
    await expect(
      addBar(add).getByRole("combobox", { name: "Location to add to" })
    ).toHaveCount(0);
    await expect(results(add).getByRole("listitem")).toHaveCount(5);
    await expectPageChecks(page, "Collection, Add cards");

    await more(add, BULBASAUR).click();
    await more(add, BULBASAUR).click();
    await more(add, SWITCH).click();
    // The popup opens over it, its Add row on Trade box; Escape closes the popup only.
    await tile(add, "Switch, MEG 130").click();
    await expect(
      addRow(page).getByRole("combobox", { name: "Location" })
    ).toHaveValue(trade);
    await expectPageChecks(page, "Collection, Add cards with the card popup");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Switch" })).toHaveCount(0);
    await expect(add).toBeVisible();

    await addBar(add).getByRole("button", { name: "Add 3 cards" }).click();
    await expect(add).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Trade box"
    );
    await expect(toast(page)).toHaveText("Added 3 cards to Trade box.");
    await expect(undo(page)).toBeVisible();
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByRole("main")).toContainText("3 copies · 2 editions");
    await expect(opener).toBeFocused();
    await expectPageChecks(page, "Collection, after Add cards");

    await undo(page).click();
    await expect(toast(page)).toHaveText(
      "Undo removed 3 cards from Trade box."
    );
    await expect(cards(page)).toHaveCount(0);
  });

  test("Collection popup Undo is reachable while Add cards stays open", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await createLocation(page, "Trade box");
    await page.goto(`${ORIGIN}/collection`);
    await sidebarButton(page, "Trade box").click();
    await page.getByRole("button", { name: "Add cards", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add cards to Trade box" });
    await tile(add, "Switch, MEG 130").click();
    const popup = page.getByRole("dialog", { name: "Switch", exact: true });
    await addRow(page)
      .getByRole("button", { name: "Add 1", exact: true })
      .click();
    const popupUndo = popup.getByRole("button", { name: "Undo", exact: true });
    await expect(popupUndo).toBeVisible();
    await expect(add).toBeVisible();
    await expect(popup).toContainText("1 copy owned");
    await popupUndo.click();
    await expect(
      popup.getByText("Undo removed 1 card from Trade box.")
    ).toBeVisible();
    await expect(popupUndo).toHaveCount(0);
    await expect(
      addRow(page).getByRole("button", { name: "Add 1", exact: true })
    ).toBeFocused();
    await expect(popup).not.toContainText("1 copy owned");
    await expectPageChecks(
      page,
      "Collection, popup Undo while Add cards stays open"
    );
    await page.keyboard.press("Escape");
    await expect(add).toBeVisible();
    await expect(tile(add, "Switch, MEG 130")).toHaveAccessibleName(
      "Switch, MEG 130, Mega Evolution, Normal, not owned"
    );
    await page.keyboard.press("Escape");
    await expect(add).toHaveCount(0);
    await expect(cards(page)).toHaveCount(0);
  });

  test("Add N cards and its Undo restart the walk quietly, and Add cards loads more cards as its dialog scrolls", async ({
    page,
  }) => {
    seedGallery();
    await signIn(page);
    const items = results(page).getByRole("listitem");
    await expect(items).toHaveCount(60);
    await mode(page, "Add to a Location").click();
    // Add N cards and its Undo each move the owner revision, so the walk's next page answers 409.
    await items
      .nth(0)
      .getByRole("button", { name: /^One more / })
      .click();
    await addBar(page).getByRole("button", { name: "Add 1 card" }).click();
    await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");
    await expect(items.nth(0).getByRole("button").first()).toHaveAccessibleName(
      /, 1 owned$/
    );
    await undo(page).click();
    await expect(toast(page)).toHaveText("Undo removed 1 card from Unsorted.");
    await expect(items.nth(0).getByRole("button").first()).toHaveAccessibleName(
      /, not owned$/
    );
    // Scrolling on starts the walk again, as deep as it was, with no "Your collection changed": both changes were the
    // collector's own.
    await items.last().scrollIntoViewIfNeeded();
    await expect(items).toHaveCount(70);
    await expect(items.nth(0).getByRole("button").first()).toHaveAccessibleName(
      /, not owned$/
    );
    const status = page.getByRole("main").getByRole("status");
    await expect(page.getByRole("main")).toContainText("of 70 cards");
    await expect(status).not.toContainText("collection changed");

    // Inside Collection's Add cards the gallery scrolls in the dialog, and the next page loads as its end nears.
    await page.goto(`${ORIGIN}/collection`);
    await page.getByRole("button", { name: "Add cards", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add cards", exact: true });
    const inDialog = results(add).getByRole("listitem");
    await expect(inDialog).toHaveCount(60);
    await inDialog.last().scrollIntoViewIfNeeded();
    await expect(inDialog).toHaveCount(70);
  });

  test("editing the queue after an add that may have completed settles that add first, so no copy is added twice (#175)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await mode(page, "Add to a Location").click();
    // The first batch add commits on the server, but its answer never arrives.
    let dropped = false;
    const keys: string[] = [];
    await page.route("**/api/holdings/batch", async (route) => {
      keys.push(
        (route.request().postDataJSON() as { idempotency_key: string })
          .idempotency_key
      );
      if (!dropped) {
        dropped = true;
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    const bar = addBar(page);
    await more(page, BULBASAUR).click();
    await bar.getByRole("button", { name: "Add 1 card" }).click();
    await expect(bar).toContainText(
      "Adding may have completed. Press Add again to check safely."
    );

    // The collector edits the queue, then presses Add: the first batch is replayed under its own key, and the
    // edited one is not sent.
    await more(page, CANDY).click();
    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");
    await expect(bar).toContainText(
      "Your earlier add finished: added 1 card to Unsorted. Press Add for the cards still queued."
    );
    // Only the settled card leaves the queue: pressing Add again must not add it twice.
    await expect(queued(page)).toHaveText([`1× ${CANDY}`]);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    const response = await page.request.get(`${ORIGIN}/api/location-tree`);
    const unsorted = (
      (await response.json()) as { locations: TreeNode[] }
    ).locations.find((node) => node.name === "Unsorted")!.id;
    expect(await held(page, unsorted)).toEqual(["1 Bulbasaur"]);

    // What is still queued goes on its own key when the collector presses Add again.
    await bar.getByRole("button", { name: "Add 1 card" }).click();
    // The earlier toast has identical text: wait for this request before checking its key.
    await expect.poll(() => keys.length).toBe(3);
    await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");
    await expect(bar).not.toContainText("Your earlier add finished");
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
    await expect
      .poll(() => held(page, unsorted))
      .toEqual(["1 Bulbasaur", "1 Rare Candy"]);
  });

  test("an add whose resend is still unknown sends nothing new, and the queue stays as it was (#196)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await mode(page, "Add to a Location").click();
    const keys = await scriptBatch(page, ["lost", "dropped"]);
    const bar = addBar(page);
    await more(page, BULBASAUR).click();
    await bar.getByRole("button", { name: "Add 1 card" }).click();
    await expect(bar).toContainText(MAY_HAVE_COMPLETED);

    await more(page, CANDY).click();
    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect(bar).toContainText(MAY_HAVE_COMPLETED);
    // Only the first batch was sent again, under its own key; the edited queue waits.
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`, `1× ${CANDY}`]);
    expect(await held(page, await unsortedId(page))).toEqual(["1 Bulbasaur"]);

    // Once the resend gets through, the first batch settles and only it leaves the queue.
    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect(bar).toContainText("Your earlier add finished");
    await expect(queued(page)).toHaveText([`1× ${CANDY}`]);
    expect(keys[2]).toBe(keys[0]);
    expect(await held(page, await unsortedId(page))).toEqual(["1 Bulbasaur"]);
  });

  test("a Clear pressed while the resend is in flight stays cleared when the earlier add settles (#196)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await mode(page, "Add to a Location").click();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/holdings/batch", async (route) => {
      calls += 1;
      if (calls === 1) {
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await gate;
      await route.continue();
    });
    const bar = addBar(page);
    await more(page, BULBASAUR).click();
    await bar.getByRole("button", { name: "Add 1 card" }).click();
    await expect(bar).toContainText(MAY_HAVE_COMPLETED);

    await more(page, CANDY).click();
    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect.poll(() => calls).toBe(2);
    await bar.getByRole("button", { name: "Clear" }).click();
    await expect(queued(page)).toHaveCount(0);
    release();
    await expect(bar).toContainText("Your earlier add finished");
    await expect(queued(page)).toHaveCount(0);
    await expect(bar).not.toContainText("Press Add for the cards still queued");
  });

  test("when the handler refuses the earlier add for good, the edited queue goes ahead under its own key (#196)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await mode(page, "Add to a Location").click();
    const keys = await scriptBatch(page, [
      "dropped",
      { status: 422, body: { detail: { code: "QUANTITY_OVERFLOW" } } },
    ]);
    const bar = addBar(page);
    await more(page, BULBASAUR).click();
    await bar.getByRole("button", { name: "Add 1 card" }).click();
    await expect(bar).toContainText(MAY_HAVE_COMPLETED);

    await more(page, CANDY).click();
    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect(toast(page)).toHaveText("Added 2 cards to Unsorted.");
    await expect(queued(page)).toHaveCount(0);
    expect(keys).toHaveLength(3);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    await expect
      .poll(async () => held(page, await unsortedId(page)))
      .toEqual(["1 Bulbasaur", "1 Rare Candy"].sort());
  });

  test("a gateway's 401 during the resend keeps the earlier add pending, and the next press resends it (#196)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await mode(page, "Add to a Location").click();
    const keys = await scriptBatch(page, ["lost", { status: 401, body: {} }]);
    const bar = addBar(page);
    await more(page, BULBASAUR).click();
    await bar.getByRole("button", { name: "Add 1 card" }).click();
    await expect(bar).toContainText(MAY_HAVE_COMPLETED);

    await more(page, CANDY).click();
    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect(bar).toContainText(MAY_HAVE_COMPLETED);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);

    await bar.getByRole("button", { name: "Add 2 cards" }).click();
    await expect(bar).toContainText("Your earlier add finished");
    expect(keys).toHaveLength(3);
    expect(keys[2]).toBe(keys[0]);
    expect(await held(page, await unsortedId(page))).toEqual(["1 Bulbasaur"]);
  });

  test("in the popup, an add that may have completed is settled by the next press, even after closing it, and says which card (#196)", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const keys = await scriptBatch(page, ["lost"]);
    const open = () =>
      tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal").click();
    await open();
    const dialog = page.getByRole("dialog", { name: "Bulbasaur" });
    await addRow(page).getByRole("button", { name: "Add 1" }).click();
    await expect(dialog).toContainText(
      "Add may have completed. Press Add again to check safely."
    );

    // Another Edition picked: the notice stays and names the Edition it is about.
    await dialog
      .getByRole("group", { name: "Editions" })
      .getByRole("button")
      .nth(1)
      .click();
    await expect(dialog).toContainText(
      "Adding Bulbasaur Normal may have completed. Choose it again and press Add to check safely."
    );
    await dialog
      .getByRole("group", { name: "Editions" })
      .getByRole("button")
      .nth(0)
      .click();
    await expect(dialog).toContainText(
      "Add may have completed. Press Add again to check safely."
    );

    // Closed and reopened, the pending add is still there: a different count settles it first.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await open();
    await addRow(page)
      .getByRole("button", { name: "Increase Copies to add" })
      .click({ clickCount: 3 });
    await addRow(page).getByRole("button", { name: "Add 4" }).click();
    await expect(dialog).toContainText(
      "Your earlier add finished: added 1 copy of Bulbasaur Normal to Unsorted. Press Add again for the count shown."
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    // Only the settled copy leaves the count, as in Add mode: 4 less 1 is 3.
    await expect(
      addRow(page).getByRole("button", { name: "Add 3" })
    ).toBeVisible();
    expect(await held(page, await unsortedId(page))).toEqual(["1 Bulbasaur"]);
  });

  test.describe("delayed Undo", () => {
    // Catalog generation is setup, separate from the response-order scenario.
    test.beforeAll(() => seedPopup());
    test("an Undo that finishes after a newer toast came leaves the newer toast alone (#177)", async ({
      page,
    }) => {
      await signIn(page);
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await addBar(page).getByRole("button", { name: "Add 1 card" }).click();
      await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");

      // The Undo is applied, but its answer waits until another add has shown its own toast.
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let applied!: () => void;
      const undoApplied = new Promise<void>((resolve) => (applied = resolve));
      await page.route("**/api/moves/undo/**", async (route) => {
        const response = await route.fetch();
        applied();
        await held;
        await route.fulfill({ response });
      });
      let releaseAdd!: () => void;
      const heldAdd = new Promise<void>((resolve) => (releaseAdd = resolve));
      let added!: () => void;
      const addCommitted = new Promise<void>((resolve) => (added = resolve));
      await page.route("**/api/holdings/batch", async (route) => {
        const response = await route.fetch();
        added();
        await heldAdd;
        await route.fulfill({ response });
      });
      const firstUndo = (await undo(page).elementHandle())!;
      await undo(page).click();
      await undoApplied;
      await more(page, CANDY).click();
      await addBar(page).getByRole("button", { name: "Add 1 card" }).click();
      await addCommitted;
      await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");
      await expect(undo(page)).toBeVisible();
      try {
        // The identical old toast is still present while the second add's answer is held.
        // Deliver the add, then observe its new toast before allowing Undo to finish.
        releaseAdd();
        await expect
          .poll(() => firstUndo.evaluate((el) => el.isConnected))
          .toBe(false);
        await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");
        await expect(undo(page)).not.toHaveAttribute("aria-disabled", "true");
        await expect(
          tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal")
        ).toHaveAccessibleName(
          "Bulbasaur, MEG 001, Mega Evolution, Normal, 1 owned"
        );
        release();
        // The Undo's result reaches the tiles but not the toast.
        await expect(
          tile(page, "Bulbasaur, MEG 001, Mega Evolution, Normal")
        ).toHaveAccessibleName(
          "Bulbasaur, MEG 001, Mega Evolution, Normal, not owned"
        );
        await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");
        await expect(undo(page)).toBeVisible();
      } finally {
        releaseAdd();
        release();
      }
    });
  });

  test("from All owned, Add cards asks for a Location and leaves you in it", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    const shelf = await createLocation(page, "Shelf");
    await createLocation(page, "Binder", shelf);
    await page.goto(`${ORIGIN}/collection`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await page.getByRole("button", { name: "Add cards", exact: true }).click();
    const add = page.getByRole("dialog", { name: "Add cards", exact: true });
    const picker = addBar(add).getByRole("combobox", {
      name: "Location to add to",
    });
    await expect(picker.locator("option:checked")).toHaveText("Unsorted");
    await picker.selectOption({ label: "Shelf / Binder" });
    await more(add, CANDY).click();
    await addBar(add).getByRole("button", { name: "Add 1 card" }).click();
    await expect(add).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Binder");
    await expect(sidebarButton(page, "Binder")).toBeVisible();
    await expect(toast(page)).toHaveText("Added 1 card to Shelf / Binder.");
    await expect(cards(page)).toHaveCount(1);
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone Clear and Add appear once a card is queued, and Add cards fills the screen", async ({
    page,
  }) => {
    seedPopup();
    await signIn(page);
    await expect(results(page).getByRole("listitem")).toHaveCount(5);
    await mode(page, "Add to a Location").tap();
    const bar = addBar(page);
    await expect(bar.getByRole("button", { name: "Clear" })).toBeHidden();
    await expect(bar.getByRole("button", { name: "Add cards" })).toBeHidden();
    await expectPageChecks(page, "phone Catalog, Add mode, nothing queued");
    await more(page, BULBASAUR).tap();
    await expect(bar.getByRole("button", { name: "Clear" })).toBeVisible();
    await expectTouchTarget(bar.getByRole("button", { name: "Add 1 card" }));
    await expectPageChecks(page, "phone Catalog, Add mode, a card queued");
    // The popup is a bottom sheet in Add mode too.
    await tile(page, "Rare Candy, MEG 125").tap();
    await expect(
      page.getByRole("dialog", { name: "Rare Candy" })
    ).toBeVisible();
    await expectPageChecks(page, "phone Catalog, Add mode, card popup open");
    await page.getByRole("button", { name: "Close card details" }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await bar.getByRole("button", { name: "Clear" }).tap();
    await expect(bar.getByRole("button", { name: "Clear" })).toBeHidden();

    await page.goto(`${ORIGIN}/collection`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "All owned"
    );
    await page.getByRole("button", { name: "Add cards", exact: true }).tap();
    const add = page.getByRole("dialog", { name: "Add cards", exact: true });
    await expect(results(add).getByRole("listitem")).toHaveCount(5);
    // It fills the screen.
    await expect
      .poll(() =>
        add.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return [box.left, box.top, box.width, box.height].map(Math.round);
        })
      )
      .toEqual([0, 0, 375, 812]);
    await expectPageChecks(page, "phone Collection, Add cards");
    await more(add, SWITCH).tap();
    await more(add, SWITCH).tap();
    await expectPageChecks(page, "phone Collection, Add cards, a card queued");
    // The popup over the gallery: only its own controls count.
    await tile(add, "Rare Candy, MEG 125").tap();
    const card = page.getByRole("dialog", { name: "Rare Candy" });
    await expect(card).toBeVisible();
    await expectPageChecks(
      page,
      "phone Collection, Add cards with the card popup"
    );
    await card.getByRole("button", { name: "Close card details" }).tap();
    await expect(card).toHaveCount(0);
    await expect(add).toBeVisible();
    await addBar(add).getByRole("button", { name: "Add 2 cards" }).tap();
    await expect(add).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Unsorted"
    );
    await expect(toast(page)).toHaveText("Added 2 cards to Unsorted.");
    await expectPageChecks(page, "phone Collection, after Add cards");
  });
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`owned badge at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("ownership stays clear of collapsed and queued quick add in Catalog and Collection", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await addBar(page).getByRole("button", { name: "Add 1 card" }).click();
      await expect(toast(page)).toHaveText("Added 1 card to Unsorted.");

      async function checkBadge(scope: Page | Locator, count: number) {
        const ownedTile = tile(
          scope,
          "Bulbasaur, MEG 001, Mega Evolution, Normal"
        );
        await expect(ownedTile).toHaveAccessibleName(
          `Bulbasaur, MEG 001, Mega Evolution, Normal, 1 owned${count ? `, ${count} to add` : ""}`
        );
        const badge = ownedTile.getByText("×1", { exact: true });
        const control = results(scope).getByRole("group", {
          name: `${BULBASAUR}: ${count} to add`,
          exact: true,
        });
        await expect(badge).toBeVisible();
        await expect(control).toBeVisible();
        await expect
          .poll(async () => {
            const a = await badge.boundingBox();
            const b = await control.boundingBox();
            if (!a || !b) return false;
            return (
              a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y
            );
          })
          .toBe(true);
      }

      await checkBadge(page, 0);
      await more(page, BULBASAUR).click();
      await checkBadge(page, 1);
      await page.goto(`${ORIGIN}/collection`);
      await page
        .getByRole("button", { name: "Add cards", exact: true })
        .click();
      const add = page.getByRole("dialog", { name: "Add cards", exact: true });
      await checkBadge(add, 0);
      await more(add, BULBASAUR).click();
      await checkBadge(add, 1);
    });
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`queue reload at ${viewport.width}`, () => {
    test.use({ viewport });
    for (const hidden of [false, true]) {
      test(`resolves an unknown set before browsing (hidden=${hidden})`, async ({
        page,
      }) => {
        seedPopup();
        await signIn(page);
        let release!: () => void;
        const held = new Promise<void>((done) => {
          release = done;
        });
        let sawLookup!: () => void;
        const lookup = new Promise<void>((done) => {
          sawLookup = done;
        });
        await page.route("**/api/catalog/sets", async (route) => {
          sawLookup();
          await held;
          await route.continue();
        });
        const requestedSets: string[] = [];
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.pathname === "/api/catalog/editions")
            requestedSets.push(url.searchParams.get("set_id") ?? "");
        });
        try {
          await page.goto(`${ORIGIN}/catalog?set=unknown`);
          await lookup;
          const tabs = page
            .getByRole("navigation", { name: "Main views" })
            .filter({ visible: true });
          if (hidden)
            await tabs
              .getByRole("button", { name: "Collection", exact: true })
              .click();
          const validated = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/api/catalog/sets"
          );
          const resolvedBrowse = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname === "/api/catalog/editions" &&
              !url.searchParams.get("set_id")
            );
          });
          release();
          await validated;
          await resolvedBrowse;
          if (hidden)
            await tabs
              .getByRole("button", { name: "Catalog", exact: true })
              .click();
          await expect(page).toHaveURL(`${ORIGIN}/catalog`);
          await expect(
            page.getByRole("region", { name: "Catalog results" })
          ).toBeVisible();
          expect(requestedSets).not.toContain("unknown");
        } finally {
          release();
        }
      });
    }
    test("opens a metadata report link with a kept Add queue", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      page.on("dialog", (dialog) => void dialog.accept());
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      const response = await page.request.get(`${ORIGIN}/api/catalog/editions`);
      const edition = (await response.json()).editions[0];
      await page.goto(
        `${ORIGIN}/catalog?${new URLSearchParams({ printing: edition.printing_id, edition: edition.edition_id })}`
      );
      await expect(
        page.getByRole("region", { name: "Report card metadata" })
      ).toBeVisible();
      // The report link becomes the card's address (`card` and `edition`); `printing` is gone.
      await expect(page).toHaveURL(
        `${ORIGIN}/catalog?mode=add&card=${edition.printing_id}&edition=${edition.edition_id}`
      );
    });
    test("keeps search and filters in reloadable shared URLs", async ({
      page,
      context,
    }) => {
      seedPopup();
      await signIn(page);
      await page
        .getByRole("searchbox", { name: "Search the catalog" })
        .fill("Bulbasaur");
      const filtered = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/catalog/editions" &&
          url.searchParams.get("q") === "Bulbasaur" &&
          url.searchParams.get("format") === "standard"
        );
      });
      await page.getByRole("button", { name: "Standard", exact: true }).click();
      const answer = await (await filtered).json();
      const ids = answer.editions.map(
        (edition: { edition_id: string }) => edition.edition_id
      );
      const rows = (target: Page) =>
        target
          .getByRole("region", { name: "Catalog results" })
          .locator("[data-edition-id]");
      await expect(rows(page)).toHaveCount(ids.length);
      await expect(page).toHaveURL(/q=Bulbasaur&format=standard/);
      const url = page.url();
      await mode(page, "Add to a Location").click();
      const keptUrl = page.url();
      await page
        .getByRole("navigation", { name: "Main views" })
        .filter({ visible: true })
        .getByRole("button", { name: "Collection", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "Main views" })
        .filter({ visible: true })
        .getByRole("button", { name: "Catalog", exact: true })
        .click();
      await expect(page).toHaveURL(keptUrl);
      await expect(
        page.getByRole("searchbox", { name: "Search the catalog" })
      ).toHaveValue("Bulbasaur");
      await expect(mode(page, "Add to a Location")).toHaveAttribute(
        "aria-checked",
        "true"
      );

      await page.reload();
      await expect(
        page.getByRole("searchbox", { name: "Search the catalog" })
      ).toHaveValue("Bulbasaur");
      await expect(
        page.getByRole("button", { name: "Standard", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(rows(page)).toHaveCount(ids.length);
      const shared = await context.newPage();
      await shared.goto(url);
      await expect(
        shared.getByRole("searchbox", { name: "Search the catalog" })
      ).toHaveValue("Bulbasaur");
      await expect(
        shared.getByRole("button", { name: "Standard", exact: true })
      ).toHaveAttribute("aria-pressed", "true");
      await expect(rows(shared)).toHaveCount(ids.length);
      for (const id of ids)
        await expect(
          shared
            .getByRole("region", { name: "Catalog results" })
            .locator(`[data-edition-id="${id}"]`)
        ).toBeVisible();
      await shared.close();
    });
    test("a bare catalog restores a kept queue unless Browse is explicit", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      page.on("dialog", (dialog) => void dialog.accept());
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await page.goto(`${ORIGIN}/catalog`);
      await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`]);
      await page.goto(`${ORIGIN}/catalog?mode=browse`);
      await expect(mode(page, "Browse")).toHaveAttribute(
        "aria-checked",
        "true"
      );
    });
    test("restores unsubmitted cards, clears explicitly, and adds restored copies once", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      page.on("dialog", (dialog) => void dialog.accept());
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await more(page, BULBASAUR).click();
      await page.reload();
      await expect(mode(page, "Add to a Location")).toHaveAttribute(
        "aria-checked",
        "true"
      );
      await expect(queued(page)).toHaveText([`2× ${BULBASAUR}`]);
      await addBar(page)
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
      await page.reload();
      await expect(mode(page, "Add to a Location")).toHaveAttribute(
        "aria-checked",
        "true"
      );
      await expect(queued(page)).toHaveCount(0);
      await more(page, BULBASAUR).click();
      await page.reload();
      await expect(mode(page, "Add to a Location")).toHaveAttribute(
        "aria-checked",
        "true"
      );
      await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`]);
      await addBar(page)
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      await expect(queued(page)).toHaveCount(0);
      expect(await held(page, await unsortedId(page))).toEqual(["1 Bulbasaur"]);
      await page.reload();
      await expect(mode(page, "Add to a Location")).toHaveAttribute(
        "aria-checked",
        "true"
      );
      await expect(queued(page)).toHaveCount(0);
      expect(await held(page, await unsortedId(page))).toEqual(["1 Bulbasaur"]);
    });
    test("B1 a refused add keeps its cards across a reload", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      page.on("dialog", (dialog) => void dialog.accept());
      await page.route("**/api/holdings/batch", (route) =>
        route.fulfill({
          status: 422,
          json: { detail: { code: "QUANTITY_OVERFLOW" } },
        })
      );
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await addBar(page)
        .getByRole("button", { name: "Add 1 card", exact: true })
        .click();
      await expect(addBar(page).getByRole("alert")).toContainText("can't hold");
      await page.reload();
      await mode(page, "Add to a Location").click();
      await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`]);
      await expect(
        page.getByText(
          "Your earlier add may have finished. Check your collection before adding again.",
          { exact: true }
        )
      ).toHaveCount(0);
      expect(await held(page, await unsortedId(page))).toEqual([]);
    });
    for (const committed of [false, true]) {
      test(`reload ${committed ? "after commit" : "before commit"} restores the queue and replays the pending Add exactly once`, async ({
        page,
      }) => {
        seedPopup();
        await signIn(page);
        page.on("dialog", (dialog) => void dialog.accept());
        await mode(page, "Add to a Location").click();
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => (release = resolve));
        const requests: unknown[] = [];
        const keys: string[] = [];
        await page.route("**/api/holdings/batch", async (route) => {
          const body = route.request().postDataJSON();
          requests.push(body);
          keys.push(body.idempotency_key);
          if (requests.length > 1) {
            await route.continue();
            return;
          }
          if (committed) {
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
          }
          entered();
          await blocked;
          await route.abort();
        });
        await more(page, BULBASAUR).click();
        await addBar(page)
          .getByRole("button", { name: "Add 1 card", exact: true })
          .click();
        await started;
        try {
          await page.reload();
        } finally {
          release();
        }
        await expect(mode(page, "Add to a Location")).toHaveAttribute(
          "aria-checked",
          "true"
        );
        await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`]);
        await expect(addBar(page)).toContainText(MAY_HAVE_COMPLETED);
        await expect(
          page.getByText(
            "Your earlier add may have finished. Check your collection before adding again.",
            { exact: true }
          )
        ).toHaveCount(0);
        const unsorted = await unsortedId(page);
        expect(await held(page, unsorted)).toEqual(
          committed ? ["1 Bulbasaur"] : []
        );

        // The restored command must replay the original key, Location and exact items.
        await addBar(page)
          .getByRole("button", { name: "Add 1 card", exact: true })
          .click();
        await expect(queued(page)).toHaveCount(0);
        expect(requests).toHaveLength(2);
        expect(requests[1]).toEqual(requests[0]);
        expect(await held(page, unsorted)).toEqual(["1 Bulbasaur"]);
        await page.reload();
        await expect(queued(page)).toHaveCount(0);
        expect(await held(page, unsorted)).toEqual(["1 Bulbasaur"]);

        // A later queue remains independent of the settled command, including across reload.
        await more(page, CANDY).click();
        await page.reload();
        await expect(queued(page)).toHaveText([`1× ${CANDY}`]);
        expect(await held(page, unsorted)).toEqual(["1 Bulbasaur"]);
        await addBar(page)
          .getByRole("button", { name: "Add 1 card", exact: true })
          .click();
        await expect(queued(page)).toHaveCount(0);
        expect(keys).toHaveLength(3);
        expect(keys[2]).not.toBe(keys[0]);
        expect(await held(page, unsorted)).toEqual([
          "1 Bulbasaur",
          "1 Rare Candy",
        ]);
      });
      test(`discarding an uncertain Add ${committed ? "after commit" : "before commit"} preserves a dismissible warning and permits a fresh queue`, async ({
        page,
      }) => {
        seedPopup();
        await signIn(page);
        page.on("dialog", (dialog) => void dialog.accept());
        await mode(page, "Add to a Location").click();
        const keys = await scriptBatch(page, [committed ? "lost" : "dropped"]);
        await more(page, BULBASAUR).click();
        await addBar(page)
          .getByRole("button", { name: "Add 1 card", exact: true })
          .click();
        await expect(addBar(page)).toContainText(MAY_HAVE_COMPLETED);
        await page.reload();
        await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`]);
        await addBar(page)
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        const warning = page.getByText(
          "Your earlier add may have finished. Check your collection before adding again.",
          { exact: true }
        );
        await expect(warning).toBeVisible();
        await page.reload();
        await expect(warning).toBeVisible();
        await expect(queued(page)).toHaveCount(0);
        const unsorted = await unsortedId(page);
        expect(await held(page, unsorted)).toEqual(
          committed ? ["1 Bulbasaur"] : []
        );
        await page
          .getByRole("button", { name: "Dismiss", exact: true })
          .click();
        await expect(warning).toHaveCount(0);
        await more(page, CANDY).click();
        await page.reload();
        await expect(queued(page)).toHaveText([`1× ${CANDY}`]);
        await expect(warning).toHaveCount(0);
        expect(await held(page, unsorted)).toEqual(
          committed ? ["1 Bulbasaur"] : []
        );
        await addBar(page)
          .getByRole("button", { name: "Add 1 card", exact: true })
          .click();
        await expect(queued(page)).toHaveCount(0);
        expect(keys).toHaveLength(2);
        expect(keys[1]).not.toBe(keys[0]);
        expect(await held(page, unsorted)).toEqual(
          committed ? ["1 Bulbasaur", "1 Rare Candy"] : ["1 Rare Candy"]
        );
      });
    }
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`clear queue recovery ${viewport.width}`, () => {
    test.use({ viewport });
    test("Clear focuses Undo, restores the stored queue, and keeps phone rows readable", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await more(page, BULBASAUR).click();
      await more(page, CANDY).click();
      const bar = addBar(page);
      const before = await queued(page).allTextContents();
      if (viewport.width === 375) {
        for (const row of await queued(page).all()) {
          await expect
            .poll(() =>
              row.evaluate((el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                return new Set(
                  Array.from(range.getClientRects(), (rect) => rect.top)
                ).size;
              })
            )
            .toBeLessThanOrEqual(2);
        }
        for (const control of [
          ...(await bar.getByRole("button").all()),
          bar.getByRole("combobox"),
        ]) {
          await expectTouchTarget(control);
        }
        await expect
          .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
          .toBeLessThanOrEqual(375);
      }
      const requests: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") requests.push(request.url());
      });
      await bar
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
      await expect(undo(page)).toBeFocused();
      await undo(page).click();
      await expect(
        bar.getByRole("button", { name: "Add 3 cards", exact: true })
      ).toBeFocused();
      await expect(queued(page)).toHaveText(before);
      expect(requests).toEqual([]);
      await page.reload();
      await expect(queued(page)).toHaveCount(2);
      await expect(queued(page)).toHaveText(before);
      await bar
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
      await expect(undo(page)).toBeFocused();
      await page.reload();
      await mode(page, "Add to a Location").click();
      await expect(bar.getByRole("list", { name: "Cards to add" })).toHaveCount(
        0
      );
    });
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  test.describe(`Clear recovery review regressions ${viewport.width}`, () => {
    test.use({ viewport });
    test("Clear Undo remains reachable inside Collection Add cards", async ({
      page,
    }) => {
      seedPopup();
      await signIn(page);
      await page.goto(`${ORIGIN}/collection`);
      await page
        .getByRole("button", { name: "Add cards", exact: true })
        .click();
      const dialog = page.getByRole("dialog").last();
      await more(dialog, BULBASAUR).click();
      await more(dialog, BULBASAUR).click();
      const bar = addBar(dialog);
      await bar
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
      const recovery = dialog.getByRole("button", {
        name: "Undo",
        exact: true,
      });
      await expect(recovery).toBeFocused();
      if (viewport.width === 375) await expectTouchTarget(recovery);
      await recovery.click();
      await expect(
        bar.getByRole("button", { name: "Add 2 cards", exact: true })
      ).toBeFocused();
      await expect(queued(dialog)).toHaveText([`2× ${BULBASAUR}`]);
    });
    test("Clear then Browse then Undo focuses search", async ({ page }) => {
      seedPopup();
      await signIn(page);
      await mode(page, "Add to a Location").click();
      await more(page, BULBASAUR).click();
      await addBar(page)
        .getByRole("button", { name: "Clear queue", exact: true })
        .click();
      await expect(undo(page)).toBeFocused();
      await mode(page, "Browse").click();
      await undo(page).click();
      await expect(
        page.getByRole("searchbox", { name: "Search the catalog" })
      ).toBeFocused();
      await mode(page, "Add to a Location").click();
      await expect(queued(page)).toHaveText([`1× ${BULBASAUR}`]);
    });
  });
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  for (const context of ["page", "dialog"] as const) {
    test.describe(`single recovery owner ${context} ${viewport.width}`, () => {
      test.use({ viewport });
      test("Add and Clear replace each other's recovery, including a delayed Add notice", async ({
        page,
      }) => {
        seedPopup();
        await signIn(page);
        let scope: Page | Locator = page;
        if (context === "dialog") {
          await page.goto(`${ORIGIN}/collection`);
          await page
            .getByRole("button", { name: "Add cards", exact: true })
            .click();
          scope = page.getByRole("dialog").last();
        } else await mode(page, "Add to a Location").click();
        const bar = addBar(scope);
        const recovery =
          context === "dialog"
            ? scope.getByRole("button", { name: "Undo", exact: true })
            : undo(page);
        async function popupAdd() {
          await tile(
            scope,
            "Bulbasaur, MEG 001, Mega Evolution, Normal"
          ).click();
          await addRow(page)
            .getByRole("button", { name: "Add 1", exact: true })
            .click();
        }
        await popupAdd();
        const allUndo = page.getByRole("button", {
          name: "Undo",
          exact: true,
          includeHidden: true,
        });
        const toastUndo = page
          .getByRole("region", { name: "Notifications", includeHidden: true })
          .getByRole("button", {
            name: "Undo",
            exact: true,
            includeHidden: true,
          });
        if (context === "page") {
          const inlineUndo = page
            .getByRole("dialog")
            .getByRole("button", { name: "Undo", exact: true });
          await expect(inlineUndo).toBeVisible();
          await expect(inlineUndo).toBeEnabled();
          await expect(allUndo).toHaveCount(1);
          await expect(toastUndo).toHaveCount(0);
        } else {
          await expect(undo(page)).toHaveCount(1);
        }
        await page.keyboard.press("Escape");
        if (context === "page") {
          await expect(allUndo).toHaveCount(1);
          await expect(toastUndo).toHaveCount(1);
          await expect(toastUndo).toBeVisible();
          await expect(toastUndo).toBeEnabled();
        }
        await more(scope, BULBASAUR).click();
        await bar
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        await expect(recovery).toHaveCount(1);
        await expect(recovery).toBeFocused();
        await expect(toast(page)).toHaveText("Queue cleared.");
        await recovery.click();
        await expect(queued(scope)).toHaveText([`1× ${BULBASAUR}`]);
        let release!: () => void;
        let arrived!: () => void;
        let served!: () => void;
        const waiting = new Promise<void>((done) => {
          arrived = done;
        });
        const gate = new Promise<void>((done) => {
          release = done;
        });
        const completed = new Promise<void>((done) => {
          served = done;
        });
        await page.route("**/api/moves/undo", async (route) => {
          const response = await route.fetch();
          arrived();
          await gate;
          await route.fulfill({ response });
          served();
        });
        await popupAdd();
        await waiting;
        await page.keyboard.press("Escape");
        await bar
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        release();
        await completed;
        await expect(toast(page)).toHaveText("Queue cleared.");
        await expect(recovery).toHaveCount(1);
        await recovery.click();
        await expect(queued(scope)).toHaveText([`1× ${BULBASAUR}`]);
        await page.unroute("**/api/moves/undo");
        await bar
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        await popupAdd();
        await page.keyboard.press("Escape");
        await expect(
          scope.getByText("Queue cleared.", { exact: true })
        ).toHaveCount(0);
        await expect(recovery).toHaveCount(1);
        await expect(toast(page)).toHaveText(/Added 1 card/);
        await expect(
          bar.getByRole("list", { name: "Cards to add" })
        ).toHaveCount(0);
      });
    });
  }
}

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 375, height: 812 },
]) {
  for (const context of ["page", "dialog"] as const) {
    test.describe(`token recovery ${context} ${viewport.width}`, () => {
      test.use({ viewport, hasTouch: viewport.width === 375 });
      async function openContext(page: Page) {
        seedPopup();
        await signIn(page);
        if (context === "dialog") {
          const location = await createLocation(page, "Recovery box");
          await page.goto(
            `${ORIGIN}/collection?location=${encodeURIComponent(location)}`
          );
          await page
            .getByRole("button", { name: "Add cards", exact: true })
            .click();
          return page.getByRole("dialog", {
            name: "Add cards to Recovery box",
          });
        }
        await mode(page, "Add to a Location").click();
        return page.locator("main:visible");
      }
      const clearUndo = (page: Page, scope: Locator) =>
        context === "dialog"
          ? scope.locator('[data-recovery-action="bar"]')
          : undo(page);
      async function reopen(page: Page) {
        if (context === "dialog") {
          await page
            .getByRole("button", { name: "Add cards", exact: true })
            .click();
        } else await mode(page, "Add to a Location").click();
      }
      test("PW1/PW5 two rows restore with focus and survive reload", async ({
        page,
      }) => {
        const scope = await openContext(page),
          bar = addBar(scope);
        await more(scope, BULBASAUR).click();
        await more(scope, CANDY).click();
        if (viewport.width === 375) {
          for (const row of await queued(scope).all()) {
            await expect
              .poll(() =>
                row.evaluate(
                  (el) =>
                    el.getBoundingClientRect().width /
                    el.parentElement!.getBoundingClientRect().width
                )
              )
              .toBeGreaterThanOrEqual(0.9);
            await expect
              .poll(() =>
                row.evaluate((el) => {
                  const range = document.createRange();
                  range.selectNodeContents(el);
                  const style = getComputedStyle(el);
                  let lineHeight = parseFloat(style.lineHeight);
                  if (!Number.isFinite(lineHeight)) {
                    // Resolve CSS normal from one rendered line with identical inherited typography.
                    const clone = el.cloneNode(true) as HTMLElement;
                    Object.assign(clone.style, {
                      position: "absolute",
                      visibility: "hidden",
                      width: "max-content",
                      whiteSpace: "nowrap",
                      height: "auto",
                    });
                    el.parentElement!.append(clone);
                    lineHeight =
                      clone.getBoundingClientRect().height -
                      parseFloat(style.paddingTop) -
                      parseFloat(style.paddingBottom) -
                      parseFloat(style.borderTopWidth) -
                      parseFloat(style.borderBottomWidth);
                    clone.remove();
                  }
                  return range.getBoundingClientRect().height / lineHeight;
                })
              )
              .toBeLessThanOrEqual(2);
          }
          await expectTouchTarget(
            bar.getByRole("button", { name: "Clear queue", exact: true })
          );
          await expectTouchTarget(
            bar.getByRole("button", { name: "Add 2 cards", exact: true })
          );
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth <= innerWidth
              )
            )
            .toBe(true);
        }
        await expect(bar.locator("[data-queue-add]")).toBeEnabled();
        await bar
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        await expect(clearUndo(page, scope)).toBeFocused();
        if (viewport.width === 375)
          await expectTouchTarget(clearUndo(page, scope));
        await clearUndo(page, scope).click();
        await expect(bar.locator("[data-queue-add]")).toBeFocused();
        await expect(queued(scope)).toHaveText([
          `1× ${BULBASAUR}`,
          `1× ${CANDY}`,
        ]);
        await page.reload();
        await reopen(page);
        await expect(queued(scope)).toHaveText([
          `1× ${BULBASAUR}`,
          `1× ${CANDY}`,
        ]);
      });
      test("PW2 Clear without Undo stays empty after reload", async ({
        page,
      }) => {
        const scope = await openContext(page);
        await more(scope, BULBASAUR).click();
        await addBar(scope)
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        await page.reload();
        await reopen(page);
        await expect(queued(scope)).toHaveCount(0);
        await expect(clearUndo(page, scope)).toHaveCount(0);
      });
      test("PW3 a queue edit retires Clear", async ({ page }) => {
        const scope = await openContext(page);
        await more(scope, BULBASAUR).click();
        await addBar(scope)
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        await more(scope, CANDY).click();
        await expect(clearUndo(page, scope)).toHaveCount(0);
        await expect(undo(page)).toHaveCount(0);
        await expect(queued(scope)).toHaveText([`1× ${CANDY}`]);
      });
      test("PW4 delayed popup Add success transfers Clear focus to a live control", async ({
        page,
      }) => {
        const scope = await openContext(page);
        let release!: () => void, arrived!: () => void;
        const gate = new Promise<void>((done) => {
          release = done;
        });
        const waiting = new Promise<void>((done) => {
          arrived = done;
        });
        await page.route("**/api/holdings/batch", async (route) => {
          arrived();
          await gate;
          await route.continue();
        });
        await tile(scope, "Bulbasaur, MEG 001, Mega Evolution, Normal").click();
        await addRow(page)
          .getByRole("button", { name: "Add 1", exact: true })
          .click();
        await waiting;
        await page.keyboard.press("Escape");
        await more(scope, CANDY).click();
        await addBar(scope)
          .getByRole("button", { name: "Clear queue", exact: true })
          .click();
        await expect(clearUndo(page, scope)).toBeFocused();
        release();
        await expect(toast(page)).toHaveText(/Added 1 card/);
        if (context === "dialog")
          await expect(
            scope.getByRole("searchbox", { name: "Search the catalog" })
          ).toBeFocused();
        else
          await expect
            .poll(() =>
              page
                .locator("#app-toasts")
                .evaluate((el) => el.contains(document.activeElement))
            )
            .toBe(true);
        if (context === "dialog")
          await expect(clearUndo(page, scope)).toHaveCount(0);
        await expect
          .poll(() =>
            page.evaluate(() => document.activeElement === document.body)
          )
          .toBe(false);
        await page.unroute("**/api/holdings/batch");
      });
    });
  }
}
