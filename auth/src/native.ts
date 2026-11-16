import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { RateLimits } from "./rateLimits.js";

// Native iOS sign-in (opt-in, nonprod only; NATIVE_SIGN_IN=on). The app opens /auth/native/start in an
// ASWebAuthenticationSession with a PKCE challenge and a state it made on the device. The collector signs in through the
// ordinary web sign-in, then sees a consent page. Allow issues a one-time code (60 s), the app exchanges it with its PKCE
// verifier for a credential that can read the Collection (`GET /api/collection`) for 24 hours and nothing else, and the app
// keeps that credential in the Keychain. Only sha256 hashes of the code and the token are stored. Web cookie flows are not
// touched: a native request never carries a cookie, and a cookie request never takes the bearer path.
//
// Nothing here logs a code, verifier, token, header or body; failures propagate to the gateway's own handler, which logs the
// error name only.

export const NATIVE_CALLBACK = "prizecheck-native://auth/callback";
export const NATIVE_APPROVE_PATH = "/auth/native/approve";
export const NATIVE_START_PATH = "/auth/native/start";
export const NATIVE_COLLECTION_PATH = "/api/collection";

const CHALLENGE_OR_STATE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE_OR_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;
const NONCE_WINDOW_MS = 10 * 60_000;
const TOKEN_BODY_BYTES = 1024;
const APPROVE_BODY_BYTES = 2048;
const FORM_TYPE = /^application\/x-www-form-urlencoded(?:\s*;.*)?$/i;
const JSON_TYPE = /^application\/json(?:\s*;.*)?$/i;

/**
 * NATIVE_SIGN_IN: `on` enables the feature; unset, empty or `off` leaves it disabled; anything else is a startup error, and
 * so is `on` together with NODE_ENV=production (this slice is for nonprod only).
 */
export function nativeSignInEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const value = (env.NATIVE_SIGN_IN ?? "").trim().toLowerCase();
  if (value === "" || value === "off") return false;
  if (value !== "on") throw new Error("NATIVE_SIGN_IN must be on or off");
  if (env.NODE_ENV === "production")
    throw new Error("NATIVE_SIGN_IN is not available in production");
  return true;
}

/** The challenge and state of a native request: exactly those two parameters, each once and well formed. */
export function parseNativeParams(
  params: URLSearchParams
): { challenge: string; state: string } | null {
  const challenge = params.getAll("challenge");
  const state = params.getAll("state");
  if (
    challenge.length !== 1 ||
    state.length !== 1 ||
    [...params.keys()].length !== 2 ||
    !CHALLENGE_OR_STATE.test(challenge[0]) ||
    !CHALLENGE_OR_STATE.test(state[0])
  )
    return null;
  return { challenge: challenge[0], state: state[0] };
}

export function nativeApprovePath(challenge: string, state: string): string {
  return `${NATIVE_APPROVE_PATH}?challenge=${challenge}&state=${state}`;
}

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sha256Base64Url = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const random43 = () => randomBytes(32).toString("base64url");

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' prizecheck-native:; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function page(
  response: ServerResponse,
  status: number,
  title: string,
  body: string
) {
  response.writeHead(status, PAGE_HEADERS);
  response.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:28rem;margin-inline:auto}h1{font-size:1.4rem}a.button,button{display:inline-block;box-sizing:border-box;min-height:44px;padding:10px 18px;margin:6px 0;border-radius:8px;font:inherit;font-weight:600;text-align:center;text-decoration:none;border:1px solid #444;background:#fff;color:#111;cursor:pointer}button{background:#111;color:#fff}ul{list-style:none;padding:0}li{margin:8px 0}</style></head><body>${body}</body></html>`
  );
}

const invalidLink = (response: ServerResponse) =>
  page(
    response,
    400,
    "Sign-in link not valid",
    "<h1>Sign-in link not valid</h1><p>This sign-in link isn't valid. Go back to the app and try again.</p>"
  );

function failure(response: ServerResponse, status: number, message: string) {
  page(
    response,
    status,
    "Couldn't continue",
    `<h1>Couldn't continue</h1><p>${escapeHtml(message)}</p>`
  );
}

