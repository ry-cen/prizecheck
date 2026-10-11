// Generated from FastAPI OpenAPI by scripts/generate_mass_entry_client.py. Do not edit.
export type MassEntryLineView = { quantity: string; text: string; less_specific: boolean };
export type MassEntryView = { status: "link" | "text" | "empty"; url: string | null; fallback_reason: "missing_mapping" | "encoded_length" | "quantity_unsupported" | null; text: string | null; inline: boolean; byte_length: number; lines: (MassEntryLineView)[]; line_count: number; less_specific_count: number; total_copies: string; owner_revision: number; catalog_revision: number };
export type PublishedMassEntryView = { version: number; digest: string; status: "link" | "text" | "empty"; url: string | null; fallback_reason: "missing_mapping" | "encoded_length" | "quantity_unsupported" | null; text: string | null; inline: boolean; byte_length: number; lines: (MassEntryLineView)[]; line_count: number; less_specific_count: number; total_copies: string };

export class MassEntryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const base = (id: string) => `/api/decks/${encodeURIComponent(id)}/exports/tcgplayer`;
export async function getMassEntryExport(id: string, signal?: AbortSignal): Promise<MassEntryView> {
  const response = await fetch(base(id), { credentials: 'same-origin', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new MassEntryError(response.status, payload?.detail?.code ?? 'MASS_ENTRY_REQUEST_FAILED');
  }
  return response.json() as Promise<MassEntryView>;
}
export const massEntryDownloadHref = (id: string, ownerRevision: number) => `${base(id)}.txt?owner_revision=${ownerRevision}`;
export const MASS_ENTRY_DOWNLOAD_NAME = 'tcgplayer-mass-entry.txt';
// A Published Deck's Mass Entry export: only the token and the snapshot version are sent, and no cookie.
const publishedBase = (token: string, version: number) => `/api/public/decks/${encodeURIComponent(token)}/versions/${version}/exports/tcgplayer`;
export async function getPublishedMassEntry(token: string, version: number, signal?: AbortSignal): Promise<PublishedMassEntryView> {
  const response = await fetch(publishedBase(token, version), { credentials: 'omit', signal });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new MassEntryError(response.status, payload?.detail?.code ?? 'MASS_ENTRY_REQUEST_FAILED');
  }
  return response.json() as Promise<PublishedMassEntryView>;
}
export const publishedMassEntryDownloadHref = (token: string, version: number) => `${publishedBase(token, version)}.txt`;
