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
export type LoanParty = { collector_id: string | null; display_name: string; handle: string | null };
export type LoanCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; requested: string; promised: string; written_off: string; returned?: string };
export type ReturnLine = { edition_id: string; copies: string };
export type PendingReturn = { started_by: "you" | "them"; lines: ReturnLine[]; you_confirmed: boolean; they_confirmed: boolean };
export type LoanView = { id: string; kind: "borrow_request" | "lend_offer"; state: "requested" | "offered" | "accepted" | "handed_over" | "closed"; closed_reason: "declined" | "withdrawn" | "cancelled" | "returned" | "written_off" | null; closed_by: "you" | "them" | null; role: "lender" | "borrower"; other: LoanParty; return_by: string | null; you_confirmed_handover: boolean; they_confirmed_handover: boolean; lines: LoanCard[]; needs_you: boolean; section: "needs_you" | "out_now" | "pending" | "history"; actions: ("accept" | "decline" | "confirm_handover" | "start_return" | "confirm_return" | "choose_written_off" | "withdraw" | "take_back" | "cancel" | "write_off" | "change_return_by" | "ask_for_more_time" | "approve_extension" | "decline_extension" | "edit_and_resend")[]; revision: number; pending_return?: PendingReturn | null; awaiting_choice?: string; extension_to?: string | null; overdue_since?: string | null; notices?: ("overdue" | "nudge_answer" | "nudge_handover")[]; waiting?: "answer" | "fix_picks" | "choose" | "confirm_return" | "finish_return" | "hand_over" | "receive" | "return" | "more_time" | null };
export type LoansView = { loans: LoanView[]; needs_you: number };
export type LoanStep = { revision: number; idempotency_key: string };
export type LoanLineRequest = { edition_id: string; quantity: string };
export type SendBorrowRequest = { lender_id: string; lines: LoanLineRequest[]; deck_id?: string | null; return_by?: string | null; replaces?: string | null; idempotency_key: string };
export type PromisedLine = { edition_id: string; promised: string };
export type AcceptBorrowRequest = { revision: number; idempotency_key: string; lines: PromisedLine[]; return_by?: string | null };
export type PromiseLimit = { edition_id: string; available: string };
export type LoanPickPlace = { edition_id: string; location_id: string | null; name: string; copies: string; short: string };
export type LoanDeck = { id: string; name: string };
export type LoanSide = { loan_id: string; deck: LoanDeck | null; can_promise: PromiseLimit[]; picks: LoanPickPlace[]; suggested: LoanPickPlace[]; awaiting_choice?: LoanPickPlace[] };
export type LentCard = { loan_id: string; edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; image_url: string | null; copies: string; borrower: string };
export type LentOut = { cards: LentCard[]; copies: string };
export type BorrowedCard = { loan_id: string; edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; location_id: string; location_name: string; copies: string; lender: string };
export type BorrowedCopies = { cards: BorrowedCard[]; copies: string };
export type MoveBorrowed = { loan_id: string; edition_id: string; from_location_id: string; to_location_id: string; quantity: string; idempotency_key: string };
export type ReturnedLine = { edition_id: string; quantity: string };
export type StartReturn = { revision: number; idempotency_key: string; lines: ReturnedLine[] };
export type WriteOffLine = { edition_id: string; quantity: string };
export type WriteOff = { revision: number; idempotency_key: string; lines: WriteOffLine[] };
export type ChosenPlace = { location_id: string; edition_id: string; copies: string };
export type WrittenOffChoice = { revision: number; idempotency_key: string; choice: "keep" | "remove"; places: ChosenPlace[] };
export type ChangeReturnBy = { revision: number; idempotency_key: string; return_by: string | null };
export type AskForMoreTime = { revision: number; idempotency_key: string; return_by: string };
export type SeenNotices = { kinds: ("overdue" | "nudge_answer" | "nudge_handover")[] };
export type OfferedCopies = { location_id: string; edition_id: string; quantity: string };
export type SendLendOffer = { borrower_id: string; copies: OfferedCopies[]; return_by?: string | null; idempotency_key: string };
export type AcceptLendOffer = { revision: number; idempotency_key: string; lines: PromisedLine[]; deck_id?: string | null };
export type InboxUpdate = { id: string; kind: "accepted" | "partly_accepted" | "declined" | "cancelled" | "withdrawn" | "return_by_changed" | "overdue" | "nudge_answer" | "nudge_handover"; loan_id: string; loan_kind: "borrow_request" | "lend_offer"; loan_state: "requested" | "offered" | "accepted" | "handed_over" | "closed"; role: "lender" | "borrower"; other_name: string; read: boolean; at: string; return_by?: string | null };
export type InboxWaiting = { id: string; kind: "borrow_request" | "lend_offer"; state: "requested" | "offered" | "accepted" | "handed_over" | "closed"; closed_reason: "declined" | "withdrawn" | "cancelled" | "returned" | "written_off" | null; closed_by: "you" | "them" | null; role: "lender" | "borrower"; other: LoanParty; return_by: string | null; you_confirmed_handover: boolean; they_confirmed_handover: boolean; lines: LoanCard[]; needs_you: boolean; section: "needs_you" | "out_now" | "pending" | "history"; actions: ("accept" | "decline" | "confirm_handover" | "start_return" | "confirm_return" | "choose_written_off" | "withdraw" | "take_back" | "cancel" | "write_off" | "change_return_by" | "ask_for_more_time" | "approve_extension" | "decline_extension" | "edit_and_resend")[]; revision: number; pending_return?: PendingReturn | null; awaiting_choice?: string; extension_to?: string | null; overdue_since?: string | null; notices?: ("overdue" | "nudge_answer" | "nudge_handover")[]; waiting?: "answer" | "fix_picks" | "choose" | "confirm_return" | "finish_return" | "hand_over" | "receive" | "return" | "more_time" | null; since: string };
export type InboxView = { waiting: InboxWaiting[]; updates: InboxUpdate[] };
export type InboxIds = { ids: string[] };
export type FriendTradeCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string };
export type FriendTradeList = { collector_id: string; handle: string; display_name: string; cards: FriendTradeCard[]; next_page: number | null };

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
// A Friend's Trade List (trading #269): one page of the cards they offer to trade now, found by their Handle among your
// Friends.
export const getFriendTradeList = (handle: string, params: { q?: string; page?: number }, signal?: AbortSignal) =>
  request<FriendTradeList>(`/api/social/trade-lists/${at(handle)}${query(params)}`, 'GET', undefined, signal);
