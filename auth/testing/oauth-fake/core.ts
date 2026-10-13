// OAuth test fake: pure pieces. No side effects on import; preload.ts installs them.
//
// TEST ONLY. Nothing under auth/src may import this directory (scripts/check_guardrails.py enforces it). It fakes
// the Google and Discord HTTP traffic so the real Better Auth provider code runs with no real accounts.
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

export const CONSENT_PATH = "/auth/__fake-oauth/consent";
export const IDENTITY_QUERY = "fake_identity";
export const IDENTITY_COOKIE = "fake_oauth_identity";
export const CANCEL = "cancel";

export type Identity = {
  /** Google `sub`. Digits only. */
  googleSub: string;
  /** Discord snowflake. Digits only: Better Auth computes a default avatar with BigInt(id). */
  discordId: string;
  email: string | null;
  verified: boolean;
  name: string;
  /** Discord avatar hash, or null for Discord's default avatar. */
  discordAvatar: string | null;
};

const DEFAULT_OWNER_EMAIL = "owner@example.test";

/** The test identities, chosen by the fake `code` (`fake-<name>`). `owner` uses OWNER_EMAIL. */
export function identities(
  ownerEmail: string | undefined
): Record<string, Identity> {
  const owner = (ownerEmail || DEFAULT_OWNER_EMAIL).trim().toLowerCase();
  return {
    owner: {
      googleSub: "100000000000000000001",
      discordId: "100000000000000001",
      email: owner,
      verified: true,
      name: "Owner Collector",
      discordAvatar: "0wner0000000000000000000000000001",
    },
    "owner-second": {
      googleSub: "100000000000000000002",
      discordId: "100000000000000002",
      email: owner,
      verified: true,
      name: "Owner Second",
      discordAvatar: "0wner0000000000000000000000000002",
    },
    "owner-renamed": {
      googleSub: "100000000000000000001",
      discordId: "100000000000000001",
      email: owner,
      verified: true,
      name: "Owner Renamed",
      discordAvatar: "0wner0000000000000000000000000003",
    },
    "owner-moved": {
      googleSub: "100000000000000000001",
      discordId: "100000000000000001",
      email: "owner.moved@example.test",
      verified: true,
      name: "Owner Collector",
      discordAvatar: "0wner0000000000000000000000000001",
    },
    newcomer: {
      googleSub: "100000000000000000003",
      discordId: "100000000000000003",
      email: "newcomer@example.test",
      verified: true,
      name: "New Collector",
      discordAvatar: null,
    },
    unverified: {
      googleSub: "100000000000000000004",
      discordId: "100000000000000004",
      email: "unverified@example.test",
      verified: false,
      name: "Unverified Collector",
      discordAvatar: null,
    },
    "no-email": {
      googleSub: "100000000000000000005",
      discordId: "100000000000000005",
      email: null,
      verified: false,
      name: "No Email Collector",
      discordAvatar: null,
    },
    "different-email": {
      googleSub: "100000000000000000006",
      discordId: "100000000000000006",
      email: "owner.elsewhere@example.test",
      verified: true,
      name: "Owner Elsewhere",
      discordAvatar: null,
    },
  };
}

export type FakeProvider = {
  id: string;
  /** Where Better Auth sends the browser. A redirect here is rewritten to the consent page. */
  authorize: string;
  /** Every host this provider owns. Any request to one of them that the fake doesn't answer throws. */
  hosts: string[];
  clientIdEnv: string;
};

export const PROVIDERS: FakeProvider[] = [
  {
    id: "google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    hosts: ["google.com", "googleapis.com", "googleusercontent.com"],
    clientIdEnv: "GOOGLE_CLIENT_ID",
  },
  {
    id: "discord",
    authorize: "https://discord.com/api/oauth2/authorize",
    hosts: ["discord.com", "discordapp.com"],
    clientIdEnv: "DISCORD_CLIENT_ID",
  },
];

function providerForHost(hostname: string): FakeProvider | undefined {
  return PROVIDERS.find((provider) =>
    provider.hosts.some(
      (host) => hostname === host || hostname.endsWith(`.${host}`)
    )
  );
}

/** True only for http(s) origins on localhost, 127.0.0.1 or [::1]. */
export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  );
}

export class FakeRefused extends Error {
  constructor(url: URL) {
    super(`OAuth fake refused ${url.origin}${url.pathname}`);
    this.name = "FakeRefused";
  }
}

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

type FetchFn = typeof globalThis.fetch;

