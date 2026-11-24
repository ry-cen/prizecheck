import { createServer } from "node:http";
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { pathToFileURL } from "node:url";

// Loopback-only stand-in for the gateway's native sign-in, for the simulator job. It mirrors the
// HTTP contract with in-memory state, one sample collector (always "signed in" to the web
// session) and sample data. It carries no credentials, cookies, accounts or real data. After each
// response it logs one allowlisted line (a fixed route label, a method label and the status), never
// a path, query, header, body or parameter value.
export const PORT = 4320;
const CALLBACK = "prizecheck-native://auth/callback";
const CHALLENGE_OR_STATE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID = "stub-session";
const HOUR = 3_600_000;
const COLLECTOR = {
  name: "Sample Collector",
  email: "collector@example.invalid",
};

const sha256 = (value) => createHash("sha256").update(value).digest();
const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  );

function entry(id, name, number) {
  return {
    edition_id: `native-edition-${id}`,
    quantity: "1",
    printing_id: `native-printing-${id}`,
    printing_name: name,
    set_id: "native-set",
    set_name: "Native sample set",
    collector_number: number,
    descriptor: {},
    image_url: null,
  };
}
export const NATIVE_SECOND_CURSOR = "native-page-2";
const PAGES = [
  {
    entries: [
      entry("bulbasaur", "Bulbasaur", "001"),
      entry("charmander", "Charmander", "004"),
    ],
    owner_revision: 1,
    catalog_revision: 1,
    next_cursor: NATIVE_SECOND_CURSOR,
  },
  {
    entries: [entry("squirtle", "Squirtle", "007")],
    owner_revision: 1,
    catalog_revision: 1,
    next_cursor: null,
  },
];

/** The one writer for request lines: a line is allowlisted text, never request content. */
export const stdoutLog = (line) => process.stdout.write(`${line}\n`);

/** The fixed label for a route, from the pathname alone, so no path text is ever logged. */
function routeLabel(path, method) {
  if (path === "/auth/native/start" && method === "GET") return "start";
  if (path === "/auth/native/approve" && method === "GET") return "approve_get";
  if (path === "/auth/native/approve" && method === "POST")
    return "approve_post";
  if (path === "/auth/native/token" && method === "POST") return "token";
  if (path === "/auth/native/sign-out" && method === "POST") return "sign_out";
  if (path === "/api/collection") return "collection";
  if (
    (path === "/fixture/state" && method === "GET") ||
    (path === "/fixture/sign-out/fail" && method === "POST") ||
    (path === "/fixture/sign-out/ok" && method === "POST")
  )
    return "fixture";
  return "other";
}

/** Every parameter exactly once, only the expected names. Returns null when invalid. */
function exactParams(params, names) {
  const seen = [...params.keys()];
  if (seen.length !== names.length) return null;
  const out = {};
  for (const name of names) {
    const all = params.getAll(name);
    if (all.length !== 1) return null;
    out[name] = all[0];
  }
  return out;
}

