"""Generate Move request and response types from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/moves_generated.ts"
NAMES = ("MoveItem", "MoveManifest", "MoveResult")

# A refused move names the source, Edition and destination it refused, when the API says which.
FAILURE = """    const failure = payload?.detail;
    const detail: MoveErrorDetail = failure && typeof failure === 'object' && !Array.isArray(failure)
      ? { source_id: failure.source_id, edition_id: failure.edition_id, destination_id: failure.destination_id } : {};
    throw new MoveError(response.status, failure?.code ?? 'MOVE_REQUEST_FAILED', detail);"""

BODY = """
export type MoveErrorDetail = { source_id?: string; edition_id?: string; destination_id?: string };
%(error)s
%(request)s
export const startMove = (source_id?: string) => request<MoveManifest>('/api/moves/manifests', 'POST', source_id ? { source_id } : {});
export const stageMove = (id: string, items: MoveItem[]) => request<MoveManifest>(`/api/moves/manifests/${encodeURIComponent(id)}/items`, 'PUT', { items });
// put_away marks the deck builder's Put away, whose Undo returns the copies to the Deck as surplus (migration 047).
export const commitMove = (id: string, destination_id: string, idempotency_key: string, put_away = false) => request<MoveResult>(`/api/moves/manifests/${encodeURIComponent(id)}/commit`, 'POST', put_away ? { destination_id, idempotency_key, put_away } : { destination_id, idempotency_key });
export const commitMoveWithoutUndo = (id: string, destination_id: string, idempotency_key: string) => request<MoveResult>(`/api/moves/manifests/${encodeURIComponent(id)}/commit-without-undo`, 'POST', { destination_id, idempotency_key });
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("MoveError", "public detail: MoveErrorDetail = {}"),
                   "request": gen.json_request(FAILURE)}
    return gen.assemble([gen.header("generate_moves_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
