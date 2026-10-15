import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expectPageChecks } from "./support/page-check";
import { startAsNewOwner } from "./support/owner";
import { signInAsOwner } from "./support/sign-in";

// Replace a Deck's list (#215). The builder's Replace list… opens /decks/<id>/replace, where a pasted list is reviewed
// as the Deck's new Deck List: the Deck's own copies come first (under Exact printings in their own Edition), and the
// side column shows Will become Surplus. Replace Deck List saves through the Deck List changes batch at the reviewed
// revision and lands in the builder, whose Surplus group then shows exactly the preview; nothing moves, and Undo (the
// inverse batch) restores the old list. An edit in another tab makes the save stale, which sends it back to the review.
//
// The catalog is api/tests/deck_import_fixtures.py's OWNED_CARDS (no prices, so new copies take catalog order). The
// world matches api/tests/test_import_replace.py's: an older Charizard ex keeps 1 Iono PAL 185 for its own line of 2
// and holds 2 Iono PAL 254 it no longer lists; Gardevoir ex holds 2 Iono PAL 185 Reverse Holo, 3 Nest Ball, 2 Basic
// Psychic Energy SVE 005 and 1 Basic Darkness Energy, all listed; a Binder holds 1 Iono PAL 185 and, like an Attic
// box, 1 Basic Psychic Energy MEE 005.

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// A 1×1 PNG stands in for card artwork, so no test reaches the network.
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
  "base64"
);

const PASTE =
  "4 Iono PAL 185\n1 Nest Ball SVI 181\n4 Basic Psychic Energy SVE 13\n";

function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "from deck_import_fixtures import seed_import_owned_catalog\nseed_import_owned_catalog()",
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

async function edition(sourceId: string, finish: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=$1 AND e.descriptor->>'finish'=$2",
    [sourceId, finish]
  );
  return rows[0].id;
}

async function signIn(page: Page) {
  await page
    .context()
    .route(/^https:\/\/assets\.tcgdex\.net\//, (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: PIXEL })
    );
  await pool.query("DELETE FROM auth_send_event");
  await startAsNewOwner(pool);
  await signInAsOwner(page, "/decks");
  await expect(
    page.getByRole("heading", { name: "Decks", level: 1, exact: true })
  ).toBeVisible();
}

