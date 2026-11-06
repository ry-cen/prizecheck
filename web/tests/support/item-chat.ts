import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type { ThreadItem, TradeView } from "../../src/social_generated";
import type { OwnTradeList } from "../../src/trades_generated";
import { api } from "./loans";
import { expect } from "./collectors";
import { tradeStep } from "./trades";

/** Item chat setup uses an existing agreement when possible. If the story has only
 * messages, create and explicitly withdraw a proposal first: closed chat remains
 * available, without adding a live promise or cancellation to its moderation counts. */
export async function tradeThreadFor(
  page: Page,
  trader: string
): Promise<string> {
  for (const group of ["open", "needs_you", "done"]) {
    const rows: ThreadItem[] = await api(
      page,
      "GET",
      `/api/trades?group=${group}&with=${encodeURIComponent(trader)}`
    );
    for (const row of rows)
      expect(
        row.other.trader_id,
        "Item chat setup stays with its intended collector"
      ).toBe(trader);
    if (rows[0]) return rows[0].id;
  }
  const list: OwnTradeList = await api(page, "GET", "/api/trades/list");
  const card = list.cards.find((card) => Number(card.copies) > 0);
  expect(
    card,
    "The chat fixture has a real available card to offer"
  ).toBeDefined();
  const sent: TradeView = await api(page, "POST", "/api/trades", {
    recipient_trader_id: trader,
    you_give: [{ edition_id: card!.edition_id, quantity: "1" }],
    you_get: [],
    idempotency_key: randomUUID(),
  });
  await tradeStep(page, sent.thread_id, "withdraw");
  return sent.thread_id;
}
export async function sendItemMessage(
  page: Page,
  trader: string,
  body: string
) {
  const thread = await tradeThreadFor(page, trader);
  await api(page, "POST", `/api/trades/${thread}/messages`, {
    body,
    idempotency_key: randomUUID(),
  });
  return thread;
}
