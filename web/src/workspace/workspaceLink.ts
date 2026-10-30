/** The workspace deep link, /collection?location=<id>, opens one Storage Leaf or Deck.
 * The Decks page links here; an old /workspace?location=<id> link is redirected here with its query.
 * The workspace reads each link when shown and then removes it from the address. */
const PARAM = "location";

export function workspaceHref(locationId: string): string {
  return `/collection?${new URLSearchParams({ [PARAM]: locationId })}`;
}

/** The linked Location id in the current address, or null. */
export function readLinkedLocation(): string | null {
  return new URLSearchParams(window.location.search).get(PARAM) || null;
}

/** Removes the link from the address, keeping the path, other parameters and hash,
 * so a later reload opens the workspace at All owned. */
export function clearLinkedLocation(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(PARAM)) return;
  params.delete(PARAM);
  const search = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`
  );
}
