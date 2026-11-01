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
export type BlockedList = { blocked: BlockedCollector[] };
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
export type VoidCommandKey = { idempotency_key: string; account_id: string };
export type CommandKeyOutcome = { outcome: "applied" | "void"; account_id: string };
export type LoanStep = { account_id?: string | null; revision: number; idempotency_key: string };
export type LoanLineRequest = { edition_id: string; quantity: string };
export type SendBorrowRequest = { lender_id: string; lines: LoanLineRequest[]; deck_id?: string | null; return_by?: string | null; replaces?: string | null; account_id?: string | null; idempotency_key: string };
export type PromisedLine = { edition_id: string; promised: string };
export type AcceptBorrowRequest = { account_id?: string | null; revision: number; idempotency_key: string; lines: PromisedLine[]; return_by?: string | null };
export type PromiseLimit = { edition_id: string; available: string };
export type LoanPickPlace = { edition_id: string; location_id: string | null; name: string; path: string; copies: string; short: string };
export type LoanDeck = { id: string; name: string };
export type LoanSide = { loan_id: string; deck: LoanDeck | null; can_promise: PromiseLimit[]; picks: LoanPickPlace[]; suggested: LoanPickPlace[]; awaiting_choice?: LoanPickPlace[] };
export type LentCard = { loan_id: string; edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; image_url: string | null; copies: string; borrower: string };
export type LentOut = { cards: LentCard[]; copies: string };
export type BorrowedCard = { loan_id: string; edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; location_id: string; location_name: string; copies: string; lender: string };
export type BorrowedCopies = { cards: BorrowedCard[]; copies: string };
export type MoveBorrowed = { loan_id: string; edition_id: string; from_location_id: string; to_location_id: string; quantity: string; account_id?: string | null; idempotency_key: string };
export type PendingLender = { lender: string; state: "requested" | "accepted"; copies: string };
export type PendingLine = { edition_id: string; requested: string; accepted: string; lenders: PendingLender[] };
export type PendingLoans = { deck_id: string; lines: PendingLine[] };
export type ReturnedLine = { edition_id: string; quantity: string };
export type StartReturn = { account_id?: string | null; revision: number; idempotency_key: string; lines: ReturnedLine[] };
export type WriteOffLine = { edition_id: string; quantity: string };
export type WriteOff = { account_id?: string | null; revision: number; idempotency_key: string; lines: WriteOffLine[] };
export type ChosenPlace = { location_id: string; edition_id: string; copies: string };
export type WrittenOffChoice = { account_id?: string | null; revision: number; idempotency_key: string; choice: "keep" | "remove"; places: ChosenPlace[] };
export type ChangeReturnBy = { account_id?: string | null; revision: number; idempotency_key: string; return_by: string | null };
export type AskForMoreTime = { account_id?: string | null; revision: number; idempotency_key: string; return_by: string };
export type SeenNotices = { kinds: ("overdue" | "nudge_answer" | "nudge_handover")[] };
export type OfferedCopies = { location_id: string; edition_id: string; quantity: string };
export type SendLendOffer = { borrower_id: string; copies: OfferedCopies[]; return_by?: string | null; account_id?: string | null; idempotency_key: string };
export type AcceptLendOffer = { account_id?: string | null; revision: number; idempotency_key: string; lines: PromisedLine[]; deck_id?: string | null };
export type InboxUpdate = { id: string; kind: "accepted" | "partly_accepted" | "declined" | "cancelled" | "withdrawn" | "return_by_changed" | "overdue" | "nudge_answer" | "nudge_handover"; loan_id: string; loan_kind: "borrow_request" | "lend_offer"; loan_state: "requested" | "offered" | "accepted" | "handed_over" | "closed"; role: "lender" | "borrower"; other_name: string; read: boolean; at: string; return_by?: string | null };
export type InboxWaiting = { id: string; kind: "borrow_request" | "lend_offer"; state: "requested" | "offered" | "accepted" | "handed_over" | "closed"; closed_reason: "declined" | "withdrawn" | "cancelled" | "returned" | "written_off" | null; closed_by: "you" | "them" | null; role: "lender" | "borrower"; other: LoanParty; return_by: string | null; you_confirmed_handover: boolean; they_confirmed_handover: boolean; lines: LoanCard[]; needs_you: boolean; section: "needs_you" | "out_now" | "pending" | "history"; actions: ("accept" | "decline" | "confirm_handover" | "start_return" | "confirm_return" | "choose_written_off" | "withdraw" | "take_back" | "cancel" | "write_off" | "change_return_by" | "ask_for_more_time" | "approve_extension" | "decline_extension" | "edit_and_resend")[]; revision: number; pending_return?: PendingReturn | null; awaiting_choice?: string; extension_to?: string | null; overdue_since?: string | null; notices?: ("overdue" | "nudge_answer" | "nudge_handover")[]; waiting?: "answer" | "fix_picks" | "choose" | "confirm_return" | "finish_return" | "hand_over" | "receive" | "return" | "more_time" | null; since: string };
export type InboxView = { waiting: InboxWaiting[]; updates: InboxUpdate[]; trade_waiting: InboxTradeWaiting[]; trade_updates: InboxTradeUpdate[] };
export type InboxIds = { ids: string[] };
export type FriendTradeCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string };
export type FriendTradeList = { collector_id: string; trader_id: string; handle: string; display_name: string; completed_trades: number | null; cards: FriendTradeCard[]; next_page: number | null };
export type TradeParty = { collector_id: string | null; handle: string | null; trader_id?: string | null; display_name: string; open_to_cash_offers: boolean; friend?: boolean; available?: boolean; completed_trades?: number | null };
export type TradeCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string };
export type TradeCash = { cents: string; payer: "you" | "them" };
export type TradeView = { id: string; state: "proposed" | "accepted" | "closed"; closed_reason: "declined" | "withdrawn" | "countered" | "cancelled" | "swapped" | null; closed_by: "you" | "them" | null; role: "proposer" | "recipient"; other: TradeParty; countered_from: string | null; you_give: TradeCard[]; you_get: TradeCard[]; cash: TradeCash | null; you_confirmed_swap: boolean; they_confirmed_swap: boolean; needs_you: boolean; waiting: "answer" | "fix_picks" | "confirm_swap" | null; section: "needs_you" | "to_swap" | "pending" | "history"; actions: ("accept" | "decline" | "counter" | "confirm_swap" | "use_suggested_picks" | "withdraw" | "cancel")[]; revision: number; created_at: string; conversation_id?: string | null };
export type TradesView = { trades: TradeView[]; needs_you: number };
export type TradeStep = { revision: number; idempotency_key: string };
export type InboxTradeWaiting = { id: string; state: "proposed" | "accepted" | "closed"; closed_reason: "declined" | "withdrawn" | "countered" | "cancelled" | "swapped" | null; closed_by: "you" | "them" | null; role: "proposer" | "recipient"; other: TradeParty; countered_from: string | null; you_give: TradeCard[]; you_get: TradeCard[]; cash: TradeCash | null; you_confirmed_swap: boolean; they_confirmed_swap: boolean; needs_you: boolean; waiting: "answer" | "fix_picks" | "confirm_swap" | null; section: "needs_you" | "to_swap" | "pending" | "history"; actions: ("accept" | "decline" | "counter" | "confirm_swap" | "use_suggested_picks" | "withdraw" | "cancel")[]; revision: number; created_at: string; conversation_id?: string | null; since: string };
export type InboxTradeUpdate = { id: string; kind: "accepted" | "declined" | "cancelled" | "withdrawn" | "swapped"; trade_id: string; trade_state: "proposed" | "accepted" | "closed"; role: "proposer" | "recipient"; other_name: string; read: boolean; at: string };
export type TradeMatchCard = { edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string; need: string; want_list_need: string; origin: "want_list" | "trade_wants" | "both"; accepts_as: "exact" | "any_finish" | "same_name" | null };
export type TradeMatchRow = { collector_id: string; trader_id: string; handle: string; display_name: string; completed_trades: number | null; open_to_cash_offers: boolean; match: "two_way" | "has_what_you_want" | "wants_what_you_have" | null; you_get: TradeMatchCard[]; you_give: TradeMatchCard[]; more_you_get: number; more_you_give: number };
export type TradeMatches = { has_friends: boolean; rows: TradeMatchRow[] };
export type TradeCardOffer = { collector_id: string; handle: string; display_name: string; edition_id: string; name: string; set_code: string; set_name: string; collector_number: string; descriptor: Record<string, unknown>; image_url: string | null; copies: string };
export type TradeCardMatches = { has_friends: boolean; offers: TradeCardOffer[] };
export type TradeSettings = { open_to_cash_offers: boolean };
export type SetTradeSettings = { open_to_cash_offers: boolean };
export type DiscoverySettings = { status: "off" | "on" | "removed" | "suspended"; zip: string | null; radius_mi: 5 | 10 | 25 | 50; zip_changes_left: number; visible_beyond_friends: boolean };
export type SetDiscovery = { enabled?: boolean | null; zip?: string | null; radius_mi?: 5 | 10 | 25 | 50 | null };
export type ConversationParty = { trader_id: string | null; display_name: string; friend: boolean; handle: string | null; band: "under_5" | "5_to_10" | "10_to_25" | "25_to_50" | null; completed_trades: number | null };
export type Message = { id: string; from: "you" | "them"; body: string; at: string };
export type TimelineItem = { kind: "message" | "trade"; at: string; cursor: string; message: Message | null; trade: TradeView | null };
export type ConversationView = { id: string | null; other: ConversationParty; status: "open" | "you_blocked" | "unavailable"; can_message: boolean; can_propose: boolean; can_report: boolean; items: TimelineItem[]; next_before: string | null };
export type LastMessage = { from: "you" | "them"; preview: string; at: string };
export type NearbyMatchRow = { trader_id: string; display_name: string; band: "under_5" | "5_to_10" | "10_to_25" | "25_to_50"; completed_trades: number; open_to_cash_offers: boolean; match: "two_way" | "has_what_you_want" | "wants_what_you_have"; you_get: TradeMatchCard[]; you_give: TradeMatchCard[]; more_you_get: number; more_you_give: number };
export type NearbyMatches = { status: "off" | "on" | "removed" | "suspended"; radius_mi: 5 | 10 | 25 | 50; rows: NearbyMatchRow[] };
export type CardHolder = { trader_id: string; display_name: string; friend: boolean; band: "under_5" | "5_to_10" | "10_to_25" | "25_to_50" | null; completed_trades: number; open_to_cash_offers: boolean; cards: FriendTradeCard[]; more_cards: number };
export type TradeCardSearch = { status: "off" | "on" | "removed" | "suspended"; friends: CardHolder[]; near: CardHolder[] };
export type ConversationSummary = { id: string; other: ConversationParty; status: "open" | "you_blocked" | "unavailable"; last_message: LastMessage | null; open_trades: number; waiting_on_you: number; unread: boolean; archived: boolean; last_activity_at: string };
export type ConversationsView = { conversations: ConversationSummary[]; next_before: string | null; suspended: boolean };
export type ConversationPulse = { unread_conversations: number; watermark: string };
export type SendMessage = { body: string; idempotency_key: string };
export type ReadThrough = { through: string };
export type TraderView = { trader_id: string; display_name: string; friend: boolean; band: "under_5" | "5_to_10" | "10_to_25" | "25_to_50" | null; completed_trades: number | null; open_to_cash_offers: boolean; status: "open" | "unavailable" | "you_blocked"; conversation_id: string | null; add_friend: "offer" | "sent" | "received" | null };
export type TraderTradeList = { trader_id: string; display_name: string; band: "under_5" | "5_to_10" | "10_to_25" | "25_to_50" | null; completed_trades: number | null; cards: FriendTradeCard[]; next_page: number | null };
export type TraderMatchRow = { trader_id: string; display_name: string; band: "under_5" | "5_to_10" | "10_to_25" | "25_to_50" | null; completed_trades: number | null; open_to_cash_offers: boolean; match: "two_way" | "has_what_you_want" | "wants_what_you_have" | null; you_get: TradeMatchCard[]; you_give: TradeMatchCard[]; more_you_get: number; more_you_give: number };
export type BlockedCollector = { block_id: string; display_name: string; handle: string | null; trader_id: string | null };
export type ReportCollector = { trader_id: string; reason: "scam_or_no_show" | "harassment" | "inappropriate_content" | "other"; note?: string | null; source: "conversation" | "discovery" | "trade"; trade_id?: string | null; idempotency_key: string };
export type ReportResult = { reported: boolean };
export type ReportParty = { user_id: string | null; display_name: string; handle: string };
export type TradeReportRow = { id: string; created_at: string; status: "open" | "dismissed" | "actioned"; decision: "dismiss" | "remove_from_discovery" | "suspend" | null; reason: "scam_or_no_show" | "harassment" | "inappropriate_content" | "other"; source: "conversation" | "discovery" | "trade"; reporter: ReportParty; reported: ReportParty; reported_count: number };
export type TradeReportList = { reports: TradeReportRow[]; next_before: string | null; open_count: number };
export type SnapshotMessage = { message_id: string; sender: "reporter" | "reported"; body: string; at: string };
export type SnapshotCard = { name: string; set_code: string; number: string; quantity: number };
export type SnapshotTrade = { trade_id: string; state: "proposed" | "accepted" | "closed"; closed_reason: "declined" | "withdrawn" | "countered" | "cancelled" | "swapped" | null; closed_by: "reporter" | "reported" | null; proposed_by: "reporter" | "reported"; reporter_gives: SnapshotCard[]; reported_gives: SnapshotCard[]; cash_cents: number | null; cash_paid_by: "reporter" | "reported" | null; proposed_at: string; accepted_at: string | null; reporter_confirmed_at: string | null; reported_confirmed_at: string | null; closed_at: string | null; countered_from: string | null; ended_by_report: boolean };
export type ModerationEventView = { id: string; action: "dismiss" | "remove_from_discovery" | "suspend" | "restore_discovery" | "lift_suspension"; report_id: string | null; owner_id: string; note: string | null; created_at: string };
export type ReportedAccount = { exists: boolean; suspended: boolean; removed: boolean };
export type TradeReportDetail = { report: TradeReportRow; note: string | null; conversation_id: string | null; trade_id: string | null; decided_at: string | null; decided_by: string | null; messages: SnapshotMessage[]; trades: SnapshotTrade[]; account: ReportedAccount; other_reports: TradeReportRow[]; events: ModerationEventView[] };
export type ReportDecision = { action: "dismiss" | "remove_from_discovery" | "suspend"; note?: string | null };
export type ReportDecided = { status: "dismissed" | "actioned"; decision: "dismiss" | "remove_from_discovery" | "suspend" };
export type RestoreCollector = { what: "discovery" | "suspension"; note?: string | null };
export type CollectorRestored = { restored: "discovery" | "suspension" };

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
// Block for strangers (trading #302): Block and Unblock by trader id, and Unblock from Settings › Privacy by block id.
export const blockTrader = (traderId: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/traders/${at(traderId)}/block`, 'POST', body);
export const unblockTrader = (traderId: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/traders/${at(traderId)}/unblock`, 'POST', body);
export const unblockById = (blockId: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/blocked/${at(blockId)}/unblock`, 'POST', body);
// Report (trading #303): Report by trader id, which also Blocks.
export const reportCollector = (body: ReportCollector) => request<ReportResult>('/api/social/reports', 'POST', body);
// A Friend's Collection (#250): one page of the cards they could lend now, found by their Handle among your Friends.
export const getFriendCollection = (handle: string,
  params: { show?: 'wanted' | 'all'; q?: string; printings?: Printings; page?: number }, signal?: AbortSignal) =>
  request<FriendCollection>(`/api/social/collections/${at(handle)}${query(params)}`, 'GET', undefined, signal);
// Friends' cards for the Want List in scope (#251): its own read, apart from the Want List's.
export const getWantListMatches = (params: { deck?: string | null }, signal?: AbortSignal) =>
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
// Check or permanently cancel a command whose answer was lost.
export const voidCommandKey = (body: VoidCommandKey) =>
  request<CommandKeyOutcome>('/api/loans/command-keys/void', 'POST', body);
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
// What one of your Decks is waiting on from Friends: copies asked for and copies promised but not yet received.
export const getPendingLoans = (deck: string, signal?: AbortSignal) =>
  request<PendingLoans>(`/api/loans/pending${query({ deck })}`, 'GET', undefined, signal);
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
// Trades (trading #270): the Trades list and one Trade, as both sides read them. Sending one is in the Trades client.
export const getTrades = (signal?: AbortSignal) => request<TradesView>('/api/social/trades', 'GET', undefined, signal);
export const getTrade = (id: string, signal?: AbortSignal) =>
  request<TradeView>(`/api/social/trades/${at(id)}`, 'GET', undefined, signal);
// Trade steps, idempotent: retry a failed one with the same idempotency_key. Each answers the Trade as it now stands.
export const withdrawTrade = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/social/trades/${at(id)}/withdraw`, 'POST', body);
// The recipient declines a Trade Proposal; either side cancels an accepted Trade nobody has confirmed (#271). Accepting
// one reserves your cards, so it is in the Trades client.
export const declineTrade = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/social/trades/${at(id)}/decline`, 'POST', body);
export const cancelTrade = (id: string, body: TradeStep) =>
  request<TradeView>(`/api/social/trades/${at(id)}/cancel`, 'POST', body);
// Find trades (trading #276): every Friend who matches, with at most 20 cards a side, and one Friend's row with every
// card (a null match when nothing matches now).
export const getTradeMatches = (signal?: AbortSignal) =>
  request<TradeMatches>('/api/social/trade-matches', 'GET', undefined, signal);
export const getTradeMatch = (collectorId: string, signal?: AbortSignal) =>
  request<TradeMatchRow>(`/api/social/trade-matches/${at(collectorId)}`, 'GET', undefined, signal);
// Ask to trade (trading #276): Friends' Trade List copies of one Card Printing, for the card popup.
export const getTradeCardMatches = (printingId: string, signal?: AbortSignal) =>
  request<TradeCardMatches>(`/api/social/trade-card-matches${query({ printing_id: printingId })}`, 'GET', undefined,
    signal);
// Near you and card search (trading #300): nearby collectors who match, and who has one card for trade.
export const getNearbyMatches = (signal?: AbortSignal) =>
  request<NearbyMatches>('/api/social/trade-matches/near', 'GET', undefined, signal);
export const getTradeCardSearch = (printingId: string, scope: 'name' | 'set' | 'printing', signal?: AbortSignal) =>
  request<TradeCardSearch>(`/api/social/trade-card-search${query({ printing_id: printingId, scope })}`, 'GET',
    undefined, signal);
// Your own Open to cash offers setting (trading #277): off until you turn it on; set by value, idempotent.
export const getTradeSettings = (signal?: AbortSignal) =>
  request<TradeSettings>('/api/social/trade-settings', 'GET', undefined, signal);
export const setTradeSettings = (body: SetTradeSettings) =>
  request<TradeSettings>('/api/social/trade-settings', 'PUT', body);
// Open discovery (trading #297): the caller's own setting, the one response that carries a zip.
export const getDiscovery = (signal?: AbortSignal) =>
  request<DiscoverySettings>('/api/social/discovery', 'GET', undefined, signal);
export const setDiscovery = (body: SetDiscovery) => request<DiscoverySettings>('/api/social/discovery', 'PUT', body);
// Conversations (trading #298): the list, one conversation by id or by the other's trader id, messages, the read marker,
// archive, and the pulse the shell polls.
export const getConversations = (params: { archived?: boolean; before?: string | null }, signal?: AbortSignal) =>
  request<ConversationsView>(
    `/api/social/conversations${query({ archived: params.archived ? 'true' : undefined, before: params.before })}`,
    'GET', undefined, signal);
export const getConversationPulse = (signal?: AbortSignal) =>
  request<ConversationPulse>('/api/social/conversations/pulse', 'GET', undefined, signal);
export const getConversation = (id: string, params: { before?: string | null }, signal?: AbortSignal) =>
  request<ConversationView>(`/api/social/conversations/${at(id)}${query(params)}`, 'GET', undefined, signal);
export const getTraderConversation = (traderId: string, params: { before?: string | null }, signal?: AbortSignal) =>
  request<ConversationView>(`/api/social/conversations/with/${at(traderId)}${query(params)}`, 'GET', undefined, signal);
export const sendMessage = (id: string, body: SendMessage) =>
  request<Message>(`/api/social/conversations/${at(id)}/messages`, 'POST', body);
export const sendTraderMessage = (traderId: string, body: SendMessage) =>
  request<Message>(`/api/social/traders/${at(traderId)}/messages`, 'POST', body);
export const readConversation = (id: string, body: ReadThrough) =>
  request<ConversationSummary>(`/api/social/conversations/${at(id)}/read`, 'POST', body);
export const archiveConversation = (id: string) =>
  request<ConversationSummary>(`/api/social/conversations/${at(id)}/archive`, 'POST');
export const unarchiveConversation = (id: string) =>
  request<ConversationSummary>(`/api/social/conversations/${at(id)}/unarchive`, 'POST');
// Trader reads (trading #299): one collector by trader id, their Trade List and their match row, through the reach rule.
export const getTrader = (traderId: string, signal?: AbortSignal) =>
  request<TraderView>(`/api/social/traders/${at(traderId)}`, 'GET', undefined, signal);
export const getTraderTradeList = (traderId: string, params: { q?: string; page?: number }, signal?: AbortSignal) =>
  request<TraderTradeList>(`/api/social/traders/${at(traderId)}/trade-list${query(params)}`, 'GET', undefined, signal);
export const getTraderMatch = (traderId: string, signal?: AbortSignal) =>
  request<TraderMatchRow>(`/api/social/traders/${at(traderId)}/matches`, 'GET', undefined, signal);
// Add as Friend (trading #304): from a Trade both sides confirmed, by the Trade's id, so the other's user id never
// reaches the web. Withdraw takes back the caller's own pending request to the Trade's other side.
export const addFriendFromTrade = (tradeId: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/trades/${at(tradeId)}/add-friend`, 'POST', body);
export const withdrawAddFriend = (tradeId: string, body: FriendCommand) =>
  request<FriendCommandResult>(`/api/social/trades/${at(tradeId)}/add-friend/withdraw`, 'POST', body);
// Owner: Trade reports (trading #303). Owner screens only.
export const getOwnerTradeReports = (params: { status?: TradeReportRow['status']; before?: string | null },
  signal?: AbortSignal) =>
  request<TradeReportList>(`/api/admin/trade-reports${query(params)}`, 'GET', undefined, signal);
export const getOwnerTradeReport = (reportId: string, signal?: AbortSignal) =>
  request<TradeReportDetail>(`/api/admin/trade-reports/${at(reportId)}`, 'GET', undefined, signal);
export const decideTradeReport = (reportId: string, body: ReportDecision) =>
  request<ReportDecided>(`/api/admin/trade-reports/${at(reportId)}/decision`, 'POST', body);
export const restoreCollector = (collectorId: string, body: RestoreCollector) =>
  request<CollectorRestored>(`/api/admin/collectors/${at(collectorId)}/restore`, 'POST', body);