/** A fetch that answers the providers' token and profile endpoints and passes every other host to `realFetch`. */
export function createFakeFetch(
  realFetch: FetchFn,
  env: NodeJS.ProcessEnv = process.env
): FetchFn {
  const people = identities(env.OWNER_EMAIL);
  const who = (code: string | null) =>
    code && code.startsWith("fake-") ? people[code.slice(5)] : undefined;
  const invalid = (status: number, error: string) =>
    Response.json({ error }, { status });
  return async (input, init) => {
    const target = new URL(
      input instanceof Request ? input.url : String(input)
    );
    const provider = providerForHost(target.hostname);
    if (!provider) return realFetch(input, init);
    const request = new Request(input, init);
    const path = decodeURIComponent(target.pathname);
    const form =
      request.method === "POST"
        ? new URLSearchParams(await request.text())
        : new URLSearchParams();
    if (
      provider.id === "google" &&
      target.hostname === "oauth2.googleapis.com" &&
      path === "/token" &&
      request.method === "POST"
    ) {
      if (form.get("client_id") !== env.GOOGLE_CLIENT_ID)
        return invalid(401, "invalid_client");
      if (!form.get("code_verifier")) return invalid(400, "invalid_request");
      const person = who(form.get("code"));
      if (!person) return invalid(400, "invalid_grant");
      const name = form.get("code")!.slice(5);
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: "https://accounts.google.com",
        aud: env.GOOGLE_CLIENT_ID,
        sub: person.googleSub,
        email_verified: person.verified,
        name: person.name,
        picture: `https://lh3.googleusercontent.com/a/fake-${name}`,
        iat: now,
        exp: now + 3600,
      };
      if (person.email) claims.email = person.email;
      return Response.json({
        access_token: `fake-google-access-${name}`,
        id_token: `${base64url({ alg: "RS256", kid: "fake", typ: "JWT" })}.${base64url(claims)}.fake-signature`,
        expires_in: 3599,
        token_type: "Bearer",
        scope:
          "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
      });
    }
    if (
      provider.id === "discord" &&
      target.hostname === "discord.com" &&
      path === "/api/oauth2/token" &&
      request.method === "POST"
    ) {
      if (form.get("client_id") !== env.DISCORD_CLIENT_ID)
        return invalid(401, "invalid_client");
      const person = who(form.get("code"));
      if (!person) return invalid(400, "invalid_grant");
      const name = form.get("code")!.slice(5);
      return Response.json({
        access_token: `fake-discord-access-${name}`,
        refresh_token: `fake-discord-refresh-${name}`,
        expires_in: 604800,
        token_type: "Bearer",
        scope: "identify email",
      });
    }
    if (
      provider.id === "discord" &&
      target.hostname === "discord.com" &&
      path === "/api/users/@me" &&
      request.method === "GET"
    ) {
      const token = (request.headers.get("authorization") || "").replace(
        /^Bearer /,
        ""
      );
      const name = token.startsWith("fake-discord-access-")
        ? token.slice("fake-discord-access-".length)
        : "";
      const person = people[name];
      if (!person) return invalid(401, "unauthorized");
      return Response.json({
        id: person.discordId,
        username: person.name.toLowerCase().replace(/[^a-z0-9]/g, ""),
        global_name: person.name,
        discriminator: "0",
        avatar: person.discordAvatar,
        email: person.email,
        verified: person.verified,
      });
    }
    throw new FakeRefused(target);
  };
}

function header(
  value: string | string[] | number | undefined
): string | undefined {
  return Array.isArray(value)
    ? value[0]
    : value === undefined
      ? undefined
      : String(value);
}

