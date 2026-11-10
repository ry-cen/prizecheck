/** Collection addresses retain the existing Location query used by Decks and Loans. */
export function collectionAddress(search: string) {
  const params = new URLSearchParams(search);
  return {
    location: params.get("location") || "all",
    query: params.get("q") || "",
    card: params.get("card"),
    copy: Number(params.get("copy") || 0),
  };
}
export function collectionHref(
  location: string,
  query = "",
  card?: string,
  copy = 0
): string {
  const params = new URLSearchParams();
  if (location !== "all") params.set("location", location);
  if (query) params.set("q", query);
  if (card) {
    params.set("card", card);
    if (copy) params.set("copy", String(copy));
  }
  return `/collection${params.size ? `?${params}` : ""}`;
}
export function workspaceHref(locationId: string): string {
  return collectionHref(locationId);
}
