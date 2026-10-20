"""Generate the Trades client module (trading #269: the collector's own Trade List; #270: sending a Trade Proposal;
#271: accepting one; later Trading tickets add the rest of ``/api/trades`` and ``/api/trade-wants``) from the API
OpenAPI schema. Shared Trade facts under ``/api/social`` stay in the social client (scripts/generate_social_client.py),
which this module imports its ``TradeStep`` and ``TradeView`` from."""
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if "enum" in value:
        return " | ".join(f'"{item}"' for item in value["enum"])
    if value.get("type") == "array":
        inner = ts_type(value["items"])
        return f"({inner})[]" if " | " in inner else f"{inner}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean",
            "null": "null", "object": "Record<string, unknown>"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_trades_client.py. Do not edit.",
         'import type { TradeStep, TradeView } from "./social_generated";']
for name in ("TradeListPlace", "TradeListLocation", "TradeListCard", "OwnTradeList", "TradeLineRequest",
             "SendTradeProposal"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
/** A refused Trades request: the API's code, and its detail. */
export class TradesError extends Error {
  constructor(public status: number, public code: string, public detail: Record<string, unknown> = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', signal,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
    throw new TradesError(response.status, detail.code ?? 'TRADES_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
// Your own Trade List (#269): every card you offer now, with its copies and the For trade Locations they sit in.
export const getTradeList = (signal?: AbortSignal) => request<OwnTradeList>('/api/trades/list', 'GET', undefined, signal);
// Send a Friend a Trade Proposal (#270), idempotent: retry a failed one with the same idempotency_key. It reserves the
// cards you give, and answers the Trade as both sides read it.
export const sendTradeProposal = (body: SendTradeProposal) => request<TradeView>('/api/trades', 'POST', body);
// Accept a Trade Proposal sent to you, whole (#271), idempotent: it reserves the cards you give and answers the Trade.
export const acceptTrade = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/trades/${encodeURIComponent(id)}/accept`, 'POST', body);
""")
content = "\n".join(lines)
target = root / "web/src/trades_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated Trades client is stale")
else:
    target.write_text(content)
