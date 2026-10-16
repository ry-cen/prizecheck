"""Generate the profile client module (Handles, Display Names and the Invite Link, social network #246) from the API
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
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean",
            "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_profile_client.py. Do not edit."]
for name in ("CollectorProfile", "SetDisplayName", "SetHandle", "NewInviteLink", "PublicInvite"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""
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
""")
content = "\n".join(lines)
target = root / "web/src/profile_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated profile client is stale")
else:
    target.write_text(content)
