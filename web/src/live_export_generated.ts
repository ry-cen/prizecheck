// Generated from FastAPI OpenAPI by scripts/generate_live_export_client.py. Do not edit.
export type LiveBlockerView = { edition_id: string; name: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; quantity: string; reason: string };
export type LiveExportView = { status: "ok" | "blocked" | "empty"; text: string | null; inline: boolean; byte_length: number; total_copies: string; blockers: LiveBlockerView[]; owner_revision: number; catalog_revision: number };
export type PublishedLiveBlockerView = { name: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; quantity: string; reason: string };
export type PublishedLiveExportView = { version: number; digest: string; status: "ok" | "blocked" | "empty"; text: string | null; inline: boolean; byte_length: number; total_copies: string; blockers: PublishedLiveBlockerView[] };

export class LiveExportError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export async function getLiveExport(deckId: string): Promise<LiveExportView> {
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/exports/live`, { credentials: 'same-origin' });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new LiveExportError(response.status, payload?.detail?.code ?? 'LIVE_EXPORT_FAILED');
  }
  return response.json() as Promise<LiveExportView>;
}
export const liveExportDownloadHref = (deckId: string, ownerRevision: number) =>
  `/api/decks/${encodeURIComponent(deckId)}/exports/live.txt?owner_revision=${ownerRevision}`;

// A Published Deck's Live export: only the token and the snapshot version are sent, and no cookie.
export async function getPublishedLiveExport(token: string, version: number, signal?: AbortSignal): Promise<PublishedLiveExportView> {
  const response = await fetch(`/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/live`, { credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new LiveExportError(response.status, payload?.detail?.code ?? 'LIVE_EXPORT_FAILED');
  }
  return response.json() as Promise<PublishedLiveExportView>;
}
export const publishedLiveExportDownloadHref = (token: string, version: number) =>
  `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/live.txt`;
