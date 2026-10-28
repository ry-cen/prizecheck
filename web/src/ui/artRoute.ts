/**
 * Card art addresses. The server sends every signed-in card image as an art-route address,
 * `/api/art/{printing_id}/small?v=…` (ADR 0020). The route serves two sizes and a Printing's `v` is the same for both,
 * so a large view asks for the same address with the route's `large` size. An address that isn't an art-route small
 * address (a public page's image) is used as it is.
 */
const SMALL_ROUTE = /^(\/api\/art\/[^/?#]+\/)small(\?[^#]*)?$/;

/** The art route's large address for a small one, or null when the address isn't an art-route small address. */
export function largeArtUrl(url: string): string | null {
  const match = SMALL_ROUTE.exec(url);
  return match ? `${match[1]}large${match[2] ?? ""}` : null;
}
