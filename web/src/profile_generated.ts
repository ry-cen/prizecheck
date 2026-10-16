// Generated from FastAPI OpenAPI by scripts/generate_profile_client.py. Do not edit.
export type CollectorProfile = { handle: string; display_name: string; handle_change_available_at: string | null; invite_token: string };
export type SetDisplayName = { display_name: string; idempotency_key: string };
export type SetHandle = { handle: string; idempotency_key: string };
export type NewInviteLink = { idempotency_key: string };
export type PublicInvite = { display_name: string };

/** A refused profile request: the API's code, and for HANDLE_CHANGE_TOO_SOON and TOO_MANY_HANDLE_TRIES the detail
 * that says when to try again. */
export class ProfileError extends Error {
  constructor(public status: number, public code: string, public detail: Record<string, unknown> = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
    throw new ProfileError(response.status, detail.code ?? 'PROFILE_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
// The signed-in collector's Handle, Display Name and Invite Link token; the first read makes the link.
export const getProfile = () => request<CollectorProfile>('/api/profile', 'GET');
// Idempotent changes: retry a failed one with the same idempotency_key.
export const setDisplayName = (body: SetDisplayName) => request<CollectorProfile>('/api/profile/display-name', 'PUT', body);
export const setHandle = (body: SetHandle) => request<CollectorProfile>('/api/profile/handle', 'PUT', body);
export const newInviteLink = (body: NewInviteLink) => request<CollectorProfile>('/api/profile/invite-link', 'POST', body);
// The signed-out Invite Link page's read: the Display Name only.
export const getPublicInvite = (token: string) =>
  request<PublicInvite>(`/api/public/invites/${encodeURIComponent(token)}`, 'GET');
