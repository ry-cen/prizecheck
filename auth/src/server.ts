import { createHash, createHmac } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  auth,
  budgetedAuth,
  emailSignIn,
  pool,
  providers,
  publicSignup,
  rateLimits,
  removeSignIn,
  SIGN_IN_PAGE,
} from "./auth.js";
import { betterRequest, relay } from "./betterRelay.js";
import { neutralCallback } from "./callbackErrors.js";
import { callerFor, trustedClientIp } from "./caller.js";
import { ipContext } from "./ipContext.js";
import { safeNext } from "./nextPath.js";
import { PublicReadLimiter } from "./publicReads.js";
import { sessionBody } from "./sessionView.js";
import {
  isFresh,
  linkedSignIns,
  sameSiteStart,
  SIGN_INS_PAGE,
  type AccountRow,
  startFailureUrl,
} from "./signIns.js";

const origin = process.env.PUBLIC_ORIGIN || "http://localhost:5173";
const ownerEmail = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
const apiOrigin = process.env.API_ORIGIN || "http://127.0.0.1:8000";
const internalSecret = process.env.INTERNAL_AUTH_SECRET || "";
const publicReadLimiter = new PublicReadLimiter();
if (
  !ownerEmail ||
  !internalSecret ||
  !process.env.BETTER_AUTH_SECRET ||
  !process.env.DATABASE_URL
) {
  throw new Error(
    "OWNER_EMAIL, INTERNAL_AUTH_SECRET, BETTER_AUTH_SECRET, DATABASE_URL are required"
  );
}
// Whatever NODE_ENV says: a gateway nobody can sign in to is a misconfiguration, not a deployment.
if (!emailSignIn && providers.length === 0) {
  throw new Error(
    "No sign-in method: configure a provider or set EMAIL_SIGN_IN=on"
  );
}

// Card art (#358): GET /api/art/{printing_id}/{size}. The gateway passes a 200 image answer as raw bytes; every other
// answer under /api/ goes through the text path below.
const ART_PATH = /^\/api\/art\/[^/]+\/[^/]+$/;
// A Printing with only fallback art gets a redirect to the linked TCGplayer image (#360, ADR 0020). The gateway never
// follows it: it passes on a redirect to exactly this address shape and nothing else.
const ART_LINK =
  /^https:\/\/tcgplayer-cdn\.tcgplayer\.com\/product\/[0-9]{1,9}_(?:200|400)w\.jpg$/;

// Routes that carry a trusted three-second budget. Keep in step with BUDGETED_ROUTES in api/app/price_budget.py;
// api/tests/test_trade_value.py fails when they differ.
const BUDGETED_ROUTES: { method: string; pattern: RegExp }[] = [
  { method: "POST", pattern: /^\/api\/prices\/editions$/ },
  { method: "GET", pattern: /^\/api\/decks\/[^/]+\/cost$/ },
  {
    method: "GET",
    pattern: /^\/api\/public\/decks\/[^/]+\/versions\/[^/]+\/cost$/,
  },
  { method: "GET", pattern: /^\/api\/want-list\/cost$/ },
  { method: "POST", pattern: /^\/api\/trades\/value$/ },
];
const BUDGET_MS = 3_000;
// The answer is gated at 3.0 s, so the abort fires early enough to write the 504 inside it.
const RESPONSE_MARGIN_MS = 100;
const BUDGET_BODY_BYTES = 16_384;
// POST routes whose bodies may pass the 16 KiB other routes accept, matched on the path alone (never the query). Their
// bodies are counted in bytes, refused with 413 as soon as the count passes the limit, and forwarded as the bytes that
// arrived. Each limit is no more than nginx's client_max_body_size for the path (deploy/docker/nginx.conf: 64k for the
// server, 5m for the Collection Import start route alone).
// - Decklist Import (#212): the review carries a pasted list of up to 20,000 characters (the API's IMPORT_TOO_LONG)
//   plus the collector's fixes, and creating the Deck carries up to 200 lines.
// - Collection Import changes (#230): a change names up to 1,000 rows by number and a request holds up to 100 changes,
//   so this limit is the real bound. Every row of a 10,000-row file ticked one by one is about 49 KB of row numbers.
// - Collection Import start (#226): the collector's file, up to the API's 5 MiB (collection_import_reader
//   MAX_IMPORT_BYTES), as raw bytes: a zip or a Windows-1252 export must reach the API unchanged.
const IMPORT_BODY_BYTES = 65_536;
const COLLECTION_IMPORT_BODY_BYTES = 5 * 1024 * 1024;
const IMPORT_ROUTES: { pattern: RegExp; limit: number }[] = [
  { pattern: /^\/api\/decks\/import(?:\/review)?$/, limit: IMPORT_BODY_BYTES },
  {
    pattern: /^\/api\/collection-imports\/[^/]+\/changes$/,
    limit: IMPORT_BODY_BYTES,
  },
  {
    pattern: /^\/api\/collection-imports$/,
    limit: COLLECTION_IMPORT_BODY_BYTES,
  },
];

