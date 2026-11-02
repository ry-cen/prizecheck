// Ticket #169: the Card reports page (spec "Missing cards and Owner controls"). The My reports and Report a
// card sub-tabs; My reports as a table whose Reply opens the conversation in a row under the report, pinned to
// the table's visible width while it scrolls sideways; the page keeping its sub-tab and draft across a tab
// switch and reading the reports again when shown; the shared page check at 1280×800 and 375×812. The owner's
// review of a report is in missing-cards.spec.ts.
import { test, expect, type Page } from "@playwright/test";
import { signInAsOwner } from "./support/sign-in";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { startAsNewOwner } from "./support/owner";
import { expectPageChecks } from "./support/page-check";
import { expectTouchTarget } from "./support/touch-target";

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

/** Signs in at /reports as a new user, so My reports holds only this test's reports, and lands on Card reports. */
async function signIn(page: Page) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await startAsNewOwner(pool);
    await pool.query("DELETE FROM auth_send_event");
  } finally {
    await pool.end();
  }
  await signInAsOwner(page, "/reports");
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Card reports"
  );
}

/** Files a Missing Printing through the API as the signed-in collector, with set ID `setId`. */
async function fileReport(
  page: Page,
  setId: string,
  fields: {
    english_name: string;
    set_name: string;
    collector_number: string;
    note: string;
  }
): Promise<string> {
  const response = await page.request.post(
    new URL("/api/missing-card-reports", page.url()).href,
    {
      headers: { origin: new URL(page.url()).origin },
      data: { kind: "printing", set_id: setId, ...fields },
    }
  );
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** What the owner's Request information writes (decide_report in api/app/missing_cards.py). */
async function askForInformation(id: string, reason: string) {
  await query(
    "UPDATE missing_card_report SET status='needs_info',review_reason=$2,reviewed_at=now(),updated_at=now() WHERE id=$1",
    [id, reason]
  );
}

const mainTab = (page: Page, name: string) =>
  page
    .getByRole("navigation", { name: "Main views" })
    .getByRole("button", { name, exact: true });
const sections = (page: Page) =>
  page.getByRole("tablist", { name: "Card reports sections" });
const sectionTab = (page: Page, name: string) =>
  sections(page).getByRole("tab", { name, exact: true });
const statusLine = (page: Page) => page.getByRole("main").getByRole("status");
const reportsTable = (page: Page) =>
  page.getByRole("region", { name: "Reports you sent", exact: true });
const reportRow = (page: Page, card: string) =>
  reportsTable(page)
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: card, exact: true }) });
const conversation = (page: Page, card: string) =>
  page.getByRole("group", { name: `Conversation about ${card}`, exact: true });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("Card reports has My reports and Report a card sub-tabs, keeps its draft across a tab switch, and lists a sent report as Pending", async ({
    page,
  }) => {
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const setId = `T169-${s}`;
    const card = `Pikachu · Redesign ${s} #169`;
    try {
      await expect(sections(page).getByRole("tab")).toHaveText([
        "My reports",
        "Report a card",
      ]);
      await expect(sectionTab(page, "My reports")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      const mine = page.getByRole("tabpanel", { name: "My reports" });
      await expect(mine).toContainText("No reports yet.");
      // Metadata reports stay in Catalog.
      await expect(mine).toContainText("open the card in Catalog");
      await expectPageChecks(page, "Card reports, no reports (desktop)");

      await sectionTab(page, "Report a card").click();
      await expect(page).toHaveURL(/\/reports$/);
      const form = page.getByRole("tabpanel", { name: "Report a card" });
      await expect(form.getByLabel("Report type")).toHaveValue("printing");
      for (const field of [
        "Set ID",
        "Set name",
        "Collector number",
        "English name",
        "Evidence link",
        "What is missing?",
      ])
        await expect(form.getByLabel(field)).toBeVisible();
      // #399: the note box draws its own overlay scroll bar once its text outgrows it, as typing, not only layout, changes it.
      const rail = form.locator("[data-overlay-scrollbar='region']");
      await expect(rail).toBeHidden();
      await form.getByLabel("What is missing?").fill("line\n".repeat(40));
      await expect(rail).toBeVisible();
      await form.getByLabel("What is missing?").fill("");
      await expect(rail).toBeHidden();
      await expectPageChecks(
        page,
        "Card reports, Report a card, Missing Printing (desktop)"
      );
      await form.getByLabel("Report type").selectOption("edition");
      await expect(form.getByLabel("Printing ID")).toBeVisible();
      await expect(form.getByLabel("Physical variant details")).toBeVisible();
      await expect(form.getByLabel("Set ID")).toHaveCount(0);
      await expectPageChecks(
        page,
        "Card reports, Report a card, Missing Edition (desktop)"
      );
      await form.getByLabel("Report type").selectOption("printing");
      await form.getByLabel("Set ID").fill(setId);

      // The page stays mounted: leaving it and coming back keeps the sub-tab and the draft.
      await mainTab(page, "Decks").click();
      await expect(page).toHaveURL(/\/decks$/);
      await mainTab(page, "Card reports").click();
      await expect(page).toHaveURL(/\/reports$/);
      await expect(sectionTab(page, "Report a card")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expect(form.getByLabel("Set ID")).toHaveValue(setId);

      await form.getByLabel("Set name").fill(`Redesign ${s}`);
      await form.getByLabel("Collector number").fill("169");
      await form.getByLabel("English name").fill("Pikachu");
      await form.getByLabel("Evidence link").fill("https://example.org/169");
      await form.getByLabel("What is missing?").fill("Not in the catalog");
      await form.getByRole("button", { name: "Send private report" }).click();
      await expect(statusLine(page)).toHaveText(
        "Report sent privately to the owner."
      );
      await expect(statusLine(page)).toBeFocused();
      await expect(sectionTab(page, "My reports")).toHaveAttribute(
        "aria-selected",
        "true"
      );
      await expect(reportsTable(page)).toHaveAttribute("tabindex", "0");
      await expect(reportsTable(page).getByRole("columnheader")).toHaveText([
        "Card",
        "Kind",
        "Status",
        "Sent",
        "Owner response",
        "Reply",
      ]);
      const row = reportRow(page, card);
      await expect(row.getByRole("cell")).toHaveText([
        card,
        "Missing Printing",
        "Pending",
        /\d{4}/,
        "—",
        "",
      ]);
      await expect(row.getByRole("button")).toHaveCount(0);
      await expectPageChecks(page, "Card reports, My reports (desktop)");

      // As before, the card stays filled in for a next report, and the evidence and note are cleared.
      await sectionTab(page, "Report a card").click();
      await expect(form.getByLabel("Set ID")).toHaveValue(setId);
      await expect(form.getByLabel("Evidence link")).toHaveValue("");
      await expect(form.getByLabel("What is missing?")).toHaveValue("");
      const [stored] = await query<{ status: string; evidence_url: string }>(
        "SELECT status,evidence_url FROM missing_card_report WHERE set_id=$1",
        [setId]
      );
      expect(stored).toEqual({
        status: "pending",
        evidence_url: "https://example.org/169",
      });
    } finally {
      await query("DELETE FROM missing_card_report WHERE set_id=$1", [setId]);
    }
  });

  test("a report that needs information has Reply, which opens the conversation under it, and sending updates its status", async ({
    page,
  }) => {
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const setId = `T169-${s}`;
    const card = `Raichu · Redesign ${s} #2`;
    const reason = "Please add a photo of the set symbol.";
    const reply = "Photo: https://example.org/set-symbol";
    try {
      const id = await fileReport(page, setId, {
        english_name: "Raichu",
        set_name: `Redesign ${s}`,
        collector_number: "2",
        note: "Holo from a 2026 tin",
      });
      // The owner asks while the collector is on another page; showing Card reports again reads the reports.
      await mainTab(page, "Decks").click();
      await expect(page).toHaveURL(/\/decks$/);
      await askForInformation(id, reason);
      await mainTab(page, "Card reports").click();
      const row = reportRow(page, card);
      await expect(row.getByRole("cell").nth(2)).toHaveText(
        "Needs information"
      );
      await expect(row.getByRole("cell").nth(4)).toHaveText(reason);

      const toggle = row.getByRole("button");
      await expect(toggle).toHaveText("Reply");
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.click();
      await expect(toggle).toHaveText("Close");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      const thread = conversation(page, card);
      await expect(thread.getByRole("listitem")).toHaveCount(2);
      await expect(thread.getByRole("listitem").first()).toContainText(
        "Holo from a 2026 tin"
      );
      await expect(thread.getByRole("listitem").nth(1)).toContainText(reason);
      const box = thread.getByLabel("Additional information");
      await expect(box).toBeFocused();
      const send = thread.getByRole("button", { name: "Send information" });
      await expect(send).toBeDisabled();
      await expectPageChecks(page, "Card reports, Reply open (desktop)");

      // Close folds the row and keeps the draft; focus stays on the button.
      await box.fill(reply);
      await toggle.click();
      await expect(thread).toHaveCount(0);
      await expect(toggle).toHaveText("Reply");
      await expect(toggle).toBeFocused();
      await toggle.click();
      await expect(box).toHaveValue(reply);

      // Leaving and coming back remounts the open row; that must not pull focus off the tab.
      const sections = page.getByRole("tablist", {
        name: "Card reports sections",
      });
      await sections
        .getByRole("tab", { name: "Report a card", exact: true })
        .click();
      const mineTab = sections.getByRole("tab", {
        name: "My reports",
        exact: true,
      });
      await mineTab.click();
      await expect(thread).toBeVisible();
      await expect(mineTab).toBeFocused();

      await send.click();
      await expect(statusLine(page)).toHaveText(
        "Information sent to the owner."
      );
      await expect(statusLine(page)).toBeFocused();
      await expect(row.getByRole("cell").nth(2)).toHaveText("Pending");
      await expect(row.getByRole("button")).toHaveCount(0);
      await expect(thread).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (
              await query(
                "SELECT status,note FROM missing_card_report WHERE id=$1",
                [id]
              )
            )[0]
        )
        .toEqual({ status: "pending", note: reply });
    } finally {
      await query("DELETE FROM missing_card_report WHERE set_id=$1", [setId]);
    }
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

  test("on a phone Card reports opens from the account sheet, its table and pinned Reply row scroll inside the table, and the page check passes", async ({
    page,
  }) => {
    await signIn(page);
    const s = randomUUID().slice(0, 8);
    const setId = `T169-${s}`;
    const card = `Pikachu with a Pokémon Center stamp · Redesign ${s} #3`;
    try {
      const id = await fileReport(page, setId, {
        english_name: "Pikachu with a Pokémon Center stamp",
        set_name: `Redesign ${s}`,
        collector_number: "3",
        note: "Stamped promo",
      });
      await askForInformation(
        id,
        "Which store event was the stamp from? A photo of the stamp would help."
      );
      await mainTab(page, "Collection").tap();
      await expect(page).toHaveURL(/\/collection$/);
      // Loans took the More slot (#252): Card reports is in the account sheet.
      await page.getByRole("button", { name: "Account", exact: true }).tap();
      const sheet = page.getByRole("dialog", { name: "Account" });
      await sheet.getByRole("button", { name: "Card reports" }).tap();
      await expect(page).toHaveURL(/\/reports$/);
      await expect(sheet).toBeHidden();

      await expectTouchTarget(sectionTab(page, "My reports"));
      await expectTouchTarget(sectionTab(page, "Report a card"));
      const table = reportsTable(page);
      await expect(reportRow(page, card)).toBeVisible();
      await expect
        .poll(() => table.evaluate((box) => box.scrollWidth > box.clientWidth))
        .toBe(true);
      await expectPageChecks(page, "Card reports, My reports (phone)");

      await reportRow(page, card).getByRole("button").tap();
      const thread = conversation(page, card);
      await expect(thread).toBeVisible();
      // The row is as wide as the table's visible area and sits at its left edge, before and after the
      // table scrolls sideways.
      const placement = () =>
        thread.evaluate((element) => {
          const region = element.closest('[role="region"]')!;
          const own = element.getBoundingClientRect();
          const box = region.getBoundingClientRect();
          return {
            atLeftEdge: Math.abs(own.left - box.left - region.clientLeft) < 1,
            fullWidth: Math.abs(own.width - region.clientWidth) < 1,
          };
        });
      await expect
        .poll(placement)
        .toEqual({ atLeftEdge: true, fullWidth: true });
      await table.evaluate((box) => {
        box.scrollLeft = box.scrollWidth;
      });
      await expect
        .poll(() => table.evaluate((box) => box.scrollLeft))
        .toBeGreaterThan(0);
      await expect
        .poll(placement)
        .toEqual({ atLeftEdge: true, fullWidth: true });
      await table.evaluate((box) => {
        box.scrollLeft = 0;
      });
      await expectPageChecks(page, "Card reports, Reply open (phone)");

      await sectionTab(page, "Report a card").tap();
      await expect(
        page.getByRole("tabpanel", { name: "Report a card" })
      ).toBeVisible();
      await expectPageChecks(page, "Card reports, Report a card (phone)");

      await page.getByRole("button", { name: "Account", exact: true }).tap();
      await expect(sheet).toBeVisible();
      await expect(
        sheet.getByRole("button", { name: "Card reports" })
      ).toHaveAttribute("aria-current", "page");
      await expectPageChecks(page, "Account sheet over Card reports (phone)");
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    } finally {
      await query("DELETE FROM missing_card_report WHERE set_id=$1", [setId]);
    }
  });
});
