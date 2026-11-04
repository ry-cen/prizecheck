import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { ThreadItem, TradeView } from "../../src/social_generated";

/** Complete current-contract rows for scheduling tests; no retired pair schemas. */
export function itemRow(name: string): ThreadItem {
  return {
    id: randomUUID(),
    kind: "trade",
    other: {
      trader_id: randomUUID(),
      display_name: name,
      friend: false,
      available: true,
    },
    you_are: "low",
    summary: {
      you_give: "0",
      you_get: "1",
      cards: [
        {
          edition_id: "10000000-0000-4000-8000-000000000001",
          name: "Kept Pikachu",
          image_url: null,
          copies: "1",
          side: "you_get",
        },
      ],
    },
    section: "open",
    state: "offered",
    needs_you: false,
    waiting: null,
    unread: 0,
    last_activity_at: "2026-11-04T10:00:00Z",
  };
}
export function itemOffer(row: ThreadItem, closed = false): TradeView {
  return {
    id: row.id,
    thread_id: row.id,
    offer_id: row.id,
    revision: closed ? 2 : 1,
    state: closed ? "closed" : "proposed",
    closed_reason: closed ? "withdrawn" : null,
    closed_by: closed ? "you" : null,
    role: "proposer",
    other: {
      collector_id: null,
      handle: null,
      trader_id: row.other.trader_id,
      display_name: row.other.display_name,
      open_to_cash_offers: false,
      friend: false,
    },
    countered_from: null,
    you_give: [],
    you_get: [
      {
        edition_id: row.summary.cards[0].edition_id,
        name: "Kept Pikachu",
        set_code: "TST",
        set_name: "Test cards",
        collector_number: "1",
        descriptor: {},
        image_url: null,
        copies: "1",
      },
    ],
    cash: null,
    you_confirmed_swap: false,
    they_confirmed_swap: false,
    needs_you: false,
    waiting: null,
    section: closed ? "history" : "pending",
    actions: closed ? [] : ["withdraw"],
    created_at: row.last_activity_at,
  };
}
export async function mockItemDetail(
  page: Page,
  row: ThreadItem,
  closed: () => boolean
) {
  await page.route(`**/api/trades/resolve/${row.id}`, (route) =>
    route.fulfill({ json: { thread_id: row.id } })
  );
  await page.route(`**/api/trades/${row.id}`, (route) =>
    route.fulfill({
      json: {
        id: row.id,
        live_offer: itemOffer(row, closed()),
        can_message: true,
        can_report: true,
      },
    })
  );
  await page.route(`**/api/trades/${row.id}/side`, (route) =>
    route.fulfill({
      json: { trade_id: row.id, picks: [], suggested: [], deck_switches: [] },
    })
  );
  await page.route(`**/api/trades/${row.id}/timeline**`, (route) =>
    route.fulfill({ json: { you_are: "low", items: [], next_before: null } })
  );
}
/** Follow the real opaque keyset cursor rather than inventing page-number tokens. */
export function itemPage(
  rows: ThreadItem[],
  before: string | null
): ThreadItem[] {
  const afterId = before
    ? Buffer.from(before, "base64url").toString().split("|")[2]
    : null;
  const start = afterId ? rows.findIndex((row) => row.id === afterId) + 1 : 0;
  return rows.slice(start, start + 50);
}
