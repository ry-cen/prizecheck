// Where a collector lands after signing in: a path inside PrizeCheck, never another site and never the API or the
// gateway's own routes. Better Auth's trustedOrigins check on callbackURL stays on as a second layer.

export const DEFAULT_NEXT = "/collection";
const PROBE = "http://next.invalid";

export function safeNext(value: string | null | undefined): string {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return DEFAULT_NEXT;
  let url: URL;
  try {
    url = new URL(value, PROBE);
  } catch {
    return DEFAULT_NEXT;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return DEFAULT_NEXT;
  }
  const path = decoded;
  if (
    url.origin !== PROBE ||
    url.pathname.startsWith("//") ||
    /%2f|%5c/i.test(url.pathname) ||
    path === "/api" ||
    path.startsWith("/api/") ||
    path === "/auth" ||
    path.startsWith("/auth/")
  )
    return DEFAULT_NEXT;
  return `${url.pathname}${url.search}${url.hash}`;
}