// Loans (#252): the Loans tab and one Loan, as both sides read them.
export const getLoans = (signal?: AbortSignal) => request<LoansView>('/api/social/loans', 'GET', undefined, signal);
export const getLoan = (id: string, signal?: AbortSignal) =>
  request<LoanView>(`/api/social/loans/${at(id)}`, 'GET', undefined, signal);
// Your own side of a Loan: the Deck the cards go to, or what you could promise and where you take the cards from.
export const getLoanSide = (id: string, signal?: AbortSignal) =>
  request<LoanSide>(`/api/loans/${at(id)}/side`, 'GET', undefined, signal);
// Loan steps, idempotent: retry a failed one with the same idempotency_key. Each answers the Loan as it now stands.
export const sendBorrowRequest = (body: SendBorrowRequest) => request<LoanView>('/api/loans', 'POST', body);
export const acceptBorrowRequest = (id: string, body: AcceptBorrowRequest) =>
  request<LoanView>(`/api/loans/${at(id)}/accept`, 'POST', body);
export const declineLoan = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/social/loans/${at(id)}/decline`, 'POST', body);
export const withdrawLoan = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/social/loans/${at(id)}/withdraw`, 'POST', body);
export const cancelLoan = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/social/loans/${at(id)}/cancel`, 'POST', body);
// Handover (#253): each side confirms for its own inventory, and may take that back until the other side confirms.
export const confirmHandover = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/loans/${at(id)}/handover`, 'POST', body);
export const takeBackHandover = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/loans/${at(id)}/take-back`, 'POST', body);
export const useSuggestedPicks = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/loans/${at(id)}/picks/use-suggested`, 'POST', body);
// The Collection's Lent out entry: every copy you lent and haven't had back.
export const getLentOut = (signal?: AbortSignal) => request<LentOut>('/api/loans/lent-out', 'GET', undefined, signal);
// The Collection's Borrowed entry (#254): every Borrowed Copy you hold, and moving some to another of your Locations.
export const getBorrowed = (signal?: AbortSignal) =>
  request<BorrowedCopies>('/api/loans/borrowed', 'GET', undefined, signal);
export const moveBorrowed = (body: MoveBorrowed) => request<BorrowedCopies>('/api/loans/borrowed/move', 'POST', body);
// Returns (#255): either side starts one (its confirmation), and the other side confirms it.
export const startReturn = (id: string, body: StartReturn) =>
  request<LoanView>(`/api/loans/${at(id)}/returns`, 'POST', body);
export const confirmReturn = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/loans/${at(id)}/returns/confirm`, 'POST', body);
// Write-off (#257): the lender's, final; then the borrower keeps or removes the written-off copies they hold.
export const writeOff = (id: string, body: WriteOff) =>
  request<LoanView>(`/api/loans/${at(id)}/write-off`, 'POST', body);
export const chooseWrittenOff = (id: string, body: WrittenOffChoice) =>
  request<LoanView>(`/api/loans/${at(id)}/written-off`, 'POST', body);
// Return-by date (#256): the lender changes or clears it; the borrower asks for more time, which the lender answers.
export const changeReturnBy = (id: string, body: ChangeReturnBy) =>
  request<LoanView>(`/api/social/loans/${at(id)}/return-by`, 'POST', body);
export const askForMoreTime = (id: string, body: AskForMoreTime) =>
  request<LoanView>(`/api/social/loans/${at(id)}/extension`, 'POST', body);
export const approveExtension = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/social/loans/${at(id)}/extension/approve`, 'POST', body);
export const declineExtension = (id: string, body: LoanStep) =>
  request<LoanView>(`/api/social/loans/${at(id)}/extension/decline`, 'POST', body);
// Lend Offers (#258): the lender sends copies from the Collection; the borrower accepts all or part of one.
export const sendLendOffer = (body: SendLendOffer) => request<LoanView>('/api/loans/offers', 'POST', body);
export const acceptLendOffer = (id: string, body: AcceptLendOffer) =>
  request<LoanView>(`/api/loans/${at(id)}/accept-offer`, 'POST', body);
// The time-based notices the reader was shown, so each shows once (#256).
export const seeNotices = (id: string, body: SeenNotices) =>
  request<LoanView>(`/api/social/loans/${at(id)}/notices/seen`, 'POST', body);
// The inbox (#259): the Loans waiting on you and the updates; mark the shown updates read, or Clear them.
export const getInbox = (signal?: AbortSignal) => request<InboxView>('/api/social/inbox', 'GET', undefined, signal);
export const markInboxRead = (body: InboxIds) => request<InboxView>('/api/social/inbox/read', 'POST', body);
export const clearInbox = (body: InboxIds) => request<InboxView>('/api/social/inbox/clear', 'POST', body);
