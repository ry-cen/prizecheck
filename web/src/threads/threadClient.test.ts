import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getLoan,
  getLoans,
  getTrade,
  getThreadPulse,
  getThreadTimeline,
  sendThreadMessage,
} from "../social_generated";
import { prefilledMessagePath, readPrefill } from "../trades/messagePrefill";
afterEach(() => vi.unstubAllGlobals());
function replies(...bodies: unknown[]) {
  const fetch = vi.fn();
  for (const body of bodies)
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 })
    );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("item thread wire contract", () => {
  it("resolves old Loan and Trade identifiers before unwrapping their live agreement", async () => {
    const fetch = replies(
      { thread_id: "loan-thread" },
      { live_terms: { loan_id: "live-loan" } },
      { thread_id: "trade-thread" },
      { live_offer: { offer_id: "live-offer" } }
    );
    expect(await getLoan("old-loan")).toEqual({ loan_id: "live-loan" });
    expect(await getTrade("old-trade")).toEqual({ offer_id: "live-offer" });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/loans/resolve/old-loan",
      "/api/loans/loan-thread",
      "/api/trades/resolve/old-trade",
      "/api/trades/trade-thread",
    ]);
  });
  it("reads every Loan group and deduplicates overlapping open groups", async () => {
    const row = { id: "one" };
    const fetch = replies([row], [], [row], [], []);
    expect(await getLoans()).toEqual([row]);
    expect(fetch.mock.calls.map((call) => call[0])).toEqual(
      ["needs_you", "open", "out_now", "pending", "done"].map(
        (group) => `/api/loans?group=${group}`
      )
    );
  });
  it("does not page the unbounded Needs you group", async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ id: String(i) }));
    const fetch = replies(rows, [], [], [], []);
    expect(await getLoans()).toEqual(rows);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
  it("uses item timeline, message key and the shared pulse without pair endpoints", async () => {
    const command = { body: "Meet at league?", idempotency_key: "held-key" };
    const fetch = replies(
      { items: [], you_are: "low" },
      { id: "message" },
      { trades: { needs_you: 3, waiting: 2, unread: 2 } }
    );
    await getThreadTimeline("trade", "thread", "cursor");
    await sendThreadMessage("trade", "thread", command);
    expect(await getThreadPulse()).toEqual({
      trades: { needs_you: 3, waiting: 2, unread: 2 },
    });
    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      "/api/trades/thread/timeline?before=cursor",
      "/api/trades/thread/messages",
      "/api/threads/pulse",
    ]);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(command);
  });
  it("keeps a card question editable in the new item composer", () => {
    const path = prefilledMessagePath("trader", "Is Iono available?");
    expect(path).toBe("/trades/new/trader?draft=Is+Iono+available%3F");
    expect(readPrefill(path.slice(path.indexOf("?")))).toBe(
      "Is Iono available?"
    );
  });
});
