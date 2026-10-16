// Generated from FastAPI OpenAPI by scripts/generate_social_client.py. Do not edit.
export type Collector = { collector_id: string; handle: string; display_name: string };
export type CollectorLookup = { collector_id: string; handle: string; display_name: string; relation: "self" | "none" | "friends" | "request_sent" | "request_received" | "blocked" };
export type InviteCollector = { collector_id: string; display_name: string; relation: "self" | "none" | "friends" | "request_sent" | "request_received" | "blocked" };
export type FriendsView = { received: Collector[]; friends: Collector[]; sent: Collector[] };
export type LookupHandle = { handle: string };
export type SendFriendRequest = { collector_id: string; idempotency_key: string };
export type FriendCommand = { idempotency_key: string };
export type FriendCommandResult = { relation: "self" | "none" | "friends" | "request_sent" | "request_received" | "blocked" };
export type BlockCollector = { collector_id: string; idempotency_key: string };
export type BlockedList = { blocked: Collector[] };
export type FriendCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; spare: string; in_deck: string; wanted: boolean };
export type FriendCollection = { collector_id: string; handle: string; display_name: string; show: "wanted" | "all"; cards: FriendCard[]; next_page: number | null };
export type FriendCopy = { collector_id: string; handle: string; display_name: string; edition_id: string; name: string; set_code: string; collector_number: string; descriptor: Record<string, unknown>; other_printing: boolean; spare: string; in_deck: string };
export type WantedCard = { edition_id: string; copies: FriendCopy[] };
export type WantListMatches = { has_friends: boolean; cards: WantedCard[] };
export type CardMatches = { has_friends: boolean; copies: FriendCopy[] };

/** A refused social request: the API's code, and for TOO_MANY_LOOKUPS the detail that says when to try again. */
export class SocialError extends Error {
  constructor(public status: number, public code: string, public detail: Record<string, unknown> = {}) { super(code); }
}
async function request<T>(path: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', signal,
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
/** "?a=1&b=2" from the parameters that are set, or "" when none is. */
const query = (params: Record<string, string | number | null | undefined>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== null && value !== undefined && value !== '') search.set(name, String(value));
  const text = search.toString();
  return text ? `?${text}` : '';
};
/** Which other Card Editions count for a wanted one (Decklist Import's Exact printings or Use cards I own). */
export type Printings = 'exact' | 'reprint_group';
// The Friends drawer: requests received, Friends and requests sent.
export const getFriends = () => request<FriendsView>('/api/social/friends', 'GET');
// Find a collector by their exact Handle; counted toward the hourly limit.
export const lookupHandle = (body: LookupHandle) => request<CollectorLookup>('/api/social/lookup', 'POST', body);
// The Invite Link page signed in: whose link it is and how the two stand.
export const getInvite = (token: string) => request<InviteCollector>(`/api/social/invites/${at(token)}`, 'GET');
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
// Blocks: Settings › Privacy's list, Block (from a Friend's ⋯) and Unblock.
export const getBlocked = () => request<BlockedList>('/api/social/blocks', 'GET');
export const blockCollector = (body: BlockCollector) => request<FriendCommandResult>('/api/social/blocks', 'POST', body);
export const unblockCollector = (id: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/blocks/${at(id)}/unblock`, 'POST', body);
// A Friend's Collection (#250): one page of the cards they could lend now, found by their Handle among your Friends.
export const getFriendCollection = (handle: string,
  params: { show?: 'wanted' | 'all'; q?: string; printings?: Printings; page?: number }, signal?: AbortSignal) =>
  request<FriendCollection>(`/api/social/collections/${at(handle)}${query(params)}`, 'GET', undefined, signal);
// Friends' cards for the Want List in scope (#251): its own read, apart from the Want List's.
export const getWantListMatches = (params: { deck?: string | null; printings?: Printings }, signal?: AbortSignal) =>
  request<WantListMatches>(`/api/social/want-list-matches${query(params)}`, 'GET', undefined, signal);
// Friends who have this (#251): Friends' copies of one Card Printing, for the card popup.
export const getCardMatches = (printingId: string, params: { printings?: Printings }, signal?: AbortSignal) =>
  request<CardMatches>(`/api/social/card-matches${query({ printing_id: printingId, ...params })}`, 'GET', undefined,
    signal);
