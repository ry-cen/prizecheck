import { expect, it } from "vitest";
import {
  SocialError,
  type LoanSide,
  type LoanStep,
  type LoanView,
} from "../social_generated";
import { handoverCommand } from "./handoverCommand";
const loan: LoanView = {
  id: "round",
  loan_id: "round",
  thread_id: "thread",
  kind: "borrow_request",
  state: "accepted",
  closed_reason: null,
  closed_by: null,
  role: "borrower",
  other: { collector_id: "lender", display_name: "Ash" },
  return_by: null,
  you_confirmed_handover: false,
  they_confirmed_handover: false,
  lines: [
    {
      edition_id: "iono",
      name: "Iono",
      set_code: "PAL",
      set_name: "Paldea",
      collector_number: "185",
      descriptor: { finish: "normal" },
      image_url: null,
      requested: "1",
      promised: "1",
      written_off: "0",
      returned: "0",
    },
  ],
  needs_you: false,
  section: "pending",
  actions: ["confirm_handover"],
  revision: 2,
};
const side: LoanSide = {
  loan_id: "round",
  deck: null,
  can_promise: [],
  picks: [],
  suggested: [],
};
it("replays the exact bounded retry after its successful response is lost", async () => {
  const bodies = new Map<string, LoanStep>(),
    wire: string[] = [];
  const fresh = { ...loan, revision: 3, they_confirmed_handover: true };
  const applied = { ...fresh, revision: 4, you_confirmed_handover: true };
  let receipt: { body: string; response: LoanView } | null = null,
    mutations = 0,
    borrowedCopies = 0;
  const api = {
    read: async () => fresh,
    readSide: async () => side,
    confirm: async (_id: string, body: LoanStep) => {
      const bytes = JSON.stringify(body);
      wire.push(bytes);
      if (receipt) {
        if (bytes !== receipt.body)
          throw new SocialError(409, "IDEMPOTENCY_KEY_REUSED");
        return receipt.response;
      }
      if (body.revision !== 3) throw new SocialError(409, "LOAN_CHANGED");
      mutations++;
      borrowedCopies++;
      receipt = { body: bytes, response: applied };
      throw new TypeError("Response lost after inventory commit");
    },
  };
  let view = loan;
  await expect(
    handoverCommand(loan, side, "retained-key", bodies, api, (fresh) => {
      view = fresh;
    })
  ).rejects.toThrow("Response lost");
  expect(view.revision).toBe(3);
  expect(
    await handoverCommand(view, side, "retained-key", bodies, api, () => {})
  ).toEqual(applied);
  expect(wire.map((bytes) => JSON.parse(bytes).revision)).toEqual([2, 3, 3]);
  expect(bodies.get("retained-key")?.revision).toBe(3);
  expect(wire[2]).toBe(wire[1]);
  expect(
    new Set(wire.map((bytes) => JSON.parse(bytes).idempotency_key))
  ).toEqual(new Set(["retained-key"]));
  expect(mutations).toBe(1);
  expect(borrowedCopies).toBe(1);
});
