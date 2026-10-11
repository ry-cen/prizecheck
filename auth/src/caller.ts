import { createHmac } from "node:crypto";
import { isIP } from "node:net";

// Caller identity for the signed price budget.
//
// A signed-in request is `user:<id>`. Anything else is `anon:<32 hex>`: a keyed digest of the client address, so the
// API can ration anonymous callers without ever seeing, storing or logging an address.
//
//   interval = floor(now / 1 hour)
//   key_i    = HMAC(INTERNAL_AUTH_SECRET, "price-caller\n" + interval)
//   digest   = HMAC(key_i, normalised address) truncated to 32 hex characters
//
// Every gateway instance sharing the secret derives the same digest within an interval, and the key is never stored.
//
// Rotation boundary: the key changes on the hour, so the digest changes with it and the ledger entry for the old
// digest simply expires. A caller can therefore hold one allowance from the closing interval and a fresh one from
// the opening interval in quick succession (a brief double allowance). This is accepted: it bounds linkability of
// an address across hours, and the allowance is small.

export type CallerRequest = {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
};

export type CallerOptions = {
  secret?: string;
  now?: () => number;
  trustedProxies?: string;
};

const INTERVAL_MS = 3_600_000;

// x-real-ip is honoured only from a peer listed in TRUSTED_PROXY_IPS; otherwise the socket peer is the client.
export function trustedClientIp(
  request: CallerRequest,
  trustedProxies = process.env.TRUSTED_PROXY_IPS || ""
): string {
  const peer = request.socket.remoteAddress || "unknown";
  const trusted = trustedProxies.split(",").map((value) => value.trim());
  const forwarded = request.headers["x-real-ip"];
  if (
    trusted.includes(peer) &&
    typeof forwarded === "string" &&
    isIP(forwarded)
  )
    return forwarded;
  return peer;
}

// IPv4 stays as-is (an IPv4-mapped IPv6 address becomes its IPv4 form); IPv6 collapses to its /64 so a client
// rotating within its prefix remains one caller.
export function normalizeIp(address: string): string {
  const bare = address.split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(bare);
  if (mapped && isIP(mapped[1]) === 4) return mapped[1];
  if (isIP(bare) !== 6) return address;
  let text = bare.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail[1].split(".").map(Number);
    text =
      text.slice(0, -tail[1].length) +
      ((a << 8) | b).toString(16) +
      ":" +
      ((c << 8) | d).toString(16);
  }
  const [head, rest] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = rest === undefined ? [] : rest ? rest.split(":") : [];
  const groups =
    rest === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return (
    groups
      .slice(0, 4)
      .map((group) => parseInt(group, 16).toString(16))
      .join(":") + "::/64"
  );
}

export function anonymousDigest(
  secret: string,
  address: string,
  nowMs: number
): string {
  const interval = Math.floor(nowMs / INTERVAL_MS);
  const key = createHmac("sha256", secret)
    .update(`price-caller\n${interval}`)
    .digest();
  return createHmac("sha256", key)
    .update(normalizeIp(address))
    .digest("hex")
    .slice(0, 32);
}

export function callerFor(
  request: CallerRequest,
  session: { user: { id: string } } | null | undefined,
  options: CallerOptions = {}
): string {
  if (session) return `user:${session.user.id}`;
  const secret = options.secret ?? process.env.INTERNAL_AUTH_SECRET ?? "";
  if (!secret) throw new Error("INTERNAL_AUTH_SECRET is required");
  const address = trustedClientIp(request, options.trustedProxies);
  return `anon:${anonymousDigest(secret, address, (options.now ?? Date.now)())}`;
}
