"""Generate the account settings client module from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/settings_generated.ts"
NAMES = ("AccountSettings", "SetWantListCounting")

BODY = """export type WantListCounting = AccountSettings['want_list_counting'];

%(error)s
%(request)s
// The account's settings (decklist import #207): the Want List counting setting and the settings revision.
export const getSettings = () => request<AccountSettings>('/api/settings', 'GET');
// Changes the Want List counting setting: revision-checked (409 STALE_SETTINGS) and idempotent.
export const setWantListCounting = (body: SetWantListCounting) =>
  request<AccountSettings>('/api/settings/want-list-counting', 'PUT', body);
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("SettingsError"),
                   "request": gen.simple_request("SettingsError", "SETTINGS_REQUEST_FAILED")}
    return gen.assemble([gen.header("generate_settings_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
