// Loan set-up through the API for the social network's Loan specs (#254 onwards): the Swap catalog, two collectors
// made Friends with Display Names, Holdings, Decks with lines, and a Loan taken as far as both sides confirming its
// handover. The specs drive in the browser only the steps they cover.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect } from "./collectors";

export const ORIGIN = process.env.TEST_ORIGIN || "http://localhost:5173";
export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };

export type Editions = Record<string, string>;

/** The Swap catalog through the real catalog import (it replaces the catalog); returns the Edition ids by key, such
 * as "PAL 185" (Iono) and "PAL 172" (Boss's Orders). See api/tests/want_list_swap_fixtures.py. */
export function seedCatalog(): Editions {
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

/** One API call as the page's collector; fails the test unless it succeeds. */
export async function api(
  page: Page,
  method: "GET" | "POST" | "PUT" | "DELETE",
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
export async function nameCollector(page: Page, name: string) {
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

export async function accountId(page: Page): Promise<string> {
  return (await api(page, "GET", "/auth/session")).userId as string;
}

/** A Friend Request from `from`, accepted by `to`, through the API. */
export async function befriend(from: Page, to: Page) {
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

export async function unsorted(page: Page): Promise<string> {
  const tree = await api(page, "GET", "/api/location-tree");
  return (tree.locations as { id: string; name: string }[]).find(
    (location) => location.name === "Unsorted"
  )!.id;
}

export const hold = (
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

export async function createDeck(page: Page, name: string): Promise<string> {
  const created = await api(page, "POST", "/api/decks", {
    name,
    idempotency_key: randomUUID(),
  });
  return created.location.id as string;
}

export async function setLine(
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

/** One Loan step through the API, at the Loan's current revision. `path` is the step's route, such as
 * "/api/loans/<id>/handover"; `body` its own fields. */
export async function loanStep(
  page: Page,
  loanId: string,
  path: string,
  body: object = {}
) {
  const loan = await api(page, "GET", `/api/social/loans/${loanId}`);
  return api(page, "POST", path, {
    revision: loan.revision,
    idempotency_key: randomUUID(),
    ...body,
  });
}

/**
 * A Borrow Request from `borrower` to `lender` for these copies (for `deckId`, or none), accepted in full and
 * confirmed handed over by both sides: the lender's copies leave their Locations, and the borrower's arrive in the
 * Deck (or Unsorted) as Borrowed Copies. Returns the Loan id.
 */
export async function lendHandedOver(
  lender: Page,
  borrower: Page,
  lines: [edition: string, copies: number][],
  deckId: string | null = null
): Promise<string> {
  const sent = await api(borrower, "POST", "/api/loans", {
    lender_id: await accountId(lender),
    lines: lines.map(([edition, copies]) => ({
      edition_id: edition,
      quantity: String(copies),
    })),
    deck_id: deckId,
    idempotency_key: randomUUID(),
  });
  await loanStep(lender, sent.id, `/api/loans/${sent.id}/accept`, {
    lines: lines.map(([edition, copies]) => ({
      edition_id: edition,
      promised: String(copies),
    })),
  });
  await loanStep(lender, sent.id, `/api/loans/${sent.id}/handover`);
  await loanStep(borrower, sent.id, `/api/loans/${sent.id}/handover`);
  return sent.id as string;
}
