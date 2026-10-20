"""Generate the social client module (Friends and Friend Requests, social network #247, Blocks, #248, Friends' cards,
#250 and #251, Loans, #252 and #253, Borrowed Copies, #254, Returns, #255, Write-off, #257, the inbox, #259, and a
Friend's Trade List, trading #269) from the API OpenAPI schema."""
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
        return " | ".join(f'"{item}"' for item in value["enum"])
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
             "FriendTradeList"):
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
""")
content = "\n".join(lines)
target = root / "web/src/social_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated social client is stale")
else:
    target.write_text(content)