async function api(page: Page, method: string, path: string, data?: object) {
  const response = await page.request.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

type Detail = {
  deck_list: {
    revision: number;
    lines: { edition_id: string; quantity: string }[];
  };
  surplus: { edition_id: string; quantity: string }[];
};

const detail = (page: Page, deckId: string): Promise<Detail> =>
  api(page, "GET", `/api/decks/${deckId}`);

const listed = async (page: Page, deckId: string) =>
  Object.fromEntries(
    (await detail(page, deckId)).deck_list.lines.map((line) => [
      line.edition_id,
      line.quantity,
    ])
  );

const holdings = async (page: Page, location: string) =>
  (await api(page, "GET", `/api/holdings/${location}`)).holdings;

/** Sets one Deck List line through the batch route (0 removes it). */
async function setLine(
  page: Page,
  deckId: string,
  editionId: string,
  quantity: number
) {
  await api(page, "POST", `/api/decks/${deckId}/deck-list/changes`, {
    revision: (await detail(page, deckId)).deck_list.revision,
    idempotency_key: randomUUID(),
    changes: [{ edition_id: editionId, quantity: String(quantity) }],
  });
}

/** The world above; answers the two Decks' names and ids. */
async function world(page: Page) {
  const suffix = randomUUID().slice(0, 6);
  const location = async (name: string) =>
    (
      await api(page, "POST", "/api/location-tree", {
        name,
        parent_id: null,
        parent_version: null,
        idempotency_key: randomUUID(),
      })
    ).location.id as string;
  const deck = async (name: string) =>
    (
      await api(page, "POST", "/api/decks", {
        name,
        idempotency_key: randomUUID(),
      })
    ).location.id as string;
  const hold = (where: string, editionId: string, quantity: number) =>
    api(page, "POST", "/api/holdings", {
      location_id: where,
      edition_id: editionId,
      quantity: String(quantity),
      idempotency_key: randomUUID(),
    });
  const binder = await location("Binder");
  const attic = await location("Attic box");
  const charizard = { name: `Charizard ex ${suffix}`, id: "" };
  const gardevoir = { name: `Gardevoir ex ${suffix}`, id: "" };
  charizard.id = await deck(charizard.name);
  gardevoir.id = await deck(gardevoir.name);
  // Charizard ex is the older Deck, so it counts spare copies first.
  await pool.query(
    "UPDATE location SET created_at = created_at - interval '1 day' WHERE id=$1",
    [charizard.id]
  );
  const [i185, i185r, i254, nest, p5, pm5, d15] = await Promise.all([
    edition("sv02-185", "normal"),
    edition("sv02-185", "reverse"),
    edition("sv02-254", "holo"),
    edition("sv01-181", "normal"),
    edition("sve-005", "normal"),
    edition("mee-005", "normal"),
    edition("sve-015", "normal"),
  ]);
  await hold(binder, i185, 1);
  await hold(binder, pm5, 1);
  await hold(attic, pm5, 1);
  // Copies arriving in a Deck list them (migration 031); a line set lower afterwards leaves Surplus.
  await hold(charizard.id, i185, 1);
  await setLine(page, charizard.id, i185, 2);
  await hold(charizard.id, i254, 2);
  await setLine(page, charizard.id, i254, 0);
  await hold(gardevoir.id, i185r, 2);
  await hold(gardevoir.id, nest, 3);
  await hold(gardevoir.id, p5, 2);
  await hold(gardevoir.id, d15, 1);
  return {
    charizard,
    gardevoir,
    editions: { i185, i185r, i254, nest, p5, pm5, d15 },
  };
}

const lineItem = (page: Page, text: string) =>
  page.getByRole("listitem").filter({ hasText: text });

const summary = (page: Page) =>
  page.getByRole("complementary", { name: "Import summary" });

const setting = (page: Page) =>
  page.getByRole("radiogroup", { name: "Owned cards" });

const preview = (page: Page) =>
  page.getByRole("region", { name: /^Will become Surplus/ });

const saveStatus = (page: Page) =>
  page.getByRole("region", { name: "Save" }).getByRole("status").first();

const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });

const isReview = (response: {
  url(): string;
  request(): { method(): string };
}) =>
  response.url().endsWith("/api/decks/import/review") &&
  response.request().method() === "POST";

/** Pastes PASTE on the Replace screen and opens the review. */
async function review(page: Page) {
  await page.getByLabel("Decklist").fill(PASTE);
  await page.getByRole("button", { name: "Review 3 lines" }).click();
  await expect(
    page.getByRole("heading", { name: "Check the list", level: 1 })
  ).toBeVisible();
}

