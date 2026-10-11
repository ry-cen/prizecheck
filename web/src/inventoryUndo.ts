import {
  MoveError,
  type MoveErrorDetail,
  type MoveResult,
} from "./moves_generated";
/** One Undo record from GET /api/moves/undo. `source_id` is set only when exactly one source was involved. */
export type UndoEntry = {
  id: string;
  action: "move" | "remove";
  source_id: string | null;
  destination_id: string | null;
  source_count: number;
  expires_at: string;
};
async function request<T>(
  path: string,
  method = "GET",
  body?: object
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const failure = (await response.json().catch(() => ({})))?.detail;
    // FastAPI 422 validation bodies carry an array here; only object-shaped details name Locations.
    const detail: MoveErrorDetail =
      failure && typeof failure === "object" && !Array.isArray(failure)
        ? {
            source_id: failure.source_id,
            edition_id: failure.edition_id,
            destination_id: failure.destination_id,
          }
        : {};
    throw new MoveError(
      response.status,
      failure?.code ?? "REQUEST_FAILED",
      detail
    );
  }
  return response.status === 204
    ? (undefined as T)
    : (response.json() as Promise<T>);
}
export const removeInventory = (manifest: string, key: string) =>
  request<MoveResult>(
    `/api/moves/manifests/${encodeURIComponent(manifest)}/remove`,
    "POST",
    { idempotency_key: key }
  );
export const listUndo = () => request<UndoEntry[]>("/api/moves/undo");
export const applyUndo = (id: string, key: string) =>
  request<MoveResult>(`/api/moves/undo/${encodeURIComponent(id)}`, "POST", {
    idempotency_key: key,
  });
export const dismissUndo = (id: string) =>
  request<void>(`/api/moves/undo/${encodeURIComponent(id)}`, "DELETE");
