// Ticket #171: Owner controls' Reprints queue (spec "Missing cards and Owner controls", Reprints). The queue
// lists Card Identities as a ScrollTable; Review opens the identity's card inline, pinned to the table's
// visible area, with each Printing's regulation mark, Reprint Group, the group's legality and a Move to
// picker. A Reprint Groups move (a group merge, then a manual Printing joining a group) takes a reason,
// evidence, and changes a Deck List's format result; a Card Identity merge finds the
// survivor by name. The shared page check runs at 1280×800 and 375×812 with the card open and closed.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { signInAsOwner as fakeSignInAsOwner } from "./support/sign-in";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { listCards } from "./support/deck-list";
import { expectPageChecks } from "./support/page-check";

const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
const OWNER_EMAIL = process.env.OWNER_EMAIL || "owner@example.test";

async function query<T = Record<string, unknown>>(
  sql: string,
  values: unknown[] = []
): Promise<T[]> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    return (await pool.query(sql, values)).rows as T[];
  } finally {
    await pool.end();
  }
}

/**
 * A fresh catalog through the real import: Rare Candy in two wordings (me01-125 and sv01-191 share one
 * Reprint Group, sm1-129 and sm2-165 another), Bulbasaur and a Basic Energy for a Deck List, and
 * Professor's Research with a "[Professor Sada]" printing that the subtitle rule leaves as a Card Identity
 * of its own. The import resets the owner binding, so the owner signs in afterwards.
 */
function seedCatalog() {
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      `from test_catalog import reset_catalog
from test_catalog_metadata import Records
from test_catalog_reconciliation import run
from test_card_attributes import BULBASAUR_ME, ENERGY_SV, card
from test_reprint_groups import CANDY_ME, CANDY_SM, CANDY_SM_GUARDIANS, CANDY_SV, RESEARCH, RESEARCH_SV
SADA = card(id="fixture-sv04-906", name="Professor's Research [Professor Sada]", localId="906", category="Trainer",
            set={"id": "sv04", "name": "Paradox Rift"}, regulationMark="G", rarity="Rare", trainerType="Supporter",
            effect=RESEARCH)
reset_catalog()
run(Records(CANDY_ME, CANDY_SV, CANDY_SM, CANDY_SM_GUARDIANS, ENERGY_SV, BULBASAUR_ME, RESEARCH_SV, SADA))`,
    ],
    { env: { ...process.env, PYTHONPATH: "api:api/tests" } }
  );
}

/** A manually approved Printing in the Card Identity of `memberSourceId`, as a missing-card approval makes
 * one: in no Reprint Group, so its identity enters the Reprints queue. Set "future" sorts before every
 * imported set. */
async function seedManualPrinting(
  memberSourceId: string | null,
  name: string,
  number: string
) {
  // No member: a new Card Identity of its own, as approving a missing card nobody has imported makes.
  const [member] = memberSourceId
    ? await query<{ identity_id: string }>(
        "SELECT identity_id FROM catalog_printing WHERE source_id=$1",
        [memberSourceId]
      )
    : await query<{ identity_id: string }>(
        "INSERT INTO catalog_identity(identity_key,display_name) VALUES ($1,$2) RETURNING id AS identity_id",
        [name.toLowerCase(), name]
      );
  const [state] = await query<{ active_generation: string }>(
    "SELECT active_generation FROM catalog_state"
  );
  const [printing] = await query<{ id: string }>(
    "INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',$1) RETURNING id",
    [member.identity_id]
  );
  const [edition] = await query<{ id: string }>(
    `INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor)
     VALUES ($1,'normal','{"finish":"normal"}') RETURNING id`,
    [printing.id]
  );
  await query(
    `INSERT INTO catalog_generation_printing(generation_id,printing_id,source_id,set_id,set_name,
       collector_number,display_name,search_name,source_fingerprint,basic_energy)
     VALUES ($1,$2,$3,'future','Future Set',$4,$5,$6,'manual','unresolved')`,
    [
      state.active_generation,
      printing.id,
      `manual:${printing.id}`,
      number,
      name,
      name.toLowerCase(),
    ]
  );
  await query("INSERT INTO catalog_generation_edition VALUES ($1,$2,$3,true)", [
    state.active_generation,
    edition.id,
    printing.id,
  ]);
  return printing.id;
}