function redirect(response: ServerResponse, status: 302 | 303, to: string) {
  response.writeHead(status, {
    location: to,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
  response.end();
}

function jsonBody(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

class TooLarge extends Error {}

async function readLimited(
  request: IncomingMessage,
  limit: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > limit) throw new TooLarge();
    chunks.push(piece);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type NativeSession = {
  user: { id: string; name: string; email: string };
  session: { id: string };
};

export type NativeDeps = {
  pool: Pool;
  /** PUBLIC_ORIGIN. */
  origin: string;
  internalSecret: string;
  providers: { id: string; name: string }[];
  rateLimits: Pick<RateLimits, "allowNativeApprove" | "allowNativeToken">;
  getSession: (request: IncomingMessage) => Promise<NativeSession | null>;
  clientIp: (request: IncomingMessage) => string;
  now?: () => number;
};

export type Native = {
  /** Serves a /auth/native/* request; false when the route is not one of ours (the gateway then answers 404). */
  handle: (
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ) => Promise<boolean>;
  /** Whether the request carries an Authorization header at all. */
  hasAuthorization: (request: IncomingMessage) => boolean;
  /** The collector a native credential may read the Collection as, or null when the request is not an accepted one. */
  bearerUser: (
    request: IncomingMessage,
    method: string,
    path: string
  ) => Promise<string | null>;
};

export function createNative(deps: NativeDeps): Native {
  const { pool, origin } = deps;
  const now = deps.now ?? Date.now;
  const nonceKey = createHmac("sha256", deps.internalSecret)
    .update("native-approve-key")
    .digest();

  function nonceFor(
    sessionId: string,
    challenge: string,
    state: string,
    window: number
  ): string {
    return createHmac("sha256", nonceKey)
      .update(`native-approve\n${sessionId}\n${challenge}\n${state}\n${window}`)
      .digest("base64url");
  }

  function nonceValid(
    nonce: string,
    sessionId: string,
    challenge: string,
    state: string
  ): boolean {
    if (!CODE_OR_TOKEN.test(nonce)) return false;
    const window = Math.floor(now() / NONCE_WINDOW_MS);
    const given = Buffer.from(nonce);
    // Both windows are always compared, so timing does not say which one matched.
    let valid = false;
    for (const candidate of [window, window - 1]) {
      const expected = Buffer.from(
        nonceFor(sessionId, challenge, state, candidate)
      );
      if (timingSafeEqual(given, expected)) valid = true;
    }
    return valid;
  }

  const hasAuthorization = (request: IncomingMessage) =>
    request.headers.authorization !== undefined;

  function bearerOf(request: IncomingMessage): string | null {
    const match = BEARER.exec(request.headers.authorization ?? "");
    return match ? match[1] : null;
  }

  async function bearerUser(
    request: IncomingMessage,
    method: string,
    path: string
  ): Promise<string | null> {
    const token = bearerOf(request);
    if (
      !token ||
      method !== "GET" ||
      path !== NATIVE_COLLECTION_PATH ||
      request.headers.cookie !== undefined
    )
      return null;
    const { rows } = await pool.query<{ user_id: string }>(
      `SELECT user_id FROM native_credential
       WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at > now()`,
      [sha256Hex(token)]
    );
    return rows[0]?.user_id ?? null;
  }

  function requestParams(request: IncomingMessage) {
    const raw = request.url || "/";
    if (raw.includes("#")) return null;
    return parseNativeParams(new URL(raw, origin).searchParams);
  }

  async function start(request: IncomingMessage, response: ServerResponse) {
    const params = requestParams(request);
    if (!params) return invalidLink(response);
    const approve = nativeApprovePath(params.challenge, params.state);
    if (await deps.getSession(request)) return redirect(response, 302, approve);
    const links = deps.providers
      .map(
        ({ id, name }) =>
          `<li><a class="button" href="${escapeHtml(`/auth/sign-in/${id}?next=${encodeURIComponent(approve)}`)}">Continue with ${escapeHtml(name)}</a></li>`
      )
      .join("");
    page(
      response,
      200,
      "Sign in to Prizecheck",
      `<h1>Sign in to Prizecheck</h1>${links ? `<ul>${links}</ul>` : "<p>No sign-in method is available right now.</p>"}`
    );
  }

  async function approveForm(
    request: IncomingMessage,
    response: ServerResponse
  ) {
    const params = requestParams(request);
    if (!params) return invalidLink(response);
    const current = await deps.getSession(request);
    if (!current)
      return redirect(
        response,
        302,
        `${NATIVE_START_PATH}?challenge=${params.challenge}&state=${params.state}`
      );
    const { challenge, state } = params;
    const nonce = nonceFor(
      current.session.id,
      challenge,
      state,
      Math.floor(now() / NONCE_WINDOW_MS)
    );
    const who = escapeHtml(current.user.name || current.user.email);
    page(
      response,
      200,
      "Allow the app to read your Collection?",
      `<h1>Allow the app to read your Collection?</h1><p>Signed in as ${who}. The app on this phone will be able to see your Collection. It can't change anything.</p><form method="post" action="${NATIVE_APPROVE_PATH}"><input type="hidden" name="challenge" value="${challenge}"><input type="hidden" name="state" value="${state}"><input type="hidden" name="nonce" value="${nonce}"><button type="submit">Allow</button></form><p><a class="button" href="${NATIVE_CALLBACK}?error=access_denied&amp;state=${state}">Cancel</a></p>`
    );
  }

  async function approve(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.origin !== origin)
      return failure(
        response,
        403,
        "This request couldn't be verified. Go back to the app and try again."
      );
    const current = await deps.getSession(request);
    if (!current)
      return failure(
        response,
        401,
        "Your sign-in ended. Go back to the app and try again."
      );
    if (!FORM_TYPE.test(request.headers["content-type"] ?? ""))
      return invalidLink(response);
    let form: URLSearchParams;
    try {
      form = new URLSearchParams(
        await readLimited(request, APPROVE_BODY_BYTES)
      );
    } catch (error) {
      if (error instanceof TooLarge) return invalidLink(response);
      throw error;
    }
    const nonces = form.getAll("nonce");
    const keys = [...form.keys()];
    const challenge = form.getAll("challenge");
    const state = form.getAll("state");
    if (
      challenge.length !== 1 ||
      state.length !== 1 ||
      nonces.length !== 1 ||
      keys.length !== 3 ||
      !CHALLENGE_OR_STATE.test(challenge[0]) ||
      !CHALLENGE_OR_STATE.test(state[0])
    )
      return invalidLink(response);
    if (!nonceValid(nonces[0], current.session.id, challenge[0], state[0]))
      return failure(
        response,
        403,
        "This request couldn't be verified. Go back to the app and try again."
      );
    if (!(await deps.rateLimits.allowNativeApprove(deps.clientIp(request))))
      return failure(response, 429, "Too many attempts. Try again later.");
    const code = random43();
    await pool.query("DELETE FROM native_grant WHERE expires_at < now()");
    await pool.query(
      `INSERT INTO native_grant(code_hash,user_id,challenge,expires_at)
       VALUES($1,$2,$3, now() + interval '60 seconds')`,
      [sha256Hex(code), current.user.id, challenge[0]]
    );
    redirect(
      response,
      303,
      `${NATIVE_CALLBACK}?code=${code}&state=${state[0]}`
    );
  }

  async function token(request: IncomingMessage, response: ServerResponse) {
    const invalid = () => jsonBody(response, 400, { error: "invalid_request" });
    if (
      request.headers.cookie !== undefined ||
      request.headers.origin !== undefined ||
      !JSON_TYPE.test(request.headers["content-type"] ?? "")
    )
      return invalid();
    let code: string;
    let verifier: string;
    try {
      const body = JSON.parse(await readLimited(request, TOKEN_BODY_BYTES));
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).sort().join() !== "code,verifier" ||
        typeof body.code !== "string" ||
        typeof body.verifier !== "string" ||
        !CODE_OR_TOKEN.test(body.code) ||
        !VERIFIER.test(body.verifier)
      )
        return invalid();
      code = body.code;
      verifier = body.verifier;
    } catch (error) {
      if (error instanceof TooLarge || error instanceof SyntaxError)
        return invalid();
      throw error;
    }
    if (!(await deps.rateLimits.allowNativeToken(deps.clientIp(request)))) {
      response.setHeader("retry-after", "3600");
      return jsonBody(response, 429, { error: "too_many_requests" });
    }
    const issued = random43();
    const client = await pool.connect();
    let failureCause: Error | undefined;
    try {
      await client.query("BEGIN");
      // A wrong verifier matches no row, so it deletes nothing and the code still works with the right one.
      const grant = await client.query<{ user_id: string }>(
        `DELETE FROM native_grant WHERE code_hash=$1 AND challenge=$2 AND expires_at > now() RETURNING user_id`,
        [sha256Hex(code), sha256Base64Url(verifier)]
      );
      if (grant.rowCount !== 1) {
        await client.query("ROLLBACK");
        return jsonBody(response, 400, { error: "invalid_grant" });
      }
      // Expired or revoked more than a day ago: nothing reads these rows again.
      await client.query(
        `DELETE FROM native_credential
         WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'`
      );
      const credential = await client.query<{ expires_at: Date }>(
        `INSERT INTO native_credential(token_hash,user_id,scope,expires_at)
         VALUES($1,$2,'collection:read', now() + interval '24 hours') RETURNING expires_at`,
        [sha256Hex(issued), grant.rows[0].user_id]
      );
      await client.query("COMMIT");
      jsonBody(response, 200, {
        token: issued,
        expires_at: credential.rows[0].expires_at.toISOString(),
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      failureCause = error instanceof Error ? error : new Error("failed");
      throw error;
    } finally {
      client.release(failureCause);
    }
  }

  async function signOut(request: IncomingMessage, response: ServerResponse) {
    const bearer = bearerOf(request);
    if (
      bearer &&
      request.headers.cookie === undefined &&
      request.headers.origin === undefined
    )
      await pool.query(
        `UPDATE native_credential SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`,
        [sha256Hex(bearer)]
      );
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    path: string
  ): Promise<boolean> {
    const method = request.method;
    if (path === NATIVE_START_PATH && method === "GET")
      await start(request, response);
    else if (path === NATIVE_APPROVE_PATH && method === "GET")
      await approveForm(request, response);
    else if (path === NATIVE_APPROVE_PATH && method === "POST")
      await approve(request, response);
    else if (path === "/auth/native/token" && method === "POST")
      await token(request, response);
    else if (path === "/auth/native/sign-out" && method === "POST")
      await signOut(request, response);
    else return false;
    return true;
  }

  return { handle, hasAuthorization, bearerUser };
}
