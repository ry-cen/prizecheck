"""Generate Holding request and response types from the API's OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/holdings_generated.ts"
NAMES = ("HoldingView", "LeafHoldings", "AddResult", "AddHolding", "BatchAddItem", "BatchAdd", "BatchAddResult")

# A batch add's refusal can name the Card Edition it refused, so this error carries it.
ERROR = gen.error_class(
    "HoldingError", "public editionId: string | null = null",
    constructor_doc="/** The Card Edition a batch add refused (EDITION_UNAVAILABLE, QUANTITY_OVERFLOW), when the API names one. */")
FAILURE = """    const detail = payload?.detail;
    throw new HoldingError(response.status, detail?.code ?? 'HOLDING_REQUEST_FAILED',
      typeof detail?.edition_id === 'string' ? detail.edition_id : null);"""

BODY = """
%(error)s
%(request)s
export type LeafFilters = { name?: string; set_id?: string; collector_number?: string; sort?: 'name' | 'quantity' };
export const getLeafHoldings = (locationId: string, cursor?: string, filters: LeafFilters = {}) => {
  const query = new URLSearchParams({ ...filters, ...(cursor ? { cursor } : {}) });
  return request<LeafHoldings>(`/api/holdings/${encodeURIComponent(locationId)}?${query}`);
};
export const addHolding = (body: AddHolding) => request<AddResult>('/api/holdings', 'POST', body);
export const batchAddHoldings = (body: BatchAdd) => request<BatchAddResult>('/api/holdings/batch', 'POST', body);
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": ERROR, "request": gen.json_request(FAILURE, method="method = 'GET'")}
    return gen.assemble([gen.header("generate_holdings_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
