import { afterEach, describe, expect, it, vi } from "vitest";
import {
  sendTradeProposal,
  type SendTradeProposal,
} from "../trade_send_generated";
import { initialSendOutcome } from "./initialSendOutcome";
import { TradesError } from "../trades_generated";

const body: SendTradeProposal = {
  recipient_trader_id: "22222222-2222-4222-8222-222222222222",
  you_give: [
    { edition_id: "11111111-1111-4111-8111-111111111111", quantity: "01" },
  ],
  you_get: [],
  cash: null,
  message: "  Hello\r\nCafe\u0301\u202e  ",
  idempotency_key: "33333333-3333-4333-8333-333333333333",
};
afterEach(() => vi.unstubAllGlobals());

describe("generated initial-send transport", () => {
  it.each([false, true])(
    "submits the unchanged body/key and preserves the response union (envelope=%s)",
    async (envelope) => {
      const trade = {
        id: "current-round",
        thread_id: "thread",
        offer_id: "current-round",
      };
      const result = envelope
        ? {
            outcome: "already_applied",
            view: "current",
            label: "Current Trade",
            trade,
          }
        : trade;
      const fetch = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(result), { status: 201 })
        );
      vi.stubGlobal("fetch", fetch);
      expect(await sendTradeProposal(body)).toEqual(result);
      expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/trades", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  );
  it("preserves terminal error detail with the existing error identity", async () => {
    const detail = {
      code: "TRADE_SEND_ALREADY_APPLIED_UNAVAILABLE",
      outcome: "already_applied",
      view: "unavailable",
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ detail }), { status: 409 })
        )
    );
    const request = sendTradeProposal(body);
    await expect(request).rejects.toBeInstanceOf(TradesError);
    await expect(request).rejects.toMatchObject({
      status: 409,
      code: detail.code,
      detail,
    });
  });
  it.each([
    { outcome: "applied", view: "current", label: "Current Trade", trade: {} },
    {
      outcome: "already_applied",
      view: "original",
      label: "Current Trade",
      trade: {},
    },
    {
      outcome: "already_applied",
      view: "current",
      label: "Original Trade",
      trade: {},
    },
  ])(
    "refuses an unrecognized envelope without declaring the draft terminal",
    async (result) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify(result), { status: 201 })
          )
      );
      const response = await sendTradeProposal(body);
      expect(() => initialSendOutcome(response)).toThrow(TypeError);
    }
  );
  it("leaves network failures unknown", async () => {
    const error = new TypeError("Failed to fetch");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    await expect(sendTradeProposal(body)).rejects.toBe(error);
  });
});