function cookieValue(
  request: IncomingMessage,
  name: string
): string | undefined {
  for (const part of (request.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The callback URL the consent page forwards to, or null when the request is not acceptable. */
export function consentTarget(
  query: URLSearchParams,
  identity: string | undefined,
  origin: string,
  known: Record<string, Identity>
): string | null {
  const state = query.get("state");
  const redirect = query.get("redirect_uri");
  const provider = PROVIDERS.find((p) => p.id === query.get("provider"));
  if (!state || !redirect || !provider || !identity) return null;
  let back: URL;
  try {
    back = new URL(redirect);
  } catch {
    return null;
  }
  if (
    back.origin !== new URL(origin).origin ||
    back.pathname !== `/api/auth/callback/${provider.id}`
  )
    return null;
  if (identity === CANCEL) back.searchParams.set("error", "access_denied");
  else if (known[identity]) back.searchParams.set("code", `fake-${identity}`);
  else return null;
  back.searchParams.set("state", state);
  return back.toString();
}

function serveConsent(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string,
  known: Record<string, Identity>
) {
  const url = new URL(request.url || "/", origin);
  const identity =
    url.searchParams.get("identity") || cookieValue(request, IDENTITY_COOKIE);
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  if (!identity) {
    // Manual local development: one link per identity.
    const links = [...Object.keys(known), CANCEL]
      .map((name) => {
        const query = new URLSearchParams(url.searchParams);
        query.set("identity", name);
        return `<li><a href="${escapeHtml(`${CONSENT_PATH}?${query}`)}">${escapeHtml(name)}</a></li>`;
      })
      .join("");
    response.writeHead(200, headers);
    response.end(
      `<!doctype html><title>Fake sign-in</title><h1>Fake ${escapeHtml(url.searchParams.get("provider") || "")} sign-in (test only)</h1><ul>${links}</ul>`
    );
    return;
  }
  const target = consentTarget(url.searchParams, identity, origin, known);
  if (!target) {
    response.writeHead(400, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("OAuth fake: bad consent request");
    return;
  }
  response.writeHead(200, { ...headers, "x-fake-oauth-callback": target });
  response.end(
    `<!doctype html><title>Fake sign-in</title><p>Fake consent for ${escapeHtml(identity)} (test only)</p><a id="fake-oauth-continue" href="${escapeHtml(target)}">Continue</a><script>location.replace(${JSON.stringify(target).replace(/</g, "\\u003c")})</script>`
  );
}

/** Wraps a request listener: serves the consent page and rewrites a redirect to a provider into a redirect to it. */
export function wrapRequestListener(
  listener: RequestListener,
  origin: string,
  env: NodeJS.ProcessEnv = process.env
): RequestListener {
  const known = identities(env.OWNER_EMAIL);
  return (request, response) => {
    const url = new URL(request.url || "/", origin);
    if (url.pathname === CONSENT_PATH) {
      if (request.method !== "GET") {
        response.writeHead(405, { allow: "GET" });
        response.end();
        return;
      }
      serveConsent(request, response, origin, known);
      return;
    }
    const chosen = url.searchParams.get(IDENTITY_QUERY);
    const writeHead = response.writeHead;
    response.writeHead = function (
      this: ServerResponse,
      statusCode: number,
      ...rest: unknown[]
    ) {
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        const last = rest[rest.length - 1];
        const headers =
          last && typeof last === "object" && !Array.isArray(last)
            ? (last as Record<string, string | string[] | number>)
            : undefined;
        // Node also accepts a flat [name, value, ...] array as the headers argument.
        let flat: unknown[] | undefined;
        let at = -1;
        if (Array.isArray(last)) {
          flat = [...last];
          rest[rest.length - 1] = flat;
          for (let i = 0; i + 1 < flat.length; i += 2)
            if (String(flat[i]).toLowerCase() === "location") {
              at = i;
              break;
            }
        }
        const key =
          headers &&
          Object.keys(headers).find(
            (name) => name.toLowerCase() === "location"
          );
        const location = key
          ? header(headers![key])
          : at >= 0
            ? header(flat![at + 1] as string | string[] | number)
            : header(this.getHeader("location"));
        let target: URL | undefined;
        try {
          target = location ? new URL(location) : undefined;
        } catch {
          target = undefined;
        }
        const provider = target && providerForHost(target.hostname);
        if (target && provider) {
          if (`${target.origin}${target.pathname}` !== provider.authorize) {
            // Fail closed: never send a browser to a real provider page.
            statusCode = 502;
            this.removeHeader("location");
            if (key) delete headers![key];
            if (at >= 0) flat!.splice(at, 2);
          } else {
            const query = new URLSearchParams({
              provider: provider.id,
              state: target.searchParams.get("state") || "",
              redirect_uri: target.searchParams.get("redirect_uri") || "",
            });
            if (chosen) query.set("identity", chosen);
            const consent = `${CONSENT_PATH}?${query}`;
            if (key) headers![key] = consent;
            else if (at >= 0) flat![at + 1] = consent;
            else this.setHeader("location", consent);
          }
        }
      }
      return (writeHead as (...args: unknown[]) => ServerResponse).call(
        this,
        statusCode,
        ...rest
      );
    } as typeof response.writeHead;
    return listener(request, response);
  };
}
