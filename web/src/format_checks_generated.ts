// Generated from FastAPI OpenAPI by scripts/generate_format_checks_client.py. Do not edit.
export type FormatIssue = { code: string; reason: string; kind: 'deck' | 'card'; effect: 'not_legal' | 'unknown'; lines: string[] };
export type FormatCheck = { format: string; status: 'legal' | 'not_legal' | 'unknown'; issues: FormatIssue[]; rules_version: string; evaluated_on: string; notes: string[]; computed_at: string };
export type DeckFormatChecks = { deck_id: string; deck_list_revision: number; attribute_revision: number; catalog_revision: number; results: FormatCheck[]; disclaimer: string };
export type PublishedFormatIssue = { code: string; reason: string; kind: 'deck' | 'card'; effect: 'not_legal' | 'unknown'; lines: string[] };
export type PublishedFormatCheck = { format: string; status: 'legal' | 'not_legal' | 'unknown'; issues: PublishedFormatIssue[]; rules_version: string; evaluated_on: string; notes: string[]; computed_at: string };
export type PublishedDeckFormatChecks = { version: number; digest: string; results: PublishedFormatCheck[]; disclaimer: string };

export class FormatCheckError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
// Advisory Standard (and later Expanded and Gym Leader Challenge) results for a Deck's Deck List. ``format`` narrows the
// response to one format; ``asOf`` (YYYY-MM-DD) checks as of that date instead of today.
export async function getDeckFormatChecks(deckId: string, options: { format?: string; asOf?: string } = {},
                                          signal?: AbortSignal): Promise<DeckFormatChecks> {
  const query = new URLSearchParams();
  if (options.format) query.set('format', options.format);
  if (options.asOf) query.set('as_of', options.asOf);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const response = await fetch(`/api/decks/${encodeURIComponent(deckId)}/format-checks${suffix}`,
                               { method: 'GET', credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new FormatCheckError(response.status, payload?.detail?.code ?? 'FORMAT_CHECK_REQUEST_FAILED');
  }
  return response.json() as Promise<DeckFormatChecks>;
}
// A Published Deck's advisory results, recomputed from current public card facts: only the token, the snapshot version
// and the same optional ``format``/``asOf`` are sent, and no cookie. An issue's ``lines`` are the frozen rows' public
// Edition references ("row:<n>" for a legacy row without one).
export async function getPublishedFormatChecks(token: string, version: number,
                                               options: { format?: string; asOf?: string } = {},
                                               signal?: AbortSignal): Promise<PublishedDeckFormatChecks> {
  const query = new URLSearchParams();
  if (options.format) query.set('format', options.format);
  if (options.asOf) query.set('as_of', options.asOf);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const response = await fetch(
    `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/format-checks${suffix}`,
    { method: 'GET', credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new FormatCheckError(response.status, payload?.detail?.code ?? 'FORMAT_CHECK_REQUEST_FAILED');
  }
  return response.json() as Promise<PublishedDeckFormatChecks>;
}
