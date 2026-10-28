/** The same-origin art route URL for a card's small picture (#358), or null when the card has no picture. The version
 * only busts the browser's cache when the source changes; the client never builds a URL from a raw art host. */
export function artUrl(
  printingId: string,
  version: string | null
): string | null {
  return version === null
    ? null
    : `/api/art/${encodeURIComponent(printingId)}/small?v=${version}`;
}
