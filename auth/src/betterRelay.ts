import type { IncomingMessage, ServerResponse } from "node:http";

// The gateway's internal hop to Better Auth and back. Only explicit gateway routes call Better Auth; a route opts in
// to forwarding the browser's query string (the OAuth callback carries `code` and `state` there) and to passing a
// redirect's Location back. Every other route keeps the defaults: no query, no Location.

export type BetterRequestOptions = {
  /** Append the incoming request's query string to `path`. */
  forwardQuery?: boolean;
};

export type RelayOptions = {
  /** Pass Better Auth's `Location` header through (OAuth routes only). */
  forwardLocation?: boolean;
};

export function betterRequest(
  origin: string,
  request: Pick<IncomingMessage, "headers" | "method" | "url">,
  path: string,
  body?: string,
  options: BetterRequestOptions = {}
): Request {
  const headers = new Headers();
  if (request.headers.cookie) headers.set("cookie", request.headers.cookie);
  if (request.headers.origin) headers.set("origin", request.headers.origin);
  headers.set("content-type", "application/json");
  const query = options.forwardQuery
    ? new URL(request.url || "/", origin).search
    : "";
  return new Request(`${origin}${path}${query}`, {
    method: request.method,
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
