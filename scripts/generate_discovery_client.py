"""Generate Discovery response types from the API OpenAPI schema."""
import client_generator as gen

TARGET = "web/src/discovery_generated.ts"
NAMES = ("PublicCheckSummary", "DiscoverCost", "PublicDeckSummary", "DiscoveryPage")

BODY = """
/** A Target Format to filter by; absent means every Format. */
export type DiscoverFormat = 'standard' | 'expanded' | 'glc';

%(error)s
%(request)s
export const discoverDecks = (q = '', cursor?: string, format?: DiscoverFormat | null, signal?: AbortSignal) => {
  const params = new URLSearchParams({ q }); if (cursor) params.set('cursor', cursor); if (format) params.set('format', format);
  return request<DiscoveryPage>('/api/public/discovery?' + params, 'GET', undefined, signal);
};
"""


def render(openapi):
    schemas = openapi["components"]["schemas"]
    body = BODY % {"error": gen.error_class("DiscoveryError"),
                   "request": gen.simple_request("DiscoveryError", "DISCOVERY_REQUEST_FAILED", signal=True)}
    return gen.assemble([gen.header("generate_discovery_client"), *gen.SINGLE.aliases(schemas, NAMES), body])


if __name__ == "__main__":
    gen.main(__name__)
