"""Generate the profile client module (Handles, Display Names and the Invite Link, social network #246) from the API
OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/profile_generated.ts"
NAMES = ("CollectorProfile", "SetDisplayName", "SetHandle", "NewInviteLink", "PublicInvite")

# HANDLE_CHANGE_TOO_SOON and TOO_MANY_HANDLE_TRIES carry the detail that says when to try again.
ERROR = gen.error_class(
    "ProfileError", "public detail: Record<string, unknown> = {}",
    doc="""/** A refused profile request: the API's code, and for HANDLE_CHANGE_TOO_SOON and TOO_MANY_HANDLE_TRIES the detail
 * that says when to try again. */""")

BODY = """
%(error)s
%(request)s
// The signed-in collector's Handle, Display Name and Invite Link token; the first read makes the link.
export const getProfile = () => request<CollectorProfile>('/api/profile', 'GET');
// Idempotent changes: retry a failed one with the same idempotency_key.
export const setDisplayName = (body: SetDisplayName) => request<CollectorProfile>('/api/profile/display-name', 'PUT', body);
export const setHandle = (body: SetHandle) => request<CollectorProfile>('/api/profile/handle', 'PUT', body);
export const newInviteLink = (body: NewInviteLink) => request<CollectorProfile>('/api/profile/invite-link', 'POST', body);
// The signed-out Invite Link page's read: the Display Name only.
export const getPublicInvite = (token: string) =>
  request<PublicInvite>(`/api/public/invites/${encodeURIComponent(token)}`, 'GET');
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    failure = gen.detail_failure_lines("ProfileError", "PROFILE_REQUEST_FAILED")
    body = BODY % {"error": ERROR, "request": gen.json_request(failure)}
    return gen.assemble([gen.header("generate_profile_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
