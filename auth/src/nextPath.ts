// Where a collector lands after signing in: a path inside PrizeCheck, never another site and never the API or the
// gateway's own routes. Better Auth's trustedOrigins check on callbackURL stays on as a second layer.

import {
  NATIVE_APPROVE_PATH,
  nativeApprovePath,
  parseNativeParams,
} from "./native.js";

export const DEFAULT_NEXT = "/collection";
const PROBE = "http://next.invalid";

// While native sign-in is on (NATIVE_SIGN_IN=on), the one gateway page the app's sign-in comes back to: the canonical
// /auth/native/approve path with exactly a valid challenge and state, once each, and no fragment. Returned rebuilt from the
// parsed values, never as sent. Every other /auth/ path stays refused.
function nativeApprove(value: string, url: URL): string | null {
  if (value.includes("#") || value.split("?")[0] !== NATIVE_APPROVE_PATH)
    return null;
  if (url.pathname !== NATIVE_APPROVE_PATH || url.hash !== "") return null;
  const params = parseNativeParams(url.searchParams);
  return params ? nativeApprovePath(params.challenge, params.state) : null;
}

export function safeNext(
  value: string | null | undefined,
  nativeSignIn = false
): string {
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
    url.origin === PROBE &&
    !url.pathname.startsWith("//") &&
    !/%2f|%5c/i.test(url.pathname) &&
    nativeSignIn
  ) {
    const approve = nativeApprove(value, url);
    if (approve) return approve;
  }
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
