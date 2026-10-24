"""Generate the social client module (Friends and Friend Requests, social network #247, Blocks, #248, Friends' cards,
#250 and #251, Loans, #252 and #253, Borrowed Copies, #254, Returns, #255, Write-off, #257, the inbox, #259, and a
Friend's Trade List, trading #269, Trades as both sides read them, trading #270, declining and cancelling one,
trading #271, the inbox's Trade lines, trading #273, and Find trades and Ask to trade, trading #276, and Open to cash
offers, trading #277, Open discovery, trading #297, and Conversations, trading #298, and the trader reads, trading #299, and Reports and the owner queue, trading #303) from the API OpenAPI schema."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "api"))
from app.main import app  # noqa: E402


def ts_type(value):
    if "$ref" in value:
        return value["$ref"].split("/")[-1]
    if "anyOf" in value:
        return " | ".join(ts_type(part) for part in value["anyOf"])
    if "enum" in value:
        return " | ".join(json.dumps(item) for item in value["enum"])
    if value.get("type") == "array":
        inner = ts_type(value["items"])
        return f"({inner})[]" if " | " in inner else f"{inner}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean",
            "null": "null", "object": "Record<string, unknown>"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_social_client.py. Do not edit."]
for name in ("Collector", "CollectorLookup", "InviteCollector", "FriendsView", "LookupHandle", "SendFriendRequest",
             "FriendCommand", "FriendCommandResult", "BlockCollector", "BlockedList", "FriendCard", "FriendCollection",
             "FriendCopy", "WantedCard", "WantListMatches", "CardMatches", "LoanParty", "LoanCard", "ReturnLine",
             "PendingReturn", "LoanView",
             "LoansView", "LoanStep", "LoanLineRequest", "SendBorrowRequest", "PromisedLine", "AcceptBorrowRequest",
             "PromiseLimit", "LoanPickPlace", "LoanDeck", "LoanSide", "LentCard", "LentOut", "BorrowedCard",
             "BorrowedCopies", "MoveBorrowed", "ReturnedLine", "StartReturn", "WriteOffLine", "WriteOff", "ChosenPlace",
             "WrittenOffChoice", "ChangeReturnBy", "AskForMoreTime", "SeenNotices", "OfferedCopies", "SendLendOffer",
             "AcceptLendOffer", "InboxUpdate", "InboxWaiting", "InboxView", "InboxIds", "FriendTradeCard",
             "FriendTradeList", "TradeParty", "TradeCard", "TradeCash", "TradeView", "TradesView", "TradeStep",
             "InboxTradeWaiting", "InboxTradeUpdate", "TradeMatchCard", "TradeMatchRow", "TradeMatches",
             "TradeCardOffer", "TradeCardMatches", "TradeSettings", "SetTradeSettings", "DiscoverySettings",
             "SetDiscovery", "ConversationParty", "Message", "TimelineItem", "ConversationView", "LastMessage",
             "NearbyMatchRow", "NearbyMatches", "CardHolder", "TradeCardSearch",
             "ConversationSummary", "ConversationsView", "ConversationPulse", "SendMessage", "ReadThrough",
             "TraderView", "TraderTradeList", "TraderMatchRow",
             "BlockedCollector", "ReportCollector", "ReportResult", "ReportParty", "TradeReportRow", "TradeReportList",
             "SnapshotMessage", "SnapshotCard", "SnapshotTrade", "ModerationEventView", "ReportedAccount",
             "TradeReportDetail", "ReportDecision", "ReportDecided", "RestoreCollector", "CollectorRestored"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
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
""")
content = "\n".join(lines)
target = root / "web/src/social_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated social client is stale")
else:
    target.write_text(content)
