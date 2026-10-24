// Trade set-up through the API for the specs that end a friendship with open Trades (Trading #274): a For trade
// Storage Leaf, a Trade Proposal, and a Trade step at the Trade's current revision. The specs drive in the browser only
// the steps they cover. The Trade specs of #270 to #273 keep their own copies.
import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Page, Response } from "@playwright/test";
import { api } from "./loans";

/** The sizes the Trade stories run at: desktop, and 375 px with touch. */
export const DESKTOP_SIZE: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
};
export const PHONE_SIZE: BrowserContextOptions = {
  viewport: { width: 375, height: 812 },
  isMobile: true,
  hasTouch: true,
};

/** A response's body, read at once; null only when Chromium no longer holds it, which happens to a read the app
 * aborted itself (a reload of Deck switch offers, a page that moved on). Any other error still fails the test. */
export function bodyOf(response: Response): Promise<string | null> {
  return response.text().catch((error: Error) => {
    if (/navigated away from/.test(error.message)) return null;
    throw error;
  });
}

/** A top-level Storage Leaf marked For trade; returns its id. */
export async function forTradeLeaf(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/location-tree", {
    name,
    parent_id: null,
    parent_version: null,
    idempotency_key: randomUUID(),
  });
  const location = created.location as { id: string; version: number };
  await api(page, "PUT", `/api/location-tree/${location.id}/for-trade`, {
    for_trade: true,
    version: location.version,
    idempotency_key: randomUUID(),
  });
  return location.id;
}

/** The page's collector sends `to` a Trade Proposal; returns its id. */
export async function propose(
  page: Page,
  to: string,
  give: [edition: string, copies: number][],
  get: [edition: string, copies: number][]
): Promise<string> {
  const line = ([edition_id, n]: [string, number]) => ({
    edition_id,
    quantity: String(n),
  });
  const trade = await api(page, "POST", "/api/trades", {
    recipient_id: to,
    you_give: give.map(line),
    you_get: get.map(line),
    idempotency_key: randomUUID(),
  });
  return trade.id as string;
}

/** One Trade step through the API at the Trade's current revision: "accept" or "confirm-swap" (to Unsorted). */
export async function tradeStep(
  page: Page,
  tradeId: string,
  step: "accept" | "confirm-swap"
) {
  const trade = await api(page, "GET", `/api/social/trades/${tradeId}`);
  return api(page, "POST", `/api/trades/${tradeId}/${step}`, {
    revision: trade.revision,
    idempotency_key: randomUUID(),
    ...(step === "confirm-swap" ? { destination_id: null } : {}),
  });
}

/** The page's collector sends the collector with this trader id a Trade Proposal (Stage 2: strangers are addressed by trader id only); returns its id. */
export async function proposeToTrader(
  page: Page,
  traderId: string,
  give: [edition: string, copies: number][],
  get: [edition: string, copies: number][]
): Promise<string> {
  const line = ([edition_id, n]: [string, number]) => ({
    edition_id,
    quantity: String(n),
  });
  const trade = await api(page, "POST", "/api/trades", {
    recipient_trader_id: traderId,
    you_give: give.map(line),
    you_get: get.map(line),
    idempotency_key: randomUUID(),
  });
  return trade.id as string;
}
