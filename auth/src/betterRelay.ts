import type { IncomingMessage, ServerResponse } from "node:http";
import { trustedClientIp } from "./caller.js";
import { isIP } from "node:net";

// The gateway's internal hop to Better Auth and back. Only explicit gateway routes call Better Auth; a route opts in
// to forwarding the browser's query string (the OAuth callback carries `code` and `state` there) and to passing a
// redirect's Location back. Every other route keeps the defaults: no query, no Location.

/**
 * The header the gateway uses to tell Better Auth the client's address. Better Auth's rate limiter (on under
 * NODE_ENV=production) keys on it (`advanced.ipAddress.ipAddressHeaders` in auth.ts reads only this header); without
 * it every visitor would share one bucket per path. Only the gateway sets it, from trustedClientIp: the request below is
 * built from scratch, so no browser-supplied copy is ever forwarded. nginx blanks it too (deploy/docker/nginx.conf).
 */
export const CLIENT_IP_HEADER = "x-prizecheck-client-ip";

export type BetterRequestOptions = {
  /** Append the incoming request's query string to `path`. */
  forwardQuery?: boolean;
  /** The method for Better Auth when it differs from the browser's (a GET start calls a POST endpoint). */
  method?: string;
  /**
   * Send this Origin instead of the browser's. A GET start carries no Origin, and Better Auth refuses a POST that
   * carries a cookie without one; the gateway vouches with its own PUBLIC_ORIGIN for the routes that opt in.
   */
  originHeader?: string;
};

export type RelayOptions = {
  /** Pass Better Auth's `Location` header through (OAuth routes only). */
  forwardLocation?: boolean;
};

export function betterRequest(
  origin: string,
  request: Pick<IncomingMessage, "headers" | "method" | "url"> &
    Partial<Pick<IncomingMessage, "socket">>,
  path: string,
  body?: string,
  options: BetterRequestOptions = {}
): Request {
  const headers = new Headers();
  if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
  const sentOrigin = options.originHeader ?? request.headers.origin;
  if (sentOrigin) headers.set("origin", sentOrigin);
  headers.set("content-type", "application/json");
  if (request.socket) {
    const ip = trustedClientIp({
      socket: request.socket,
      headers: request.headers,
    });
    if (isIP(ip)) headers.set(CLIENT_IP_HEADER, ip);
  }
  const query = options.forwardQuery
    ? new URL(request.url || "/", origin).search
    : "";
  return new Request(`${origin}${path}${query}`, {
    method: options.method ?? request.method,
    headers,
    body,
  });
}

export async function relay(
  response: ServerResponse,
  result: Response,
  options: RelayOptions = {}
): Promise<void> {
  const headers: Record<string, string | string[]> = {
    "content-type": result.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  };
  const cookies = result.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  const location = result.headers.get("location");
  if (options.forwardLocation && location) headers["location"] = location;
  response.writeHead(result.status, headers);
  response.end(await result.text());
}
