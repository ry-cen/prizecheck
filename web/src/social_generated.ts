// Generated from FastAPI OpenAPI by scripts/generate_social_client.py. Do not edit.
export type Collector = { collector_id: string; handle: string; display_name: string };
export type CollectorLookup = { collector_id: string; handle: string; display_name: string; relation: "self" | "none" | "friends" | "request_sent" | "request_received" };
export type FriendsView = { received: Collector[]; friends: Collector[]; sent: Collector[] };
export type LookupHandle = { handle: string };
export type SendFriendRequest = { collector_id: string; idempotency_key: string };
export type FriendCommand = { idempotency_key: string };
export type FriendCommandResult = { relation: "self" | "none" | "friends" | "request_sent" | "request_received" };

/** A refused social request: the API's code, and for TOO_MANY_LOOKUPS the detail that says when to try again. */
export class SocialError extends Error {
  constructor(public status: number, public code: string, public detail: Record<string, unknown> = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const detail = payload?.detail && typeof payload.detail === 'object' ? payload.detail : {};
    throw new SocialError(response.status, detail.code ?? 'SOCIAL_REQUEST_FAILED', detail);
  }
  return response.json() as Promise<T>;
}
const at = (id: string) => encodeURIComponent(id);
// The Friends drawer: requests received, Friends and requests sent.
export const getFriends = () => request<FriendsView>('/api/social/friends', 'GET');
// Find a collector by their exact Handle; counted toward the hourly limit.
export const lookupHandle = (body: LookupHandle) => request<CollectorLookup>('/api/social/lookup', 'POST', body);
// The Invite Link page signed in: whose link it is and how the two stand.
export const getInvite = (token: string) => request<CollectorLookup>(`/api/social/invites/${at(token)}`, 'GET');
// Idempotent commands: retry a failed one with the same idempotency_key.
export const sendFriendRequest = (body: SendFriendRequest) =>
  request<FriendCommandResult>('/api/social/friend-requests', 'POST', body);
export const acceptFriendRequest = (id: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/friend-requests/${at(id)}/accept`, 'POST', body);
export const declineFriendRequest = (id: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/friend-requests/${at(id)}/decline`, 'POST', body);
export const withdrawFriendRequest = (id: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/friend-requests/${at(id)}/withdraw`, 'POST', body);
export const removeFriend = (id: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/friends/${at(id)}/remove`, 'POST', body);