/** Signs in at /collection through the OAuth test fake, then binds the owner role to that user. */
async function signInAsOwner(page: Page) {
  await query("DELETE FROM auth_send_event");
  await fakeSignInAsOwner(page, "/collection");
  await expect(
    page.getByRole("navigation", { name: "Main views" })
  ).toBeVisible();
  await query(
    'INSERT INTO owner_binding(singleton,user_id) SELECT true,id FROM "user" WHERE email=$1 ON CONFLICT(singleton) DO UPDATE SET user_id=EXCLUDED.user_id',
    [OWNER_EMAIL]
  );
}

const reprintsTab = (page: Page) =>
  page
    .getByRole("tablist", { name: "Owner controls sections" })
    .getByRole("tab", { name: /^Reprints/ });

async function openReprints(page: Page) {
  await page.goto(`${ORIGIN}/owner/reprints`);
  await expect(reprintsTab(page)).toHaveAttribute("aria-selected", "true");
}

const section = (page: Page) =>
  page.getByRole("region", { name: "Reprint Groups" });
const queue = (page: Page) =>
  page.getByRole("region", { name: "Card Identity review queue" });
const queueRow = (page: Page, name: string) =>
  queue(page)
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name, exact: true }) });
const notifications = (page: Page) =>
  page.getByRole("region", { name: "Notifications" });
/** A Printing's row in the card's table, by its set · number. */
const printingRow = (card: Locator, where: string) =>
  card
    .getByRole("region", { name: "Printings and their groups" })
    .getByRole("row")
    .filter({ hasText: where });
const moveTo = (card: Locator, printing: string) =>
  // A Select's label wraps its options, so its name starts with the label and goes on with the choice.
  card.getByRole("combobox", { name: new RegExp(`^Move ${printing} to`) });

/** Opens a row's card; the card takes the focus in its reason field. */
async function openCard(page: Page, name: string) {
  const review = queueRow(page, name).getByRole("button", {
    name: `Review ${name}`,
  });
  await review.click();
  await expect(review).toHaveAttribute("aria-expanded", "true");
  const card = page.getByRole("article", { name });
  await expect(card.getByLabel("Review reason")).toBeFocused();
  await expect(
    card.getByRole("region", { name: "Printings and their groups" })
  ).toBeVisible();
  return { review, card };
}

/** A new Deck whose Deck List holds 4 Rare Candy sm1-129, Bulbasaur and 55 Basic Energy: not legal in
 * Standard on its own wording, legal once its group joins me01-125's (mark I). */
