// Generated from FastAPI OpenAPI by scripts/generate_settings_client.py. Do not edit.
export type AccountSettings = { want_list_counting: 'all_at_once' | 'one_at_a_time'; revision: number };
export type SetWantListCounting = { want_list_counting: 'all_at_once' | 'one_at_a_time'; revision: number; idempotency_key: string };
export type WantListCounting = AccountSettings['want_list_counting'];

export class SettingsError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new SettingsError(response.status, payload?.detail?.code ?? 'SETTINGS_REQUEST_FAILED');
  }
  return response.json() as Promise<T>;
}
// The account's settings (decklist import #207): the Want List counting setting and the settings revision.
export const getSettings = () => request<AccountSettings>('/api/settings', 'GET');
// Changes the Want List counting setting: revision-checked (409 STALE_SETTINGS) and idempotent.
export const setWantListCounting = (body: SetWantListCounting) =>
  request<AccountSettings>('/api/settings/want-list-counting', 'PUT', body);
