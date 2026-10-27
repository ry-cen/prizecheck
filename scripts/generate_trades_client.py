"""Generate the Trades client module (trading #269: the collector's own Trade List; #270: sending a Trade Proposal;
#271: accepting one; #272: each side's own view, Use suggested picks and Confirm swap; #275: ``/api/trade-wants``, the
collector's own Trade Wants and Will accept choices; #277: cash on a send, and the value route; #278: Counter; #279: Deck
switches at Confirm swap; later
Trading tickets add the rest of ``/api/trades``) from the API
OpenAPI schema. Shared Trade facts under ``/api/social`` stay in the social client (scripts/generate_social_client.py),
which this module imports its ``TradeStep`` and ``TradeView`` from."""
import client_generator as gen

TARGET = "web/src/trades_generated.ts"
NAMES = ("TradeListPlace", "TradeListLocation", "TradeListCard", "OwnTradeList", "TradeLineRequest",
         "TradeCashRequest", "SendTradeProposal", "CounterTrade", "TradePickPlace", "SwitchCard", "DeckSwitchOffer",
         "OwnTradeSide", "DeckSwitchRequest", "ConfirmSwap", "SwitchedLine", "SwitchedDeck", "TradeWantLine",
         "WillAcceptChoice",
         "TradeWants", "SetTradeWant", "SetWillAccept",
         "TradeValueLine", "TradeValueRequest", "SideValue", "TradeValue")
ERROR = gen.error_class(
    "TradesError", "public detail: Record<string, unknown> = {}",
    doc="""/** A refused Trades request: the API's code, and its detail. */""")

BODY = """
%(error)s
%(request)s
// Your own Trade List (#269): every card you offer now, with its copies and the For trade Locations they sit in.
export const getTradeList = (signal?: AbortSignal) => request<OwnTradeList>('/api/trades/list', 'GET', undefined, signal);
// Send a Friend a Trade Proposal (#270), idempotent: retry a failed one with the same idempotency_key. It reserves the
// cards you give, and answers the Trade as both sides read it.
export const sendTradeProposal = (body: SendTradeProposal) => request<TradeView>('/api/trades', 'POST', body);
// Accept a Trade Proposal sent to you, whole (#271), idempotent: it reserves the cards you give and answers the Trade.
export const acceptTrade = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/accept`, 'POST', body);
// Counter a Trade Proposal sent to you (#278), idempotent: it closes that proposal, frees the cards its sender gave,
// and sends them this proposal instead, reserving the cards you give. Answers the new Trade as you read it.
export const counterTrade = (id: string, body: CounterTrade) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/counter`, 'POST', body);
// Your own side of a Trade (#272): where your picks take the cards you give from, which are out of date, and the
// suggested picks; and the Deck switches Confirm swap offers for the cards you get in destinationId (#279).
export const getTradeSide = (id: string, signal?: AbortSignal, destinationId?: string | null) =>
  request<OwnTradeSide>(`/api/trades/${encodeURIComponent(id)}/side${destinationId ? `?destination_id=${encodeURIComponent(destinationId)}` : ''}`, 'GET', undefined, signal);
// Replace your out-of-date picks with the suggested ones (#272), idempotent.
export const useSuggestedTradePicks = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/picks/use-suggested`, 'POST', body);
// Confirm the swap for your own Collection (#272), idempotent: the cards you give leave it, the cards you get arrive in
// destination_id (null: Unsorted), the Deck switches you left ticked apply (#279), and the second confirmation closes
// the Trade. Answers the Trade, with each switched Deck's new revision and the batch that undoes its switch.
export const confirmSwap = (id: string, body: ConfirmSwap) =>
  request<ConfirmedSwap>(`/api/trades/${encodeURIComponent(id)}/confirm-swap`, 'POST', body);
// Your own Trade Wants and Will accept choices (#275).
export const getTradeWants = (signal?: AbortSignal) =>
  request<TradeWants>('/api/trade-wants', 'GET', undefined, signal);
// Set one Trade Wants line ("0" removes it), idempotent by value; answers the whole list.
export const setTradeWant = (editionId: string, body: SetTradeWant) =>
  request<TradeWants>(`/api/trade-wants/${encodeURIComponent(editionId)}`, 'PUT', body);
// Set what trades will accept for one card ('edition' is this exact card), idempotent by value; answers the whole list.
export const setWillAccept = (editionId: string, body: SetWillAccept) =>
  request<TradeWants>(`/api/trade-wants/will-accept/${encodeURIComponent(editionId)}`, 'PUT', body);
// Each side's estimated total for a proposal being built or reviewed (#277): a budgeted price access, never a
// suggested amount. Cash is not part of it.
export const getTradeValue = (body: TradeValueRequest, signal?: AbortSignal) =>
  request<TradeValue>('/api/trades/value', 'POST', body, signal);
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    types = []
    for name in NAMES:
        types.append(gen.DOUBLE.alias(name, schemas[name]))
        if name == "SwitchedDeck":
            # ConfirmedSwap is TradeView plus the fields only it has (#279).
            extra = gen.DOUBLE.fields(schemas["ConfirmedSwap"], only=lambda field: field not in schemas["TradeView"]["properties"])
            types.append(f"export type ConfirmedSwap = TradeView & {{ {'; '.join(extra)} }};")
    request = gen.json_request(gen.detail_failure_lines("TradesError", "TRADES_REQUEST_FAILED"), signal=True)
    return gen.assemble([gen.header("generate_trades_client"),
                         'import type { TradeStep, TradeView } from "./social_generated";',
                         *types, BODY % {"error": ERROR, "request": request}])


if __name__ == "__main__":
    gen.main(__name__)