async function candyDeck(page: Page) {
  const created = await page.request.post(`${ORIGIN}/api/decks`, {
    headers: { origin: ORIGIN },
    data: { name: `Candy ${randomUUID()}`, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  const deckId = ((await created.json()) as { location: { id: string } })
    .location.id;
  const [deck] = await query<{ owner_id: string }>(
    "SELECT owner_id FROM location WHERE id=$1",
    [deckId]
  );
  const editions = Object.fromEntries(
    (
      await query<{ source_id: string; id: string }>(
        "SELECT p.source_id,e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id WHERE p.source_id=ANY($1)",
        [["sm1-129", "me01-001", "sv02-278"]]
      )
    ).map((row) => [row.source_id, row.id])
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await listCards(pool, deck.owner_id, deckId, {
      [editions["sm1-129"]]: 4,
      [editions["me01-001"]]: 1,
      [editions["sv02-278"]]: 55,
    });
  } finally {
    await pool.end();
  }
  return deckId;
}

/** The Deck's Standard result on a fixed day the rules cover, and the attribute revision it was read at. */
async function standard(page: Page, deckId: string) {
  const response = await page.request.get(
    `${ORIGIN}/api/decks/${deckId}/format-checks?format=standard&as_of=2026-10-11`
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    attribute_revision: number;
    results: { status: string }[];
  };
  return {
    status: body.results[0].status,
    revision: body.attribute_revision,
  };
}

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("a Reprint Groups move: merging a group and moving a manual Printing take a reason and evidence, and the Deck List's format result follows", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    const manual = await seedManualPrinting("me01-125", "Rare Candy", "1");
    const deckId = await candyDeck(page);
    const before = await standard(page, deckId);
    expect(before.status).toBe("not_legal");

    await openReprints(page);
    await expect(reprintsTab(page)).toHaveAccessibleName("Reprints 1");
    await expect(queue(page).getByRole("columnheader")).toHaveText([
      "Card",
      "Set · number",
      "Kind",
      "Reports",
      "Opened",
      "Age",
      "Review",
    ]);
    await expect(queueRow(page, "Rare Candy").getByRole("cell")).toContainText([
      "Rare Candy",
      "future · 1",
      "Manual Printing in no group",
      "—",
    ]);
    await expectPageChecks(page, "Owner controls, Reprints queue (desktop)");

    const { card } = await openCard(page, "Rare Candy");
    await expect(
      card
        .getByRole("region", { name: "Printings and their groups" })
        .getByRole("columnheader")
    ).toHaveText([
      "Printing",
      "Regulation mark",
      "Reprint Group",
      "Group legality",
      "Move to",
    ]);
    // Printings sort by set: the manual one ("future"), then me01-125 (Group 1), sm1-129 (Group 2), …
    await expect(
      printingRow(card, "future · 1").getByRole("cell")
    ).toContainText([
      "Rare Candy · future · 1 · manual",
      "Unknown",
      "No group",
      "—",
    ]);
    await expect(
      printingRow(card, "me01 · 125").getByRole("cell")
    ).toContainText(["Rare Candy · me01 · 125", "I", "Group 1", "Standard:"]);
    // The Sun & Moon wording is in no Standard set, whatever the day.
    await expect(
      printingRow(card, "sm1 · 129").getByRole("cell")
    ).toContainText([
      "Rare Candy · sm1 · 129",
      "Unknown",
      "Group 2",
      "Standard: Not legal",
    ]);

    const confirm = card.getByRole("button", { name: "Confirm decision" });
    await card
      .getByRole("combobox", { name: /^Decision/ })
      .selectOption("merge_groups");
    // Merging a whole group is its own decision, so the Move to pickers stand down.
    await expect(moveTo(card, "Rare Candy · sm1 · 129")).toBeDisabled();
    await card
      .getByRole("combobox", { name: /^Group to merge/ })
      .selectOption({ label: "Group 2 · 2 Printings" });
    await card
      .getByRole("combobox", { name: /^Into group/ })
      .selectOption({ label: "Group 1 · 2 Printings" });
    await expect(
      card.getByText(
        "Merges Group 2 into Group 1; later reprints with either wording join it too."
      )
    ).toBeVisible();
    await card.getByLabel("Review reason").fill("Same effect, reworded");
    await card
      .getByLabel("Review evidence URL")
      .fill("https://example.org/compendium");
    await expect(confirm).toBeEnabled();
    await expectPageChecks(
      page,
      "Owner controls, Reprints review card open (desktop)"
    );

    await confirm.click();
    await expect(notifications(page)).toContainText(
      "Reprint Groups updated for Rare Candy: 2 Printings moved."
    );
    // The manual Printing still waits, so the card stays open. sm1-129 is in Group 1 now, by a reviewed link.
    await expect(
      printingRow(card, "sm1 · 129").getByRole("cell").nth(2)
    ).toHaveText("Group 1 · reviewed");
    await expect
      .poll(async () => {
        const moved = printingRow(card, "sm1 · 129").getByRole("cell").nth(3);
        const carrier = printingRow(card, "me01 · 125")
          .getByRole("cell")
          .nth(3);
        return (await moved.textContent()) === (await carrier.textContent());
      })
      .toBe(true);
    await expect
      .poll(() => standard(page, deckId))
      .toEqual({ status: "legal", revision: before.revision + 1 });

    // Then the manual Printing joins Group 1 through its Move to picker.
    await moveTo(card, "Rare Candy · future · 1").selectOption({
      label: "Group 1",
    });
    await expect(
      card.getByText("Moves 1 Printing into Group 1.")
    ).toBeVisible();
    await confirm.click();
    await expect(notifications(page)).toContainText(
      "Reprint Groups updated for Rare Candy: 1 Printing moved."
    );
    await expect(card).toHaveCount(0);
    await expect(queue(page)).toHaveCount(0);
    await expect(
      section(page).getByText("Nothing waits for review.")
    ).toBeVisible();
    await expect(
      section(page).getByRole("heading", { name: "Reprint Groups" })
    ).toBeFocused();
    await expect(reprintsTab(page)).toHaveAccessibleName("Reprints 0");
    await expect
      .poll(async () => {
        const rows = await query<{ group_id: string }>(
          "SELECT p.source_id,m.group_id FROM catalog_reprint_group_member m JOIN catalog_printing p ON p.id=m.printing_id WHERE p.id=$1 OR p.source_id='me01-125'",
          [manual]
        );
        return rows.length === 2 && rows[0].group_id === rows[1].group_id;
      })
      .toBe(true);
  });

  test("a Card Identity made by a missing-card approval leaves the queue by confirming its manual Printing as a card of its own", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    const manual = await seedManualPrinting(null, "Future Card", "7");
    await openReprints(page);
    await expect(reprintsTab(page)).toHaveAccessibleName("Reprints 1");
    const { card } = await openCard(page, "Future Card");
    // No group exists to merge, so the only moves are to stay or to a group of its own.
    await expect(
      moveTo(card, "Future Card · future · 7").locator("option")
    ).toHaveText(["Stay", "A group of its own"]);
    const confirm = card.getByRole("button", { name: "Confirm decision" });
    await expect(confirm).toBeDisabled();
    await moveTo(card, "Future Card · future · 7").selectOption("own");
    await expect(
      card.getByText(
        "Confirms 1 Printing as a card of its own, in a new group."
      )
    ).toBeVisible();
    await card.getByLabel("Review reason").fill("A real card, no reprints");
    await card
      .getByLabel("Review evidence URL")
      .fill("https://example.org/compendium");
    await expect(confirm).toBeEnabled();
    await expectPageChecks(
      page,
      "Owner controls, Reprints confirm own group open (desktop)"
    );

    await confirm.click();
    await expect(notifications(page)).toContainText(
      "Reprint Groups updated for Future Card: 1 Printing moved."
    );
    await expect(queueRow(page, "Future Card")).toHaveCount(0);
    await expect(page.getByText("Nothing waits for review.")).toBeVisible();
    await expect(reprintsTab(page)).toHaveAccessibleName("Reprints 0");
    await expect
      .poll(
        async () =>
          (
            await query<{ decision: string }>(
              "SELECT decision FROM catalog_card_identity_decision WHERE $1 = ANY(printing_ids)",
              [manual]
            )
          )[0]?.decision
      )
      .toBe("confirm");
    await expect
      .poll(
        async () =>
          (
            await query<{ n: string }>(
              "SELECT count(*) AS n FROM catalog_reprint_group_member WHERE printing_id=$1",
              [manual]
            )
          )[0].n
      )
      .toBe("1");
  });

  test("Close returns focus to Review, and a Card Identity merge finds the survivor by name", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    await seedManualPrinting(
      "fixture-sv04-906",
      "Professor's Research [Professor Sada]",
      "2"
    );
    await openReprints(page);
    const sada = "Professor's Research [Professor Sada]";
    const { review, card: first } = await openCard(page, sada);
    await first.getByRole("button", { name: "Close" }).click();
    await expect(first).toHaveCount(0);
    await expect(review).toBeFocused();
    await expect(review).toHaveAttribute("aria-expanded", "false");

    const { card } = await openCard(page, sada);
    // One group (the imported printing); the manual one is in none, so there is nothing to merge groups with.
    await expect(
      card.getByRole("combobox", { name: /^Decision/ }).locator("option")
    ).toHaveText([
      "Move the chosen Printings",
      "Merge this Card Identity into another",
    ]);
    await card
      .getByRole("combobox", { name: /^Decision/ })
      .selectOption("merge_identity");
    await card
      .getByRole("searchbox", { name: "Find the surviving Card Identity" })
      .fill("Professor's Research");
    await card.getByRole("button", { name: "Find" }).click();
    const survivor = card.getByRole("combobox", {
      name: /^Surviving Card Identity/,
    });
    await expect(survivor.locator("option")).toHaveText([
      "Choose a Card Identity",
      "Professor's Research",
    ]);
    await survivor.selectOption({ label: "Professor's Research" });
    await expect(
      card.getByText(
        "Professor's Research keeps its name and gains this Card Identity's 2 Printings."
      )
    ).toBeVisible();
    await card
      .getByLabel("Review reason")
      .fill("One card name printed two ways");
    await card
      .getByLabel("Review evidence URL")
      .fill("https://example.org/compendium");
    await expectPageChecks(
      page,
      "Owner controls, Reprints identity merge open (desktop)"
    );

    await card.getByRole("button", { name: "Confirm decision" }).click();
    await expect(notifications(page)).toContainText(
      `Merged ${sada} into Professor's Research.`
    );
    // The manual Printing now waits under the surviving Card Identity.
    await expect(queueRow(page, sada)).toHaveCount(0);
    await expect(queueRow(page, "Professor's Research")).toBeVisible();
    await expect(reprintsTab(page)).toHaveAccessibleName("Reprints 1");
    await expect
      .poll(
        async () =>
          (
            await query<{ merged: boolean }>(
              "SELECT merged_into IS NOT NULL AS merged FROM catalog_identity WHERE display_name=$1",
              [sada]
            )
          )[0]?.merged
      )
      .toBe(true);
  });
});

