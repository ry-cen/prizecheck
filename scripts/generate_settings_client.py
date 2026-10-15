"""Generate the account settings client module from the API OpenAPI schema."""
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
        return " | ".join(f"'{item}'" for item in value["enum"])
    if "const" in value:
        return f"'{value['const']}'"
    if value.get("type") == "array":
        return f"{ts_type(value['items'])}[]"
    return {"string": "string", "integer": "number", "number": "number", "boolean": "boolean",
            "null": "null"}[value["type"]]


schema = app.openapi()["components"]["schemas"]
lines = ["// Generated from FastAPI OpenAPI by scripts/generate_settings_client.py. Do not edit."]
for name in ("AccountSettings", "SetWantListCounting"):
    definition = schema[name]
    fields = [f"{field}{'' if field in definition.get('required', []) else '?'}: {ts_type(value)}"
              for field, value in definition["properties"].items()]
    lines.append(f"export type {name} = {{ {'; '.join(fields)} }};")
lines.append("""export type WantListCounting = AccountSettings['want_list_counting'];

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
""")
content = "\n".join(lines)
target = root / "web/src/settings_generated.ts"
if "--check" in sys.argv:
    if not target.exists() or target.read_text() != content:
        raise SystemExit("Generated settings client is stale")
else:
    target.write_text(content)
