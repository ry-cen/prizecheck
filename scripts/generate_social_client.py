"""Generate the social client module (Friends and Friend Requests, social network #247, and Blocks, #248) from the API
OpenAPI schema."""
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
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean",
            "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_social_client.py. Do not edit."]
for name in ("Collector", "CollectorLookup", "InviteCollector", "FriendsView", "LookupHandle", "SendFriendRequest",
             "FriendCommand",
             "FriendCommandResult", "BlockCollector", "BlockedList"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
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
""")
content = "\n".join(lines)
target = root / "web/src/social_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated social client is stale")
else:
    target.write_text(content)
