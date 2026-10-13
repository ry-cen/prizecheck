// What a failed OAuth callback may say. No refusal may reveal whether an account exists. Under owner-only, Better
// Auth's `account_not_linked` (a collector at this address whose own email is unverified) would differ from the gate's
// `sign_in_unavailable` for an address with no account, so the gateway turns it into exactly the gate's refusal. In
// public modes the sign-in page shows `account_not_linked` as "Didn't complete", like every other unlisted code.

const PROBE = "http://callback.invalid";

export function neutralCallbackLocation(
  location: string,
  publicSignup: boolean
): string {
  if (publicSignup) return location;
  let url: URL;
  try {
    url = new URL(location, PROBE);
  } catch {
    return location;
  }
  if (url.searchParams.get("error") !== "account_not_linked") return location;
  url.searchParams.set("error", "sign_in_unavailable");
  url.searchParams.set("error_description", "sign_in_unavailable");
  return url.origin === PROBE
    ? `${url.pathname}${url.search}${url.hash}`
    : url.href;
}

/** Better Auth's callback response with its Location made neutral; status, cookies and body are kept. */
export function neutralCallback(
  result: Response,
  publicSignup: boolean
): Response {
  const location = result.headers.get("location");
  if (!location) return result;
  const neutral = neutralCallbackLocation(location, publicSignup);
  if (neutral === location) return result;
  const headers = new Headers(result.headers);
  headers.set("location", neutral);
  return new Response(result.body, { status: result.status, headers });
}