/** The body limit of a POST to `path` that may pass 16 KiB, or undefined for every other request. */
function importLimit(method: string | undefined, path: string) {
  if (method !== "POST") return undefined;
  return IMPORT_ROUTES.find((route) => route.pattern.test(path))?.limit;
}

class BudgetExceeded extends Error {}
class PayloadTooLarge extends Error {}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) {
    body += chunk.toString();
    if (body.length > 16_384) throw new Error("Payload too large");
  }
  return body;
}

// Bytes, not characters: a multi-byte body must not slip under the cap. The bytes are returned as they arrived, never
// decoded, so they are hashed and forwarded unchanged.
async function readBytes(
  request: IncomingMessage,
  limit: number
): Promise<Buffer<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > limit) throw new PayloadTooLarge();
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

const readBudgetedBody = (request: IncomingMessage) =>
  readBytes(request, BUDGET_BODY_BYTES);

// Rejects when the budget is spent. The wrapped work cannot always be cancelled (the session lookup takes no
// signal), so it is abandoned rather than awaited. An abandoned session lookup runs on budgetedAuth's own pool, whose
// statement, lock and acquire timeouts end it in PostgreSQL (auth/src/auth.ts).
function withinBudget<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  work.catch(() => undefined);
  if (milliseconds <= 0) return Promise.reject(new BudgetExceeded());
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BudgetExceeded()), milliseconds);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function sameOrigin(request: IncomingMessage) {
  return request.headers.origin === origin;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254
    ? email
    : null;
}

function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