test.afterAll(async () => {
  await pool.end();
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Replace list… reviews a paste over the Deck's own copies, Will become Surplus is the builder's Surplus after saving, nothing moves, and Undo restores the old list", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    const { charizard, gardevoir, editions } = await world(page);
    const before = await listed(page, gardevoir.id);
    const held = await holdings(page, gardevoir.id);

    await page.goto(`${ORIGIN}/decks/${gardevoir.id}`);
    await page.getByRole("button", { name: "Replace list…" }).click();
    await expect(page).toHaveURL(new RegExp(`/decks/${gardevoir.id}/replace$`));
    await expect(
      page.getByRole("heading", {
        name: `Replace ${gardevoir.name}'s list`,
        level: 1,
      })
    ).toBeVisible();
    const destination = page.getByRole("complementary", {
      name: "Destination",
    });
    await expect(destination).toContainText("Replace this Deck's list");
    await expect(destination).toContainText(
      `Cards the new list doesn't name become Surplus in ${gardevoir.name}.`
    );
    await expect(page.getByLabel("Deck name")).toHaveCount(0);
    await expectPageChecks(page, "replace paste screen");
    await review(page);

    // Use cards I own: the Deck's own copies first, then copies elsewhere, named by where they are.
    await expect(
      setting(page).getByRole("radio", { name: "Use cards I own" })
    ).toHaveAttribute("aria-checked", "true");
    await expect(setting(page)).toHaveAccessibleDescription(
      /^Also uses cards you own in other printings of the same card\..*Copies are counted as your Want List counts them: Every Deck built at once\.$/
    );
    const iono = lineItem(page, "4 Iono PAL 185");
    await expect(iono).toContainText(
      "Used 2 Iono PAL 185 · Reverse Holo you own · in this Deck"
    );
    // A single place that is another Deck (its Surplus is spare).
    await expect(iono).toContainText(
      `Used 2 Iono PAL 254 · Holo you own · in ${charizard.name}`
    );
    await expect(lineItem(page, "1 Nest Ball SVI 181")).toContainText(
      "Used 1 Nest Ball SVI 181 you own · in this Deck"
    );
    const energy = lineItem(page, "4 Basic Psychic Energy SVE 13");
    await expect(energy).toContainText(
      "Used 2 Basic Psychic Energy sve 005 you own · in this Deck"
    );
    // Several places.
    await expect(energy).toContainText(
      "Used 2 Basic Psychic Energy mee 005 you own · 1 in Attic box, 1 in Binder"
    );
    await expect(summary(page)).toContainText(/You own\s*9 cards/);
    await expect(summary(page)).toContainText(/To get\s*0 cards/);
    await expect(summary(page)).toContainText(
      `Replacing ${gardevoir.name}'s Deck List`
    );
    // Nest Ball held beyond the new list, and Darkness Energy, which no line names.
    await expect(preview(page)).toContainText("Will become Surplus · 3 cards");
    await expect(preview(page).getByRole("listitem")).toHaveText([
      "1 Basic Darkness Energy Scarlet & Violet Energies · 015 · Normal",
      "2 Nest Ball Scarlet & Violet · 181 · Normal",
    ]);
    await expectPageChecks(page, "replace review");

    // Exact printings: the Deck's Reverse Holos still cover the Iono line in their own Edition; the rest is new, and
    // the line notes the copies Charizard ex keeps. A stored row that couldn't be checked makes the cost incomplete.
    await page.route("**/api/decks/import/review", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.totals.to_get_priced = null;
      await route.fulfill({ response, json: body });
    });
    await setting(page).getByRole("radio", { name: "Exact printings" }).click();
    await expect(iono).toContainText("2 PAL 185 · no Edition priced");
    await expect(iono).toContainText(
      "Used 2 Iono PAL 185 · Reverse Holo you own · in this Deck"
    );
    await expect(iono).toContainText(
      `1 in ${charizard.name} stays there: it's that Deck's own.`
    );
    await expect(iono).toContainText(
      `1 spare copy is counted for ${charizard.name}, an older Deck.`
    );
    await expect(summary(page)).toContainText(
      /To get\s*6 cards · cost incomplete/
    );
    await expect(preview(page)).toContainText("Will become Surplus · 5 cards");
    await page.unroute("**/api/decks/import/review");

    const answered = page.waitForResponse(isReview);
    await setting(page).getByRole("radio", { name: "Use cards I own" }).click();
    const reviewed = (await (await answered).json()) as {
      replace: { surplus: Detail["surplus"] };
    };
    await expect(saveStatus(page)).toHaveText(
      "Ready · 9 cards · 5 Deck List lines"
    );

    // Over the cap: 201 changes disable Replace Deck List, say why, and send nothing.
    const saves: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/deck-list\/changes$/.test(request.url())
      )
        saves.push(request.url());
    });
    await page.route("**/api/decks/import/review", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const padding = Array.from(
        { length: 201 - body.replace.changes.length },
        () => ({
          ...body.replace.changes[0],
        })
      );
      body.replace.changes = [...body.replace.changes, ...padding];
      await route.fulfill({ response, json: body });
    });
    await setting(page).getByRole("radio", { name: "Exact printings" }).click();
    const replaceButton = page.getByRole("button", {
      name: "Replace Deck List",
    });
    await expect(replaceButton).toHaveAttribute("aria-disabled", "true");
    await expect(saveStatus(page)).toHaveText(
      "This replaces 201 Deck List lines; one save changes at most 200."
    );
    await replaceButton.click({ force: true });
    expect(saves).toHaveLength(0);
    await page.unroute("**/api/decks/import/review");
    const restored = page.waitForResponse(isReview);
    await setting(page).getByRole("radio", { name: "Use cards I own" }).click();
    await restored;
    await expect(saveStatus(page)).toHaveText(
      "Ready · 9 cards · 5 Deck List lines"
    );
    await replaceButton.click();

    // The builder: the new list, the preview as its Surplus group, and an Undo toast.
    await expect(page).toHaveURL(new RegExp(`/decks/${gardevoir.id}$`));
    await expect(notifications(page)).toContainText(
      `Replaced ${gardevoir.name}'s Deck List. 3 cards became Surplus.`
    );
    await expect(
      page.getByRole("heading", { name: "Surplus, 3 cards" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Put away all" })
    ).toBeVisible();
    expect((await detail(page, gardevoir.id)).surplus).toEqual(
      reviewed.replace.surplus
    );
    expect(await listed(page, gardevoir.id)).toEqual({
      [editions.i185r]: "2",
      [editions.i254]: "2",
      [editions.nest]: "1",
      [editions.p5]: "2",
      [editions.pm5]: "2",
    });
    expect(await holdings(page, gardevoir.id)).toEqual(held);
    await page.getByRole("radio", { name: "List" }).click();
    await expect(
      page.getByRole("button", { name: "Remove one Iono" })
    ).toHaveCount(2);

    await notifications(page).getByRole("button", { name: "Undo" }).click();
    await expect(notifications(page)).toContainText("Deck List restored.");
    // The open builder reads the restored list.
    await expect(
      page.getByRole("button", { name: "Remove one Iono" })
    ).toHaveCount(1);
    await expect(page.getByRole("heading", { name: /^Surplus, / })).toHaveCount(
      0
    );
    expect(await listed(page, gardevoir.id)).toEqual(before);
    expect(await holdings(page, gardevoir.id)).toEqual(held);
  });

  test("a Replace saved after an edit in another tab goes back to the review, which then saves the fresh list", async ({
    page,
  }) => {
    seedCatalog();
    await signIn(page);
    const { gardevoir, editions } = await world(page);
    await page.goto(`${ORIGIN}/decks/${gardevoir.id}/replace`);
    await review(page);
    await expect(saveStatus(page)).toHaveText(
      "Ready · 9 cards · 5 Deck List lines"
    );

    const other = await page.context().newPage();
    await other.goto(`${ORIGIN}/decks/${gardevoir.id}`);
    await other.getByRole("radio", { name: "List" }).click();
    await other.getByRole("button", { name: "Add one Nest Ball" }).click();
    await expect(
      other.getByRole("region", { name: "Notifications" })
    ).toContainText("Added 1 Nest Ball.");
    await expect
      .poll(async () => (await listed(page, gardevoir.id))[editions.nest])
      .toBe("4");
    await other.close();

    // The stale save posts the review again; Replace Deck List waits for that answer.
    const reviewedAgain = page.waitForResponse(isReview);
    const save = page.getByRole("button", { name: "Replace Deck List" });
    await save.click();
    await expect(page.getByRole("region", { name: "Save" })).toContainText(
      "This Deck's list changed after you checked it. The review is up to date now: check it and save again."
    );
    await expect(page).toHaveURL(new RegExp(`/decks/${gardevoir.id}/replace$`));
    await expect(
      page.getByRole("heading", { name: "Check the list", level: 1 })
    ).toBeVisible();
    expect((await listed(page, gardevoir.id))[editions.nest]).toBe("4");
    await reviewedAgain;
    await expect(save).not.toHaveAttribute("aria-disabled", "true");
    await save.click();
    await expect(page).toHaveURL(new RegExp(`/decks/${gardevoir.id}$`));
    expect((await listed(page, gardevoir.id))[editions.nest]).toBe("1");
  });
});