test.describe("phone", () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test("the review card stays pinned to the queue's visible width while the queue scrolls sideways, and each decision layout passes the page check", async ({
    page,
  }) => {
    seedCatalog();
    await signInAsOwner(page);
    await seedManualPrinting("me01-125", "Rare Candy", "1");
    await openReprints(page);
    const table = queue(page);
    await expect
      .poll(() => table.evaluate((box) => box.scrollWidth > box.clientWidth))
      .toBe(true);
    await expectPageChecks(page, "Owner controls, Reprints queue (phone)");

    await queueRow(page, "Rare Candy")
      .getByRole("button", { name: "Review Rare Candy" })
      .tap();
    const card = page.getByRole("article", { name: "Rare Candy" });
    await expect(
      card.getByRole("region", { name: "Printings and their groups" })
    ).toBeVisible();
    await table.evaluate((box) => {
      box.scrollLeft = box.scrollWidth;
    });
    // Pinned: the card's box starts at the queue's inner left edge and is as wide as its visible area.
    await expect
      .poll(() =>
        table.evaluate((box) => {
          const pinned = box
            .querySelector("article")!
            .parentElement!.getBoundingClientRect();
          const region = box.getBoundingClientRect();
          return {
            scrolled: box.scrollLeft > 0,
            atLeftEdge:
              Math.abs(pinned.left - (region.left + box.clientLeft)) < 1.5,
            fullWidth: Math.abs(pinned.width - box.clientWidth) < 1.5,
          };
        })
      )
      .toEqual({ scrolled: true, atLeftEdge: true, fullWidth: true });
    await expectPageChecks(
      page,
      "Owner controls, Reprints review card open (phone)"
    );

    // The two other decision layouts on a phone: the group-merge selects, then the identity finder.
    const decision = card.getByRole("combobox", { name: /^Decision/ });
    await decision.selectOption("merge_groups");
    await expect(
      card.getByRole("combobox", { name: /^Into group/ })
    ).toBeVisible();
    await expectPageChecks(
      page,
      "Owner controls, Reprints group merge open (phone)"
    );
    await decision.selectOption("merge_identity");
    await card
      .getByRole("searchbox", { name: "Find the surviving Card Identity" })
      .fill("Professor's Research");
    await card.getByRole("button", { name: "Find" }).tap();
    await expect(
      card.getByRole("combobox", { name: /^Surviving Card Identity/ })
    ).toBeVisible();
    await expectPageChecks(
      page,
      "Owner controls, Reprints identity merge open (phone)"
    );
  });
});