async function allowedSend(email: string, ip: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A global transactional lock serializes checks even across gateway replicas.
    await client.query("SELECT pg_advisory_xact_lock(914701)");
    const emailKey = hash(email);
    const ipKey = hash(ip);
    const result = await client.query<{
      minute: string;
      day: string;
      hour_ip: string;
      global_day: string;
    }>(
      `SELECT
      (SELECT count(*) FROM auth_send_event WHERE email_key=$1 AND sent_at > now()-interval '60 seconds') AS minute,
      (SELECT count(*) FROM auth_send_event WHERE email_key=$1 AND sent_at > now()-interval '1 day') AS day,
      (SELECT count(*) FROM auth_send_event WHERE ip_key=$2 AND sent_at > now()-interval '1 hour') AS hour_ip,
      (SELECT count(*) FROM auth_send_event WHERE sent_at > now()-interval '1 day') AS global_day`,
      [emailKey, ipKey]
    );
    const counts = result.rows[0];
    const cap = Number(process.env.DAILY_SEND_CAP || 100);
    const permitted =
      Number(counts.minute) < 1 &&
      Number(counts.day) < 5 &&
      Number(counts.hour_ip) < 20 &&
      Number(counts.global_day) < cap;
    if (permitted)
      await client.query(
        "INSERT INTO auth_send_event(email_key,ip_key) VALUES($1,$2)",
        [emailKey, ipKey]
      );
    await client.query("COMMIT");
    return permitted;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function authCounter(name: "sign_in_delivered" | "sign_in_failed") {
  try {
    await pool.query(
      `INSERT INTO operations_counter(name,count) VALUES($1,1)
      ON CONFLICT(name) DO UPDATE SET count=operations_counter.count+1,updated_at=now()`,
      [name]
    );
  } catch {
    console.error("Operational counter unavailable");
  }
}

function configuredProvider(id: string) {
  return providers.find((provider) => provider.id === id);
}

function redirect(
  response: ServerResponse,
  location: string,
  cookies: string[] = []
) {
  response.writeHead(302, {
    location,
    "cache-control": "no-store",
    ...(cookies.length ? { "set-cookie": cookies } : {}),
  });
  response.end();
}

async function session(request: IncomingMessage) {
  return auth.api.getSession({
    headers: new Headers({ cookie: request.headers.cookie || "" }),
  });
}

// Better Auth's account list for the signed-in collector (row id, provider id, link time). Only the Sign-ins routes call
// it, through the handler; /api/auth/list-accounts itself answers 404 from outside.
async function listAccounts(request: IncomingMessage): Promise<AccountRow[]> {
  const result = await auth.handler(
    betterRequest(origin, request, "/api/auth/list-accounts", undefined, {
      method: "GET",
    })
  );
  if (!result.ok) throw new Error("Account list unavailable");
  return (await result.json()) as AccountRow[];
}

// The session lookup for a budgeted route: the same session rules on a separate, bounded pool (auth/src/auth.ts).
// Call it outside any auth.handler context: better-auth's adapter context is global, and inside one this lookup would
// quietly use the shared pool.
async function budgetedSession(request: IncomingMessage) {
  return budgetedAuth.api.getSession({
    headers: new Headers({ cookie: request.headers.cookie || "" }),
  });
}

const server = createServer(async (request, response) => {
  // Monotonic receipt time, before any body read or session lookup: budgeted routes spend their three seconds from here.
  const received = performance.now();
  const path = new URL(request.url || "/", origin).pathname;
  try {
    if (path === "/auth/request-code" && request.method === "POST") {
      if (!emailSignIn) return json(response, 404, { error: "Not found" });
      if (!sameOrigin(request))
        return json(response, 403, { error: "Origin required" });
      const started = Date.now();
      const body = JSON.parse(await readBody(request));
      const email = normalizedEmail(body.email);
      if (email && (email === ownerEmail || publicSignup)) {
        try {
          const ip = trustedClientIp(request);
          if (await allowedSend(email, ip)) {
            const sent = await auth.handler(
              betterRequest(
                origin,
                request,
                "/api/auth/email-otp/send-verification-otp",
                JSON.stringify({ email, type: "sign-in" })
              )
            );
            await authCounter(sent.ok ? "sign_in_delivered" : "sign_in_failed");
          }
        } catch {
          await authCounter("sign_in_failed");
          console.error("Code delivery unavailable");
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, 400 - (Date.now() - started)))
      );
      return json(response, 202, {
        message: "If this account can sign in, a code has been sent.",
      });
    }
    if (path === "/auth/verify-code" && request.method === "POST") {
      if (!emailSignIn) return json(response, 404, { error: "Not found" });
      if (!sameOrigin(request))
        return json(response, 403, { error: "Origin required" });
      const body = JSON.parse(await readBody(request));
      const email = normalizedEmail(body.email);
      if (
        !email ||
        (!publicSignup && email !== ownerEmail) ||
        !/^\d{6}$/.test(body.code)
      ) {
        return json(response, 401, {
          error: "Invalid or expired code. Request a new code.",
        });
      }
      const result = await auth.handler(
        betterRequest(
          origin,
          request,
          "/api/auth/sign-in/email-otp",
          JSON.stringify({ email, otp: body.code })
        )
      );
      if (!result.ok)
        return json(response, 401, {
          error: "Invalid or expired code. Request a new code.",
        });
      const verified = (await result.clone().json()) as {
        user?: { id?: string };
      };
      if (!verified.user?.id)
        return json(response, 503, {
          error: "Service temporarily unavailable",
        });
      const cookies = result.headers.getSetCookie();
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "set-cookie": cookies,
      });
      response.end(JSON.stringify({ signedIn: true }));
      return;
    }
    if (path === "/auth/methods" && request.method === "GET") {
      // The same answer for everyone: nothing here depends on cookies or accounts.
      return json(response, 200, {
        providers: providers.map(({ id, name }) => ({ id, name })),
        emailSignIn,
      });
    }
    const signInStart = /^\/auth\/sign-in\/([^/]+)$/.exec(path);
    if (signInStart && request.method === "GET") {
      const provider = configuredProvider(signInStart[1]);
      if (!provider) return json(response, 404, { error: "Not found" });
      // Each start writes a Better Auth verification row: 60 per trusted IP per hour, shared with link starts.
      try {
        if (!(await rateLimits.allowStart(trustedClientIp(request))))
          return redirect(
            response,
            `${SIGN_IN_PAGE}?provider=${provider.id}&error=too_many_sign_ups`
          );
        const next = safeNext(
          new URL(request.url || "/", origin).searchParams.get("next")
        );
        const started = await auth.handler(
          betterRequest(
            origin,
            request,
            "/api/auth/sign-in/social",
            JSON.stringify({
              provider: provider.id,
              callbackURL: next,
              newUserCallbackURL: next,
              // The provider id lets the page name the provider in its message.
              errorCallbackURL: `${SIGN_IN_PAGE}?provider=${provider.id}`,
            }),
            { method: "POST", originHeader: origin }
          )
        );
        // Better Auth answers 200 with the provider URL; a sign-in button is a plain link, so the gateway redirects.
        const location = started.ok ? started.headers.get("location") : null;
        if (!location) throw new Error("Sign-in start failed");
        return redirect(response, location, started.headers.getSetCookie());
      } catch (error) {
        console.error(
          "Sign-in start failed",
          error instanceof Error ? error.name : "unknown"
        );
        return redirect(
          response,
          startFailureUrl(SIGN_IN_PAGE, `provider=${provider.id}`)
        );
      }
    }
    const callback = /^\/api\/auth\/callback\/([^/]+)$/.exec(path);
    if (
      callback &&
      request.method === "GET" &&
      configuredProvider(callback[1])
    ) {
      try {
        // The signup gate reads the trusted client IP from this context (auth/src/ipContext.ts), never from a header.
        const result = await ipContext.run(
          { ip: trustedClientIp(request) },
          () =>
            auth.handler(
              betterRequest(origin, request, path, undefined, {
                forwardQuery: true,
              })
            )
        );
        return relay(response, neutralCallback(result, publicSignup), {
          forwardLocation: true,
        });
      } catch (error) {
        console.error(
          "OAuth callback failed",
          error instanceof Error ? error.name : "unknown"
        );
        return redirect(
          response,
          `${SIGN_IN_PAGE}?error=internal_server_error`
        );
      }
    }
    // Better Auth's own endpoints are never reachable from outside; only the gateway routes above call them.
    if (path === "/api/auth" || path.startsWith("/api/auth/"))
      return json(response, 404, { error: "Not found" });
    if (path === "/auth/session" && request.method === "GET") {
      return json(
        response,
        200,
        sessionBody(
          await session(request),
          providers.map((p) => p.imageHost)
        )
      );
    }
    // The Sign-ins page (auth/src/signIns.ts): list, link and unlink, for the signed-in collector only.
    if (path === "/auth/sign-ins" && request.method === "GET") {
      if (!(await session(request)))
        return json(response, 401, { error: "Authentication required" });
      return json(response, 200, {
        signIns: linkedSignIns(await listAccounts(request), providers),
      });
    }
    const linkStart = /^\/auth\/link\/([^/]+)$/.exec(path);
    if (linkStart && request.method === "GET") {
      const provider = configuredProvider(linkStart[1]);
      if (!provider) return json(response, 404, { error: "Not found" });
      const back = `${SIGN_INS_PAGE}?provider=${provider.id}`;
      // A plain link that carries the session cookie: never started from another site.
      if (!sameSiteStart(request.headers))
        return redirect(response, `${back}&error=cross_site_request`);
      const current = await session(request);
      if (!current)
        return redirect(response, "/sign-in?next=%2Fsettings%2Fsign-ins");
      // Better Auth checks freshness only for unlinking; the gateway applies the same rule to link starts.
      if (!isFresh(current.session.createdAt))
        return redirect(response, `${back}&error=recent_sign_in_required`);
      try {
        if (!(await rateLimits.allowStart(trustedClientIp(request))))
          return redirect(response, `${back}&error=too_many_sign_ups`);
        const started = await auth.handler(
          betterRequest(
            origin,
            request,
            "/api/auth/link-social",
            JSON.stringify({
              provider: provider.id,
              callbackURL: SIGN_INS_PAGE,
              errorCallbackURL: back,
            }),
            { method: "POST", originHeader: origin }
          )
        );
        // Like a sign-in start: Better Auth answers 200 with the provider URL, and the gateway redirects.
        const location = started.ok ? started.headers.get("location") : null;
        if (!location) throw new Error("Link start failed");
        return redirect(response, location, started.headers.getSetCookie());
      } catch (error) {
        console.error(
          "Link start failed",
          error instanceof Error ? error.name : "unknown"
        );
        return redirect(
          response,
          startFailureUrl(SIGN_INS_PAGE, `provider=${provider.id}`)
        );
      }
    }
    const unlink = /^\/auth\/unlink\/([^/]+)$/.exec(path);
    if (unlink && request.method === "POST") {
      if (!sameOrigin(request))
        return json(response, 403, { error: "Origin required" });
      const provider = configuredProvider(unlink[1]);
      if (!provider) return json(response, 404, { error: "Not found" });
      const current = await session(request);
      if (!current)
        return json(response, 401, { error: "Authentication required" });
      if (!isFresh(current.session.createdAt))
        return json(response, 403, { code: "recent_sign_in_required" });
      const result = await removeSignIn({
        userId: current.user.id,
        sessionId: current.session.id,
        providerId: provider.id,
      });
      if (result.kind === "not-linked")
        return json(response, 404, { error: "Not found" });
      if (result.kind === "last")
        return json(response, 400, { code: "FAILED_TO_UNLINK_LAST_ACCOUNT" });
      if (result.kind === "not-fresh")
        return json(response, 403, { code: "recent_sign_in_required" });
      return json(response, 200, { unlinked: provider.id });
    }
    if (path === "/auth/sign-out" && request.method === "POST") {
      if (!sameOrigin(request))
        return json(response, 403, { error: "Origin required" });
      const result = await auth.handler(
        betterRequest(origin, request, "/api/auth/sign-out", "{}")
      );
      return relay(response, result);
    }
    if (path.startsWith("/api/")) {
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        !sameOrigin(request)
      )
        return json(response, 403, { error: "Origin required" });
      // Every route under /api/public/ is an anonymous GET: the gateway never looks up a session for it and never
      // forwards an identity, whatever cookies arrive (Published Deck snapshots, discovery, the sitemap and nested routes
      // such as the Published Deck cost). No public route takes another method, so any other method (HEAD included) is
      // refused here, before a session lookup, the read limiter or a body read; the unread body closes the connection.
      const publicPath = path.startsWith("/api/public/");
      if (publicPath && request.method !== "GET") {
        response.setHeader("allow", "GET");
        response.setHeader("connection", "close");
        return json(response, 405, { error: "Method not allowed" });
      }
      const publicRead = request.method === "GET" && publicPath;
      if (publicRead && !publicReadLimiter.take(trustedClientIp(request))) {
        response.setHeader(
          "retry-after",
          publicReadLimiter.retryAfter().toString()
        );
        return json(response, 429, {
          error: "Too many public requests. Retry shortly.",
        });
      }
      const budgeted = BUDGETED_ROUTES.some(
        (route) => route.method === request.method && route.pattern.test(path)
      );
      const left = () =>
        BUDGET_MS - RESPONSE_MARGIN_MS - (performance.now() - received);
      const current =
        publicPath || path === "/api/health"
          ? null
          : budgeted
            ? await withinBudget(budgetedSession(request), left())
            : await session(request);
      if (!current && !publicPath && path !== "/api/health")
        return json(response, 401, { error: "Authentication required" });
      const limit = importLimit(request.method, path);
      const body: string | Buffer<ArrayBuffer> =
        request.method === "GET" || request.method === "HEAD"
          ? ""
          : budgeted
            ? await withinBudget(readBudgetedBody(request), left())
            : limit !== undefined
              ? await readBytes(request, limit)
              : await readBody(request);
      const stamp = Math.floor(Date.now() / 1000).toString();
      const bodyHash = hash(body);
      const signature = current
        ? createHmac("sha256", internalSecret)
            .update(
              `${request.method}\n${path}\n${bodyHash}\n${current.user.id}\n${stamp}`
            )
            .digest("hex")
        : "";
      const headers: Record<string, string> = {};
      if (current) {
        headers["x-internal-user"] = current.user.id;
        headers["x-internal-time"] = stamp;
        headers["x-internal-signature"] = signature;
      }
      let controller: AbortController | undefined;
      let timer: NodeJS.Timeout | undefined;
      if (budgeted && (current || publicRead)) {
        // A separately signed budget: what is left of the three seconds, for this caller and this exact request.
        // A public read is always an anonymous caller (anon:<keyed digest>), even with a valid session cookie.
        const milliseconds = Math.floor(left());
        if (milliseconds <= 0) throw new BudgetExceeded();
        // Epoch milliseconds, taken before the abort timer below is armed: the API counts the time since then (transit,
        // queueing, its own body read) against the budget, because the abort runs from here. The identity stamp above
        // stays in seconds.
        const budgetStamp = Date.now().toString();
        const caller = callerFor(request, current);
        headers["x-internal-budget-ms"] = String(milliseconds);
        headers["x-internal-budget-time"] = budgetStamp;
        headers["x-internal-caller"] = caller;
        headers["x-internal-budget-signature"] = createHmac(
          "sha256",
          internalSecret
        )
          .update(
            `budget\n${request.method}\n${path}\n${bodyHash}\n${caller}\n${milliseconds}\n${budgetStamp}`
          )
          .digest("hex");
        controller = new AbortController();
        timer = setTimeout(() => controller!.abort(), milliseconds);
      }
      // An empty Buffer is truthy: test the length, not the body.
      if (body.length > 0)
        headers["content-type"] =
          request.headers["content-type"] || "application/json";
      try {
        const upstream = await fetch(`${apiOrigin}${request.url}`, {
          method: request.method,
          headers,
          body: body.length > 0 ? body : undefined,
          signal: controller?.signal,
          redirect: ART_PATH.test(path) ? "manual" : "follow",
        });
        const link = upstream.headers.get("location");
        if (
          ART_PATH.test(path) &&
          upstream.status === 302 &&
          link &&
          ART_LINK.test(link)
        ) {
          response.writeHead(302, {
            location: link,
            "cache-control":
              upstream.headers.get("cache-control") || "no-store",
          });
          response.end();
          return;
        }
        const disposition = upstream.headers.get("content-disposition");
        if (
          disposition &&
          /^attachment(?:;|$)/i.test(disposition) &&
          upstream.body
        ) {
          // A file download (Deck exports): forward the disposition and stream without buffering. A client
          // disconnect or an upstream failure tears the pipe down.
          response.writeHead(upstream.status, {
            "content-type":
              upstream.headers.get("content-type") ||
              "application/octet-stream",
            "content-disposition": disposition,
            "cache-control": "no-store",
            ...(upstream.headers.has("x-robots-tag")
              ? { "x-robots-tag": upstream.headers.get("x-robots-tag")! }
              : {}),
          });
          await pipeline(
            Readable.fromWeb(
              upstream.body as import("node:stream/web").ReadableStream
            ),
            response
          );
          return;
        }
        const artType = upstream.headers.get("content-type") || "";
        if (
          ART_PATH.test(path) &&
          upstream.status === 200 &&
          upstream.body &&
          /^image\/(webp|png|jpeg)$/.test(artType)
        ) {
          // Card art (#358): the text path below would decode these bytes as UTF-8 and corrupt them, and it would force
          // no-store on a picture the API marks cacheable. Forward an allowlist of headers only (never a cookie or a
          // CORS header) and stream; isolation headers are always set here, whatever the API sent.
          const length = upstream.headers.get("content-length");
          response.writeHead(200, {
            "content-type": artType,
            ...(length && !upstream.headers.has("content-encoding")
              ? { "content-length": length }
              : {}),
            "cache-control":
              upstream.headers.get("cache-control") || "no-store",
            "cross-origin-resource-policy": "same-origin",
            "x-content-type-options": "nosniff",
          });
          await pipeline(
            Readable.fromWeb(
              upstream.body as import("node:stream/web").ReadableStream
            ),
            response
          );
          return;
        }
        // Read the whole body before the status line, so a budget abort mid-body can still answer 504.
        const text = await upstream.text();
        response.writeHead(upstream.status, {
          "content-type":
            upstream.headers.get("content-type") || "application/json",
          "cache-control": "no-store",
          // A temporary art failure tells the client when to ask again (#396).
          ...(ART_PATH.test(path) &&
          upstream.status === 503 &&
          upstream.headers.has("retry-after")
            ? { "retry-after": upstream.headers.get("retry-after")! }
            : {}),
          ...(upstream.headers.has("x-robots-tag")
            ? { "x-robots-tag": upstream.headers.get("x-robots-tag")! }
            : {}),
        });
        response.end(text);
      } catch (error) {
        if (controller?.signal.aborted) throw new BudgetExceeded();
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      return;
    }
    json(response, 404, { error: "Not found" });
  } catch (error) {
    if (response.headersSent) {
      // A failure after the status line (a download pipe): the only honest signal left is a broken connection.
      response.destroy();
      return;
    }
    if (error instanceof BudgetExceeded)
      return json(response, 504, { detail: { code: "PRICE_DEADLINE" } });
    if (error instanceof PayloadTooLarge) {
      response.setHeader("connection", "close");
      return json(response, 413, { error: "Payload too large" });
    }
    console.error(
      "Gateway request failed",
      error instanceof Error ? error.name : "unknown"
    );
    json(response, 503, { error: "Service temporarily unavailable" });
  }
});

server.listen(
  Number(process.env.AUTH_PORT || 3001),
  process.env.AUTH_HOST || "127.0.0.1"
);
