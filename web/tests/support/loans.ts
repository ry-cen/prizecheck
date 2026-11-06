// Loan set-up through the API for the social network's Loan specs (#254 onwards): the Swap catalog, two collectors
// made Friends with Display Names, Holdings, Decks with lines, and a Loan taken as far as both sides confirming its
// handover. The specs drive in the browser only the steps they cover.
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect } from "./collectors";
import type {
  LoanDetail,
  LoanResolution,
  LoanView,
  ThreadItem,
} from "../../src/social_generated";

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

/** The page's collector deletes their account, as api/tests/test_returns.py's `leave` does: their owner row goes, its
 * own rows with it, and their side of each Loan is set to NULL. */
export async function leave(page: Page) {
  const id = await accountId(page);
  execFileSync(
    ".venv/bin/python",
    [
      "-c",
      "import sys\nfrom app.main import connect\nwith connect() as conn:\n    conn.execute('DELETE FROM inventory_owner WHERE user_id=%s', (sys.argv[1],))",
      id,
    ],
    { env: { ...process.env, PYTHONPATH: "api" } }
  );
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

/** Read current terms through the round-or-thread resolver, keeping inventory assertions free to use round IDs. */
export async function loanView(page: Page, id: string): Promise<LoanView> {
  const found: LoanResolution = await api(
    page,
    "GET",
    `/api/loans/resolve/${id}`
  );
  const detail: LoanDetail = await api(
    page,
    "GET",
    `/api/loans/${found.thread_id}`
  );
  return detail.live_terms;
}

/** All item groups, including requests awaiting the other participant. */
export async function loanItems(page: Page): Promise<ThreadItem[]> {
  const pages: ThreadItem[][] = await Promise.all(
    ["needs_you", "open", "out_now", "pending", "done"].map((group) =>
      api(page, "GET", `/api/loans?group=${group}`)
    )
  );
  return [...new Map(pages.flat().map((item) => [item.id, item])).values()];
}

/** One strict thread command, bound to the current Loan terms and revision. */
export async function loanStep(
  page: Page,
  loanId: string,
  step:
    | "accept"
    | "decline"
    | "withdraw"
    | "cancel"
    | "handover"
    | "returns"
    | "write-off",
  body: object = {}
) {
  const loan = await loanView(page, loanId);
  return api(page, "POST", `/api/loans/${loan.thread_id}/${step}`, {
    loan_id: loan.loan_id,
    revision: loan.revision,
    idempotency_key: randomUUID(),
    ...body,
  });
}

/**
 * A Borrow Request from `borrower` to `lender` for these copies (for `deckId`, or none), accepted in full and
 * confirmed handed over by both sides: the lender's copies leave their Locations, and the borrower's arrive in the
 * Deck (or Unsorted) as Borrowed Copies. `returnBy`: the requested return-by date ("2099-01-31"), kept on accepting.
 * Returns the Loan id.
 */
export async function lendHandedOver(
  lender: Page,
  borrower: Page,
  lines: [edition: string, copies: number][],
  deckId: string | null = null,
  returnBy: string | null = null
): Promise<string> {
  const sent = await api(borrower, "POST", "/api/loans", {
    lender_id: await accountId(lender),
    lines: lines.map(([edition, copies]) => ({
      edition_id: edition,
      quantity: String(copies),
    })),
    deck_id: deckId,
    return_by: returnBy,
    idempotency_key: randomUUID(),
  });
  await loanStep(lender, sent.id, "accept", {
    lines: lines.map(([edition, copies]) => ({
      edition_id: edition,
      promised: String(copies),
    })),
  });
  await loanStep(lender, sent.id, "handover");
  await loanStep(borrower, sent.id, "handover");
  return sent.id as string;
}