export function nativeFixture({
  now = () => Date.now(),
  tokenLifetimeMs = 24 * HOUR,
  log = null,
} = {}) {
  const key = createHmac("sha256", randomBytes(32))
    .update("native-approve-key")
    .digest();
  const grants = new Map(); // code_hash -> { challenge, expires }
  const credentials = new Map(); // token_hash -> { expires, revoked }
  const events = { native_approve: new Map(), native_token: new Map() };
  const LIMITS = { native_approve: 20, native_token: 30 };
  let origin = `http://127.0.0.1:${PORT}`;
  // Sign-out test control (loopback stub only; the gateway has no such route): while `failSignOut` is on, sign-out answers
  // 503 and revokes nothing. `refused` counts those 503s, `confirmed` the 204s that revoked a live credential.
  let failSignOut = false;
  let refused = 0;
  let confirmed = 0;

  function limited(kind, request) {
    const ip = request.socket.remoteAddress ?? "unknown";
    const since = now() - HOUR;
    const kept = (events[kind].get(ip) ?? []).filter((at) => at > since);
    if (kept.length >= LIMITS[kind]) {
      events[kind].set(ip, kept);
      return true;
    }
    kept.push(now());
    events[kind].set(ip, kept);
    return false;
  }
  const nonceFor = (challenge, state, window) =>
    b64url(
      createHmac("sha256", key)
        .update(
          `native-approve\n${SESSION_ID}\n${challenge}\n${state}\n${window}`
        )
        .digest()
    );
  const windowNow = () => Math.floor(now() / 600_000);
  function nonceValid(nonce, challenge, state) {
    if (typeof nonce !== "string") return false;
    return [windowNow(), windowNow() - 1].some((window) => {
      const expected = Buffer.from(nonceFor(challenge, state, window));
      const given = Buffer.from(nonce);
      return (
        given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
  }
  function prune() {
    for (const [hash, grant] of grants)
      if (grant.expires <= now()) grants.delete(hash);
  }

  function html(response, status, body, extra = {}) {
    response.writeHead(status, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' prizecheck-native:; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "same-origin",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Prizecheck</title><style>body{font:17px system-ui;margin:2rem}button{font:inherit;padding:.5rem 1rem}</style>${body}</html>`
    );
  }
  function invalidLink(response) {
    html(
      response,
      400,
      "<h1>Prizecheck</h1><p>This sign-in link isn't valid. Go back to the app and try again.</p>"
    );
  }
  function json(response, status, body, extra = {}) {
    response.writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    });
    response.end(JSON.stringify(body));
  }
  function readBody(request, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let over = false;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) over = true;
        else chunks.push(chunk);
      });
      request.on("end", () =>
        resolve(over ? null : Buffer.concat(chunks).toString("utf8"))
      );
      request.on("error", () => resolve(null));
    });
  }
  /** `Bearer <43>` only; any cookie header voids it. Returns the token hash or null. */
  function bearer(request) {
    const header = request.headers.authorization;
    if (typeof header !== "string" || request.headers.cookie !== undefined)
      return null;
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    return match ? sha256(match[1]).toString("hex") : null;
  }
  function credentialFor(hash) {
    const credential = hash ? credentials.get(hash) : undefined;
    return credential && !credential.revoked && credential.expires > now()
      ? credential
      : null;
  }

  function start(url, response) {
    const params = exactParams(url.searchParams, ["challenge", "state"]);
    if (
      !params ||
      url.hash ||
      !CHALLENGE_OR_STATE.test(params.challenge) ||
      !CHALLENGE_OR_STATE.test(params.state)
    ) {
      return invalidLink(response);
    }
    // The stub's web session is always signed in, so there is no provider step.
    response.writeHead(302, {
      location: `/auth/native/approve?challenge=${params.challenge}&state=${params.state}`,
      "cache-control": "no-store",
    });
    response.end();
  }
  function approvePage(url, response) {
    const params = exactParams(url.searchParams, ["challenge", "state"]);
    if (
      !params ||
      !CHALLENGE_OR_STATE.test(params.challenge) ||
      !CHALLENGE_OR_STATE.test(params.state)
    ) {
      return invalidLink(response);
    }
    const nonce = nonceFor(params.challenge, params.state, windowNow());
    html(
      response,
      200,
      `<h1>Allow the app to read your Collection?</h1>` +
        `<p>Signed in as ${escapeHtml(COLLECTOR.name)}. The app on this phone will be able to see your Collection. It can't change anything.</p>` +
        `<form method="post" action="/auth/native/approve">` +
        `<input type="hidden" name="challenge" value="${params.challenge}">` +
        `<input type="hidden" name="state" value="${params.state}">` +
        `<input type="hidden" name="nonce" value="${nonce}">` +
        `<button type="submit">Allow</button></form>` +
        `<p><a href="${CALLBACK}?error=access_denied&amp;state=${params.state}">Cancel</a></p>`
    );
  }
  async function approvePost(request, response) {
    const fail = (status, text) =>
      html(response, status, `<h1>Prizecheck</h1><p>${text}</p>`);
    if (request.headers.origin !== origin)
      return fail(403, "This request wasn't allowed.");
    if (
      !/^application\/x-www-form-urlencoded(?:\s*;.*)?$/i.test(
        request.headers["content-type"] ?? ""
      )
    ) {
      return fail(
        400,
        "This sign-in link isn't valid. Go back to the app and try again."
      );
    }
    const body = await readBody(request, 2048);
    const params =
      body === null
        ? null
        : exactParams(new URLSearchParams(body), [
            "challenge",
            "state",
            "nonce",
          ]);
    if (
      !params ||
      !CHALLENGE_OR_STATE.test(params.challenge) ||
      !CHALLENGE_OR_STATE.test(params.state)
    ) {
      return fail(
        400,
        "This sign-in link isn't valid. Go back to the app and try again."
      );
    }
    if (!nonceValid(params.nonce, params.challenge, params.state))
      return fail(
        403,
        "This request couldn't be verified. Go back to the app and try again."
      );
    if (limited("native_approve", request))
      return fail(429, "Too many attempts. Try again later.");
    const code = b64url(randomBytes(32));
    prune();
    grants.set(sha256(code).toString("hex"), {
      challenge: params.challenge,
      expires: now() + 60_000,
    });
    response.writeHead(303, {
      location: `${CALLBACK}?code=${code}&state=${params.state}`,
      "cache-control": "no-store",
    });
    response.end();
  }
  async function tokenPost(request, response) {
    const bad = () => json(response, 400, { error: "invalid_request" });
    if (
      request.headers.cookie !== undefined ||
      request.headers.origin !== undefined
    )
      return bad();
    if (
      !/^application\/json(?:\s*;.*)?$/i.test(
        request.headers["content-type"] ?? ""
      )
    )
      return bad();
    const text = await readBody(request, 1024);
    let parsed;
    try {
      parsed = text === null ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join() !== "code,verifier" ||
      typeof parsed.code !== "string" ||
      typeof parsed.verifier !== "string" ||
      !TOKEN.test(parsed.code) ||
      !VERIFIER.test(parsed.verifier)
    ) {
      return bad();
    }
    if (limited("native_token", request))
      return json(
        response,
        429,
        { error: "too_many_requests" },
        { "retry-after": "3600" }
      );
    prune();
    const hash = sha256(parsed.code).toString("hex");
    const grant = grants.get(hash);
    // A wrong verifier deletes nothing, so the code can still be exchanged with the right one.
    if (
      !grant ||
      grant.expires <= now() ||
      b64url(sha256(parsed.verifier)) !== grant.challenge
    ) {
      return json(response, 400, { error: "invalid_grant" });
    }
    grants.delete(hash);
    const token = b64url(randomBytes(32));
    const expires = now() + tokenLifetimeMs;
    credentials.set(sha256(token).toString("hex"), { expires, revoked: false });
    json(response, 200, { token, expires_at: new Date(expires).toISOString() });
  }
  function collection(request, url, response) {
    const unauthorized = () =>
      json(response, 401, { error: "Authentication required" });
    if (request.method !== "GET" || !credentialFor(bearer(request)))
      return unauthorized();
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) return json(response, 200, PAGES[0]);
    if (cursor === NATIVE_SECOND_CURSOR) return json(response, 200, PAGES[1]);
    json(response, 400, { error: "Invalid cursor" });
  }
  /** The same rules and order as the gateway: 400 for a bad shape, then 503 while the fault is on, else 204. */
  function signOut(request, response) {
    const fields = [];
    for (let at = 0; at + 1 < request.rawHeaders.length; at += 2)
      if (request.rawHeaders[at].toLowerCase() === "authorization")
        fields.push(request.rawHeaders[at + 1]);
    const match =
      fields.length === 1
        ? /^Bearer ([A-Za-z0-9_-]{43})$/.exec(fields[0])
        : null;
    if (
      !match ||
      request.headers.cookie !== undefined ||
      request.headers.origin !== undefined
    )
      return json(response, 400, { error: "invalid_request" });
    if (failSignOut) {
      refused += 1;
      return json(response, 503, { error: "Service temporarily unavailable" });
    }
    const credential = credentialFor(sha256(match[1]).toString("hex"));
    if (credential) {
      credential.revoked = true;
      confirmed += 1;
    }
    response.writeHead(204, { "cache-control": "no-store" });
    response.end();
  }
  /** Counts only: live is the number of unrevoked, unexpired credentials. */
  function control(path, response) {
    if (path === "/fixture/sign-out/fail") failSignOut = true;
    if (path === "/fixture/sign-out/ok") failSignOut = false;
    let live = 0;
    for (const credential of credentials.values())
      if (!credential.revoked && credential.expires > now()) live += 1;
    json(response, 200, { live, refused, confirmed });
  }

  const server = createServer((request, response) => {
    const method = request.method;
    let label = "other";
    response.on("finish", () => {
      if (!log) return;
      const verb = method === "GET" || method === "POST" ? method : "OTHER";
      log(
        `native-fixture route=${label} method=${verb} status=${response.statusCode}`
      );
    });
    let url;
    try {
      url = new URL(request.url, origin);
    } catch {
      response.writeHead(400, { "cache-control": "no-store" });
      return response.end();
    }
    const path = url.pathname;
    label = routeLabel(path, method);
    if (path === "/auth/native/start" && method === "GET")
      return start(url, response);
    if (path === "/auth/native/approve" && method === "GET")
      return approvePage(url, response);
    if (path === "/auth/native/approve" && method === "POST")
      return void approvePost(request, response);
    if (path === "/auth/native/token" && method === "POST")
      return void tokenPost(request, response);
    if (path === "/auth/native/sign-out" && method === "POST")
      return signOut(request, response);
    if (label === "fixture") return control(path, response);
    // The gateway proxy answers every other /api path with 401 here: the bearer is scoped.
    if (path === "/api/collection") return collection(request, url, response);
    if (path.startsWith("/api/"))
      return json(response, 401, { error: "Authentication required" });
    response.writeHead(404, { "cache-control": "no-store" });
    response.end();
  });
  server.on("listening", () => {
    // A test server listens on an ephemeral port; the origin is whatever it bound.
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  nativeFixture({ log: stdoutLog }).listen(PORT, "127.0.0.1", () =>
    process.stdout.write(
      `Native sign-in stub listening on loopback port ${PORT}\n`
    )
  );
}
