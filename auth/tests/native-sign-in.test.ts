import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { createServer, type Server } from "node:http";
import { safeNext } from "../src/nextPath.js";
import { nativeSignInEnabled } from "../src/native.js";
import {
  cookieHeader,
  walkSignIn,
  type Jar,
} from "../testing/oauth-fake/walk.js";
import {
  freePort,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

// Native iOS sign-in (opt-in, nonprod only), through the real gateway, the OAuth test fake and a disposable database.
// The `on` gateway runs in local-public mode so two collectors can sign in; the `off` gateway is the default one.
// Each test signs in through real HTTP walks, which a loaded host can stretch past the 15 s default.
vi.setConfig({ testTimeout: 60_000 });
let on: TestGateway;
let off: TestGateway;
// A recording Riftbound upstream for the `on` gateway (RIFTBOUND_API_ORIGIN), so the tests can show what reaches it.
let riftbound: Server;
const riftboundSeen: { method: string; url: string }[] = [];
// Every secret a test handles, so the last test can prove none of them reached a log.
const secrets: string[] = [];
beforeAll(async () => {
  riftbound = createServer((request, response) => {
    riftboundSeen.push({
      method: request.method || "",
      url: request.url || "",
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ from: "riftbound" }));
  });
  const riftboundPort = await freePort();
  await new Promise<void>((resolve) =>
    riftbound.listen(riftboundPort, "127.0.0.1", resolve)
  );
  [on, off] = await Promise.all([
    startGateway({
      env: {
        NATIVE_SIGN_IN: "on",
        SIGNUP_MODE: "local-public",
        RIFTBOUND_API_ORIGIN: `http://127.0.0.1:${riftboundPort}`,
      },
    }),
    startGateway(),
  ]);
}, 90_000);
afterAll(async () => {
  await Promise.all([
    on?.stop(),
    off?.stop(),
    new Promise((resolve) =>
      riftbound ? riftbound.close(resolve) : resolve(0)
    ),
  ]);
}, 30_000);
// Every request comes from one address, so the tests would share the hourly limits; the limit tests seed their own.
beforeEach(async () => {
  await on.pool.query(
    "DELETE FROM auth_rate_event WHERE kind IN ('native_approve','native_token')"
  );
});

const b64 = (bytes: Buffer) => bytes.toString("base64url");
const sha = (value: string) => createHash("sha256").update(value).digest();
const pkce = () => {
  const verifier = b64(randomBytes(32));
  secrets.push(verifier);
  return {
    verifier,
    challenge: b64(sha(verifier)),
    state: b64(randomBytes(32)),
  };
};
const approvePath = (challenge: string, state: string) =>
  `/auth/native/approve?challenge=${challenge}&state=${state}`;
const callbackFor = (location: string) => {
  const url = new URL(location);
  return {
    scheme: url.protocol,
    host: url.host,
    path: url.pathname,
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    keys: [...url.searchParams.keys()],
  };
};

/** A web sign-in that lands on the native approve page, the way the app's sign-in sheet does. */
async function webSignIn(
  gateway: TestGateway,
  identity: string,
  challenge: string,
  state: string
): Promise<Jar> {
  const next = encodeURIComponent(approvePath(challenge, state));
  const walk = await walkSignIn(
    gateway.base,
    `/auth/sign-in/google?next=${next}`,
    identity
  );
  expect(walk.location).toBe(approvePath(challenge, state));
  return walk.jar;
}

const getPage = (gateway: TestGateway, path: string, jar?: Jar) =>
  fetch(gateway.base + path, {
    redirect: "manual",
    headers: jar ? { cookie: cookieHeader(jar) } : {},
  });

async function nonceOf(
  gateway: TestGateway,
  jar: Jar,
  challenge: string,
  state: string
): Promise<string> {
  const html = await (
    await getPage(gateway, approvePath(challenge, state), jar)
  ).text();
  const nonce = /name="nonce" value="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];
  if (!nonce) throw new Error("No nonce on the consent page");
  return nonce;
}

function postApprove(
  gateway: TestGateway,
  jar: Jar | null,
  fields: Record<string, string>,
  headers: Record<string, string | null> = {}
) {
  const sent: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: gateway.base,
  };
  if (jar) sent.cookie = cookieHeader(jar);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete sent[name];
    else sent[name] = value;
  }
  return fetch(gateway.base + "/auth/native/approve", {
    method: "POST",
    redirect: "manual",
    headers: sent,
    body: new URLSearchParams(fields).toString(),
  });
}

/** Signs in, approves and returns the one-time code. */
async function issueCode(gateway: TestGateway, identity = "owner", jar?: Jar) {
  const { verifier, challenge, state } = pkce();
  const session = jar ?? (await webSignIn(gateway, identity, challenge, state));
  const nonce = await nonceOf(gateway, session, challenge, state);
  const approved = await postApprove(gateway, session, {
    challenge,
    state,
    nonce,
  });
  expect(approved.status).toBe(303);
  const code = callbackFor(approved.headers.get("location")!).code!;
  secrets.push(code);
  return { code, verifier, challenge, state, jar: session };
}

const exchange = (
  gateway: TestGateway,
  body: unknown,
  headers: Record<string, string> = {}
) =>
  fetch(gateway.base + "/auth/native/token", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

async function issueToken(gateway: TestGateway, identity = "owner") {
  const { code, verifier } = await issueCode(gateway, identity);
  const response = await exchange(gateway, { code, verifier });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { token: string; expires_at: string };
  secrets.push(body.token);
  return body.token;
}

const bearerGet = (
  gateway: TestGateway,
  path: string,
  token: string,
  init: RequestInit = {}
) =>
  fetch(gateway.base + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });

const count = async (
  gateway: TestGateway,
  sql: string,
  values: unknown[] = []
) => (await gateway.pool.query(sql, values)).rows[0].n as number;
const grants = (gateway: TestGateway) =>
  count(gateway, "SELECT count(*)::int AS n FROM native_grant");

/** Sends the request line as written, so a fragment reaches the gateway as a client could send it. */
function rawGet(gateway: TestGateway, target: string): Promise<number> {
  const url = new URL(gateway.base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () =>
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`
      )
    );
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Number(text.split(" ")[1])));
  });
}

describe("the switch", () => {
  it("accepts on, off, empty and unset, and rejects everything else, and on in production", () => {
    expect(nativeSignInEnabled({})).toBe(false);
    expect(nativeSignInEnabled({ NATIVE_SIGN_IN: "" })).toBe(false);
    expect(nativeSignInEnabled({ NATIVE_SIGN_IN: "off" })).toBe(false);
    expect(nativeSignInEnabled({ NATIVE_SIGN_IN: "on" })).toBe(true);
    expect(
      nativeSignInEnabled({ NATIVE_SIGN_IN: "on", NODE_ENV: "development" })
    ).toBe(true);
    for (const value of [
      "true",
      "1",
      "yes",
      "enabled",
      "onn",
      "ON",
      "On",
      " on ",
      "on\n",
      "OFF",
      "Off",
      " ",
      " off",
    ])
      expect(() => nativeSignInEnabled({ NATIVE_SIGN_IN: value })).toThrow(
        /NATIVE_SIGN_IN/
      );
    expect(() =>
      nativeSignInEnabled({ NATIVE_SIGN_IN: "on", NODE_ENV: "production" })
    ).toThrow(/production/);
    expect(nativeSignInEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("stops the gateway at startup for a bad value, and for on in production", async () => {
    await expect(
      startGateway({ env: { NATIVE_SIGN_IN: "maybe" } })
    ).rejects.toThrow(/NATIVE_SIGN_IN must be on or off/);
    await expect(
      startGateway({
        preload: false,
        env: {
          NATIVE_SIGN_IN: "on",
          NODE_ENV: "production",
          MAIL_MODE: undefined,
        },
      })
    ).rejects.toThrow(/NATIVE_SIGN_IN is not available in production/);
  }, 90_000);

  it("answers 404 on every native route while off, and ignores Authorization as before", async () => {
    const { challenge, state } = pkce();
    for (const [method, path] of [
      ["GET", `/auth/native/start?challenge=${challenge}&state=${state}`],
      ["GET", approvePath(challenge, state)],
      ["POST", "/auth/native/approve"],
      ["POST", "/auth/native/token"],
      ["POST", "/auth/native/sign-out"],
    ] as const) {
      const response = await fetch(off.base + path, {
        method,
        redirect: "manual",
        headers: { origin: off.base },
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    // A bearer is not looked at: with no cookie the request is unauthenticated, with a cookie it is that session.
    const anonymous = await bearerGet(
      off,
      "/api/collection",
      b64(randomBytes(32))
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({
      error: "Authentication required",
    });
    const jar = (await walkSignIn(off.base, "/auth/sign-in/google", "owner"))
      .jar;
    const before = off.apiRequests.length;
    const withCookie = await fetch(off.base + "/api/collection", {
      headers: { authorization: "Bearer junk", cookie: cookieHeader(jar) },
    });
    expect(withCookie.status).toBe(200);
    const forwarded = off.apiRequests.slice(before);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].headers.authorization).toBeUndefined();
    expect(forwarded[0].headers["x-internal-user"]).toBeTruthy();
    expect(
      (await off.pool.query("SELECT count(*)::int AS n FROM native_grant"))
        .rows[0].n
    ).toBe(0);
  });

  it("leaves the sign-in next parameter as it was while off", async () => {
    const { challenge, state } = pkce();
    const walk = await walkSignIn(
      off.base,
      `/auth/sign-in/google?next=${encodeURIComponent(approvePath(challenge, state))}`,
      "owner"
    );
    expect(walk.location).toBe("/collection");
  });
});

describe("safeNext", () => {
  const { challenge, state } = pkce();
  const good = approvePath(challenge, state);

  it("refuses the native approve path unless native sign-in is on", () => {
    expect(safeNext(good)).toBe("/collection");
    expect(safeNext(good, false)).toBe("/collection");
    expect(safeNext(good, true)).toBe(good);
  });

  it("keeps every other /auth and /api path refused, with the switch on", () => {
    for (const value of [
      "/auth/native/start?challenge=" + challenge + "&state=" + state,
      "/auth/native/token",
      "/auth/native/sign-out",
      "/auth/native/approve",
      "/auth/sign-in/google",
      "/auth/session",
      "/api/collection",
      "/auth/",
    ])
      expect(safeNext(value, true), value).toBe("/collection");
  });

  it("refuses normalization attacks on the exception", () => {
    const query = `?challenge=${challenge}&state=${state}`;
    for (const value of [
      `/auth/native/approve/${query}`,
      `/auth/native/approve//${query}`,
      `/auth/native/./approve${query}`,
      `/auth/native/x/../approve${query}`,
      `/auth/native/%61pprove${query}`,
      `/auth/native%2Fapprove${query}`,
      `/auth%2Fnative/approve${query}`,
      `/auth/native/approve%2f${query}`,
      `/auth/native/approve%00${query}`,
      `/Auth/Native/Approve${query}`,
      `/AUTH/native/approve${query}`,
      `//auth/native/approve${query}`,
      `/\\auth/native/approve${query}`,
      `/auth/native/approve\\${query}`,
      `https://evil.example/auth/native/approve${query}`,
      `/auth/native/approve${query}#frag`,
      `/auth/native/approve${query}&extra=1`,
      `/auth/native/approve?state=${state}&challenge=${challenge}&state=${state}`,
      `/auth/native/approve?challenge=${challenge}&challenge=${challenge}&state=${state}`,
      `/auth/native/approve?challenge=${challenge}`,
      `/auth/native/approve?challenge=short&state=${state}`,
      `/auth/native/approve?challenge=${challenge}=&state=${state}`,
      `/auth/native/approve?challenge=${challenge}&state=${state}%0a`,
      `/auth/native/approve?next=/x&challenge=${challenge}&state=${state}`,
      `/auth/native/approve;x${query}`,
    ])
      expect(safeNext(value, true), value).toBe("/collection");
  });

  it("returns the exception rebuilt from the parsed values, and other paths as before", () => {
    // The same two values in the other order, and an encoded but valid letter.
    const swapped = `/auth/native/approve?state=${state}&challenge=${challenge}`;
    expect(safeNext(swapped, true)).toBe(good);
    expect(safeNext("/collection/x?y=1", true)).toBe("/collection/x?y=1");
    expect(safeNext("/settings", true)).toBe("/settings");
  });

  it("lets the sign-in start carry the approve path through, while on", async () => {
    const { challenge: c, state: s } = pkce();
    const jar = await webSignIn(on, "owner", c, s);
    expect(jar.size).toBeGreaterThan(0);
  });
});

describe("start", () => {
  it("answers 400 for missing, duplicate, extra and malformed parameters, and for a fragment", async () => {
    const { challenge, state } = pkce();
    const bad = [
      "",
      `?challenge=${challenge}`,
      `?state=${state}`,
      `?challenge=${challenge}&state=${state}&state=${state}`,
      `?challenge=${challenge}&challenge=${challenge}&state=${state}`,
      `?challenge=${challenge}&state=${state}&next=/x`,
      `?challenge=${challenge}x&state=${state}`,
      `?challenge=${challenge.slice(1)}&state=${state}`,
      `?challenge=${challenge}=&state=${state}`,
      `?challenge=${challenge}&state=${state.slice(0, 42)}!`,
      `?challenge=&state=${state}`,
      `?challenge[]=${challenge}&state=${state}`,
    ];
    for (const query of bad) {
      const response = await getPage(on, `/auth/native/start${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.text()).toContain(
        "This sign-in link isn't valid. Go back to the app and try again."
      );
    }
    expect(
      await rawGet(
        on,
        `/auth/native/start?challenge=${challenge}&state=${state}#frag`
      )
    ).toBe(400);
  });

  it("shows one link per configured provider when signed out, with the page headers", async () => {
    const { challenge, state } = pkce();
    const response = await getPage(
      on,
      `/auth/native/start?challenge=${challenge}&state=${state}`
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' prizecheck-native:; base-uri 'none'; frame-ancestors 'none'"
    );
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain("<h1>Sign in to Prizecheck</h1>");
    const next = encodeURIComponent(approvePath(challenge, state));
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(links).toEqual([
      `/auth/sign-in/google?next=${next}`,
      `/auth/sign-in/discord?next=${next}`,
    ]);
  });

  it("redirects to the consent page when signed in", async () => {
    const { challenge, state } = pkce();
    const jar = await webSignIn(on, "owner", challenge, state);
    const response = await getPage(
      on,
      `/auth/native/start?challenge=${challenge}&state=${state}`,
      jar
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      approvePath(challenge, state)
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("approve page", () => {
  it("needs a web session, and issues nothing on a GET", async () => {
    const { challenge, state } = pkce();
    const before = await grants(on);
    const anonymous = await getPage(on, approvePath(challenge, state));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toBe(
      `/auth/native/start?challenge=${challenge}&state=${state}`
    );
    const invalid = await getPage(
      on,
      "/auth/native/approve?challenge=x&state=y"
    );
    expect(invalid.status).toBe(400);
    const jar = await webSignIn(on, "owner", challenge, state);
    const page = await getPage(on, approvePath(challenge, state), jar);
    expect(page.status).toBe(200);
    expect(await grants(on)).toBe(before);
  });

  it("shows the consent text, the Allow form and the Cancel link, with the page headers", async () => {
    const { challenge, state } = pkce();
    const jar = await webSignIn(on, "owner", challenge, state);
    const response = await getPage(on, approvePath(challenge, state), jar);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "form-action 'self' prizecheck-native:"
    );
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();
    expect(html).toContain("Allow the app to read your Collection?");
    expect(html).toContain(
      "Signed in as Owner Collector. The app on this phone will be able to see your Collection. It can't change anything."
    );
    expect(html).toContain(
      '<form method="post" action="/auth/native/approve">'
    );
    expect(html).toContain(`name="challenge" value="${challenge}"`);
    expect(html).toContain(`name="state" value="${state}"`);
    expect(html).toContain(">Allow</button>");
    expect(html).toContain(
      `href="prizecheck-native://auth/callback?error=access_denied&amp;state=${state}"`
    );
  });

  it("escapes the account name, and falls back to the email when there is no name", async () => {
    const { challenge, state } = pkce();
    const jar = await webSignIn(on, "newcomer", challenge, state);
    const hostile = `<script>alert(1)</script>"'&<img src=x>`;
    await on.pool.query(`UPDATE "user" SET name=$1 WHERE email=$2`, [
      hostile,
      "newcomer@example.test",
    ]);
    const html = await (
      await getPage(on, approvePath(challenge, state), jar)
    ).text();
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;&lt;img src=x&gt;"
    );
    await on.pool.query(`UPDATE "user" SET name='' WHERE email=$1`, [
      "newcomer@example.test",
    ]);
    const plain = await (
      await getPage(on, approvePath(challenge, state), jar)
    ).text();
    expect(plain).toContain("Signed in as newcomer@example.test.");
  });
});

describe("approve", () => {
  it("issues a code only on the valid path and answers 303 to the callback", async () => {
    const { verifier, challenge, state } = pkce();
    const jar = await webSignIn(on, "owner", challenge, state);
    const nonce = await nonceOf(on, jar, challenge, state);
    const before = await grants(on);
    const response = await postApprove(on, jar, { challenge, state, nonce });
    expect(response.status).toBe(303);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const callback = callbackFor(response.headers.get("location")!);
    expect(callback).toMatchObject({
      scheme: "prizecheck-native:",
      host: "auth",
      path: "/callback",
      state,
      keys: ["code", "state"],
    });
    expect(callback.code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    secrets.push(callback.code!);
    expect(await grants(on)).toBe(before + 1);
    const row = (
      await on.pool.query(
        `SELECT code_hash, user_id, challenge,
          extract(epoch FROM expires_at - created_at)::int AS ttl
         FROM native_grant WHERE code_hash=$1`,
        [createHash("sha256").update(callback.code!).digest("hex")]
      )
    ).rows[0];
    expect(row.challenge).toBe(b64(sha(verifier)));
    expect(row.ttl).toBeGreaterThanOrEqual(59);
    expect(row.ttl).toBeLessThanOrEqual(61);
    // The code itself is not stored.
    expect(
      await count(
        on,
        "SELECT count(*)::int AS n FROM native_grant WHERE code_hash=$1",
        [callback.code]
      )
    ).toBe(0);
  });

  it("refuses a forged, missing or null Origin before issuing anything", async () => {
    const { challenge, state } = pkce();
    const jar = await webSignIn(on, "owner", challenge, state);
    const nonce = await nonceOf(on, jar, challenge, state);
    const before = await grants(on);
    for (const origin of [
      "https://evil.example",
      "null",
      null,
      on.base + "/",
      "",
    ]) {
      const response = await postApprove(
        on,
        jar,
        { challenge, state, nonce },
        { origin }
      );
      expect(response.status, String(origin)).toBe(403);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/html");
    }
    expect(await grants(on)).toBe(before);
  });

  it("still refuses an Origin: null approve POST that is otherwise valid, and issues no code", async () => {
    const { challenge, state } = pkce();
    const jar = await webSignIn(on, "owner", challenge, state);
    const nonce = await nonceOf(on, jar, challenge, state);
    const before = await grants(on);
    const response = await postApprove(
      on,
      jar,
      { challenge, state, nonce },
      { origin: "null" }
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(await grants(on)).toBe(before);
    // The same session, nonce, challenge and state pass with the exact Origin.
    const allowed = await postApprove(on, jar, { challenge, state, nonce });
    expect(allowed.status).toBe(303);
    expect(await grants(on)).toBe(before + 1);
  });

  it("refuses a missing session, a missing, stale, other-session or other-challenge nonce", async () => {
    const { challenge, state } = pkce();
    const jar = await webSignIn(on, "owner", challenge, state);
    const nonce = await nonceOf(on, jar, challenge, state);
    const before = await grants(on);
    // No web session.
    expect(
      (await postApprove(on, null, { challenge, state, nonce })).status
    ).toBe(401);
    // Missing nonce, duplicate fields and extra fields.
    expect((await postApprove(on, jar, { challenge, state })).status).toBe(400);
    expect(
      (await postApprove(on, jar, { challenge, state, nonce, extra: "1" }))
        .status
    ).toBe(400);
    const duplicated = await fetch(on.base + "/auth/native/approve", {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: on.base,
        cookie: cookieHeader(jar),
      },
      body: `challenge=${challenge}&state=${state}&nonce=${nonce}&nonce=${nonce}`,
    });
    expect(duplicated.status).toBe(400);
    // A JSON body is not a form.
    const json = await fetch(on.base + "/auth/native/approve", {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        origin: on.base,
        cookie: cookieHeader(jar),
      },
      body: JSON.stringify({ challenge, state, nonce }),
    });
    expect(json.status).toBe(400);
    // A nonce that is well formed but wrong.
    expect(
      (
        await postApprove(on, jar, {
          challenge,
          state,
          nonce: b64(randomBytes(32)),
        })
      ).status
    ).toBe(403);
    // A nonce for another challenge or another state.
    const other = pkce();
    expect(
      (await postApprove(on, jar, { challenge: other.challenge, state, nonce }))
        .status
    ).toBe(403);
    expect(
      (await postApprove(on, jar, { challenge, state: other.state, nonce }))
        .status
    ).toBe(403);
    // A nonce made for another web session, even of the same collector.
    const second = await webSignIn(on, "owner", challenge, state);
    const secondNonce = await nonceOf(on, second, challenge, state);
    expect(secondNonce).not.toBe(nonce);
    expect(
      (await postApprove(on, second, { challenge, state, nonce })).status
    ).toBe(403);
    expect(
      (await postApprove(on, jar, { challenge, state, nonce: secondNonce }))
        .status
    ).toBe(403);
    expect(await grants(on)).toBe(before);
    // A nonce from a window two intervals back is stale; the previous window is still accepted.
    const sessionId = (
      await on.pool.query("SELECT id FROM session WHERE token=$1", [
        decodeURIComponent(jar.get("better-auth.session_token")!).split(".")[0],
      ])
    ).rows[0].id as string;
    const secret = process.env.INTERNAL_AUTH_SECRET!;
    const key = createHmac("sha256", secret)
      .update("native-approve-key")
      .digest();
    const window = Math.floor(Date.now() / 600_000);
    const forWindow = (w: number) =>
      createHmac("sha256", key)
        .update(`native-approve\n${sessionId}\n${challenge}\n${state}\n${w}`)
        .digest("base64url");
    expect(forWindow(window)).toBe(nonce);
    expect(
      (
        await postApprove(on, jar, {
          challenge,
          state,
          nonce: forWindow(window - 2),
        })
      ).status
    ).toBe(403);
    expect(
      (
        await postApprove(on, jar, {
          challenge,
          state,
          nonce: forWindow(window - 1),
        })
      ).status
    ).toBe(303);
    expect(await grants(on)).toBe(before + 1);
  });

  it("limits approvals to 20 per trusted IP per hour, durably", async () => {
    await on.pool.query(
      "DELETE FROM auth_rate_event WHERE kind='native_approve'"
    );
    const first = await issueCode(on);
    const key = (
      await on.pool.query(
        "SELECT ip_key FROM auth_rate_event WHERE kind='native_approve'"
      )
    ).rows[0].ip_key as string;
    await on.pool.query(
      `INSERT INTO auth_rate_event(kind,ip_key) SELECT 'native_approve',$1 FROM generate_series(1,19)`,
      [key]
    );
    const { challenge, state } = pkce();
    const nonce = await nonceOf(on, first.jar, challenge, state);
    const before = await grants(on);
    const refused = await postApprove(on, first.jar, {
      challenge,
      state,
      nonce,
    });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("location")).toBeNull();
    expect(await grants(on)).toBe(before);
    await on.pool.query(
      "DELETE FROM auth_rate_event WHERE kind='native_approve'"
    );
  });
});

describe("token", () => {
  it("exchanges a code with its verifier for a hashed, 24-hour, read-only credential", async () => {
    const { code, verifier } = await issueCode(on);
    const response = await exchange(on, { code, verifier });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as {
      token: string;
      expires_at: string;
    };
    secrets.push(body.token);
    expect(Object.keys(body).sort()).toEqual(["expires_at", "token"]);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hours = (Date.parse(body.expires_at) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const row = (
      await on.pool.query(
        "SELECT scope, revoked_at FROM native_credential WHERE token_hash=$1",
        [createHash("sha256").update(body.token).digest("hex")]
      )
    ).rows[0];
    expect(row).toEqual({ scope: "collection:read", revoked_at: null });
    expect(
      await count(
        on,
        "SELECT count(*)::int AS n FROM native_credential WHERE token_hash=$1",
        [body.token]
      )
    ).toBe(0);
    // The code is single use.
    const again = await exchange(on, { code, verifier });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_grant" });
  });

  it("prunes credentials that expired or were revoked over a day ago and keeps the rest", async () => {
    const hash = (token: string) =>
      createHash("sha256").update(token).digest("hex");
    const oldExpired = await issueToken(on, "owner");
    const oldRevoked = await issueToken(on, "owner");
    const recentExpired = await issueToken(on, "owner");
    const active = await issueToken(on, "owner");
    await on.pool.query(
      "UPDATE native_credential SET expires_at=now()-interval '2 days' WHERE token_hash=$1",
      [hash(oldExpired)]
    );
    await on.pool.query(
      "UPDATE native_credential SET revoked_at=now()-interval '2 days' WHERE token_hash=$1",
      [hash(oldRevoked)]
    );
    await on.pool.query(
      "UPDATE native_credential SET expires_at=now()-interval '1 hour' WHERE token_hash=$1",
      [hash(recentExpired)]
    );
    const issued = await issueToken(on, "owner");
    const present = async (token: string) =>
      count(
        on,
        `SELECT count(*)::int AS n FROM native_credential WHERE token_hash='${hash(token)}'`
      );
    expect(await present(oldExpired)).toBe(0);
    expect(await present(oldRevoked)).toBe(0);
    expect(await present(recentExpired)).toBe(1);
    expect(await present(active)).toBe(1);
    expect(await present(issued)).toBe(1);
  });

  it("gives exactly one of several concurrent exchanges the credential", async () => {
    const { code, verifier } = await issueCode(on);
    const before = await count(
      on,
      "SELECT count(*)::int AS n FROM native_credential"
    );
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => exchange(on, { code, verifier }))
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 400, 400, 400, 400, 400]);
    for (const response of responses)
      if (response.status === 200)
        secrets.push(((await response.json()) as { token: string }).token);
    expect(
      await count(on, "SELECT count(*)::int AS n FROM native_credential")
    ).toBe(before + 1);
  });

  it("does not burn the code on a wrong verifier", async () => {
    const { code, verifier } = await issueCode(on);
    const wrong = b64(randomBytes(32));
    const refused = await exchange(on, { code, verifier: wrong });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "invalid_grant" });
    expect(
      await count(
        on,
        "SELECT count(*)::int AS n FROM native_grant WHERE code_hash=$1",
        [createHash("sha256").update(code).digest("hex")]
      )
    ).toBe(1);
    const accepted = await exchange(on, { code, verifier });
    expect(accepted.status).toBe(200);
    secrets.push(((await accepted.json()) as { token: string }).token);
  });

  it("refuses an expired or unknown code", async () => {
    const { code, verifier } = await issueCode(on);
    await on.pool.query(
      "UPDATE native_grant SET expires_at=now()-interval '1 second' WHERE code_hash=$1",
      [createHash("sha256").update(code).digest("hex")]
    );
    const expired = await exchange(on, { code, verifier });
    expect(expired.status).toBe(400);
    expect(await expired.json()).toEqual({ error: "invalid_grant" });
    const unknown = await exchange(on, {
      code: b64(randomBytes(32)),
      verifier,
    });
    expect(unknown.status).toBe(400);
  });

  it("refuses a cookie or an Origin header, and malformed bodies, with invalid_request", async () => {
    const { code, verifier } = await issueCode(on);
    const invalid = { error: "invalid_request" };
    for (const headers of [
      { cookie: "better-auth.session_token=x" },
      { cookie: "" },
      { origin: on.base },
      { origin: "null" },
    ]) {
      const response = await exchange(on, { code, verifier }, headers);
      expect(response.status, JSON.stringify(headers)).toBe(400);
      expect(await response.json()).toEqual(invalid);
    }
    for (const body of [
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ code }),
      JSON.stringify({ verifier }),
      JSON.stringify({ code, verifier, extra: 1 }),
      JSON.stringify({ code: 1, verifier }),
      JSON.stringify({ code: code.slice(1), verifier }),
      JSON.stringify({ code, verifier: "short" }),
      JSON.stringify({ code, verifier: "!".repeat(43) }),
      JSON.stringify({ code, verifier: "a".repeat(129) }),
      JSON.stringify({ code, verifier, pad: "x".repeat(1100) }),
    ]) {
      const response = await exchange(on, body);
      expect(response.status, body.slice(0, 40)).toBe(400);
      expect(await response.json()).toEqual(invalid);
    }
    const wrongType = await fetch(on.base + "/auth/native/token", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ code, verifier }),
    });
    expect(wrongType.status).toBe(400);
    // Nothing above spent the code.
    expect((await exchange(on, { code, verifier })).status).toBe(200);
  });

  it("limits exchanges to 30 per trusted IP per hour, durably", async () => {
    await on.pool.query(
      "DELETE FROM auth_rate_event WHERE kind='native_token'"
    );
    const { code, verifier } = await issueCode(on);
    expect((await exchange(on, { code, verifier })).status).toBe(200);
    const key = (
      await on.pool.query(
        "SELECT ip_key FROM auth_rate_event WHERE kind='native_token'"
      )
    ).rows[0].ip_key as string;
    await on.pool.query(
      `INSERT INTO auth_rate_event(kind,ip_key) SELECT 'native_token',$1 FROM generate_series(1,29)`,
      [key]
    );
    const next = await issueCode(on);
    const limited = await exchange(on, {
      code: next.code,
      verifier: next.verifier,
    });
    expect(limited.status).toBe(429);
    expect(await grants(on)).toBeGreaterThan(0);
    await on.pool.query(
      "DELETE FROM auth_rate_event WHERE kind='native_token'"
    );
    expect(
      (await exchange(on, { code: next.code, verifier: next.verifier })).status
    ).toBe(200);
  });
});

describe("bearer", () => {
  it("reads /api/collection as that user, signed like a cookie session, and refreshes nothing", async () => {
    const token = await issueToken(on, "owner");
    const userId = (
      await on.pool.query(
        `SELECT id FROM "user" WHERE email='owner@example.test'`
      )
    ).rows[0].id as string;
    const before = on.apiRequests.length;
    const sessionsBefore = await count(
      on,
      "SELECT count(*)::int AS n FROM session"
    );
    const response = await bearerGet(on, "/api/collection?cursor=abc", token);
    expect(response.status).toBe(200);
    const forwarded = on.apiRequests.slice(before);
    expect(forwarded).toHaveLength(1);
    const seen = forwarded[0];
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe("/api/collection?cursor=abc");
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers["x-internal-user"]).toBe(userId);
    const stamp = seen.headers["x-internal-time"] as string;
    const emptyBody = createHash("sha256").update("").digest("hex");
    expect(seen.headers["x-internal-signature"]).toBe(
      createHmac("sha256", process.env.INTERNAL_AUTH_SECRET!)
        .update(`GET\n/api/collection\n${emptyBody}\n${userId}\n${stamp}`)
        .digest("hex")
    );
    expect(await count(on, "SELECT count(*)::int AS n FROM session")).toBe(
      sessionsBefore
    );
  });

  it("refuses every other path and method with 401, and never forwards them", async () => {
    const token = await issueToken(on, "owner");
    const before = on.apiRequests.length;
    for (const [method, path] of [
      ["GET", "/api/collection/extra"],
      ["GET", "/api/collection/"],
      ["GET", "/api/locations"],
      ["GET", "/api/health"],
      ["GET", "/api/public/decks"],
      ["GET", "/api/prices/editions"],
      ["POST", "/api/collection"],
      ["PUT", "/api/collection"],
      ["DELETE", "/api/collection"],
      ["PATCH", "/api/collection"],
      ["HEAD", "/api/collection"],
      ["GET", "/auth/session"],
    ] as const) {
      const response = await bearerGet(on, path, token, { method });
      if (path.startsWith("/api/")) {
        expect(response.status, `${method} ${path}`).toBe(401);
        if (method !== "HEAD")
          expect(await response.json()).toEqual({
            error: "Authentication required",
          });
      } else {
        // Not a gateway /api route: the bearer plays no part.
        expect((await response.json()).signedIn).toBe(false);
      }
    }
    expect(on.apiRequests.length).toBe(before);
  });

  it("refuses a malformed bearer, and a bearer with a cookie, even a valid web session", async () => {
    const token = await issueToken(on, "owner");
    for (const value of [
      `Bearer ${token}x`,
      `Bearer ${token.slice(1)}`,
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Basic ${token}`,
      token,
      "Bearer",
      "",
    ]) {
      const response = await fetch(on.base + "/api/collection", {
        headers: { authorization: value },
      });
      expect(response.status, value).toBe(401);
    }
    const walk = await walkSignIn(on.base, "/auth/sign-in/google", "owner");
    const both = await fetch(on.base + "/api/collection", {
      headers: {
        authorization: `Bearer ${token}`,
        cookie: cookieHeader(walk.jar),
      },
    });
    expect(both.status).toBe(401);
    // A valid web session with a junk bearer is refused too: there is no fallback to the cookie.
    const junk = await fetch(on.base + "/api/collection", {
      headers: { authorization: "Bearer junk", cookie: cookieHeader(walk.jar) },
    });
    expect(junk.status).toBe(401);
    // The cookie alone still works as before.
    const cookieOnly = await fetch(on.base + "/api/collection", {
      headers: { cookie: cookieHeader(walk.jar) },
    });
    expect(cookieOnly.status).toBe(200);
  });

  it("refuses Authorization on /api/riftbound/* with 401 before any upstream contact, and still proxies the cookie alone", async () => {
    const token = await issueToken(on, "owner");
    const walk = await walkSignIn(on.base, "/auth/sign-in/google", "owner");
    const cookie = cookieHeader(walk.jar);
    riftboundSeen.length = 0;
    const apiBefore = on.apiRequests.length;
    for (const path of [
      "/api/riftbound/cards?q=a",
      "/api/riftbound/collection",
    ]) {
      // A valid native bearer is never accepted, with or without a valid web session.
      for (const headers of [
        { authorization: `Bearer ${token}`, cookie },
        { authorization: `Bearer ${token}` },
        { authorization: "Bearer junk", cookie },
      ]) {
        const response = await fetch(on.base + path, { headers });
        expect(response.status, path).toBe(401);
        expect(await response.json()).toEqual({
          error: "Authentication required",
        });
      }
    }
    expect(riftboundSeen).toEqual([]);
    expect(on.apiRequests.length).toBe(apiBefore);
    // The same request without Authorization proxies as before.
    const plain = await fetch(on.base + "/api/riftbound/cards?q=a", {
      headers: { cookie },
    });
    expect(plain.status).toBe(200);
    expect(await plain.json()).toEqual({ from: "riftbound" });
    expect(riftboundSeen).toEqual([{ method: "GET", url: "/api/cards?q=a" }]);
    expect(on.apiRequests.length).toBe(apiBefore);
  });

  it("refuses an expired, revoked or unknown credential", async () => {
    const expired = await issueToken(on, "owner");
    const revoked = await issueToken(on, "owner");
    await on.pool.query(
      "UPDATE native_credential SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
      [createHash("sha256").update(expired).digest("hex")]
    );
    await on.pool.query(
      "UPDATE native_credential SET revoked_at=now() WHERE token_hash=$1",
      [createHash("sha256").update(revoked).digest("hex")]
    );
    for (const token of [expired, revoked, b64(randomBytes(32))])
      expect((await bearerGet(on, "/api/collection", token)).status).toBe(401);
  });

  it("does not take a web session token as a bearer, nor the raw credential as a cookie", async () => {
    const walk = await walkSignIn(on.base, "/auth/sign-in/google", "owner");
    const cookieValue = decodeURIComponent(
      walk.jar.get("better-auth.session_token")!
    );
    const sessionToken = cookieValue.split(".")[0];
    for (const candidate of [
      sessionToken,
      cookieValue,
      b64(Buffer.from(sessionToken.padEnd(32, "0"))).slice(0, 43),
    ]) {
      const response = await fetch(on.base + "/api/collection", {
        headers: { authorization: `Bearer ${candidate}` },
      });
      expect(response.status).toBe(401);
    }
    const token = await issueToken(on, "owner");
    for (const cookie of [
      `better-auth.session_token=${token}`,
      `better-auth.session_token=${token}.${token}`,
      `__Secure-better-auth.session_token=${token}`,
    ]) {
      const session = await (
        await fetch(on.base + "/auth/session", { headers: { cookie } })
      ).json();
      expect(session.signedIn).toBe(false);
      expect(
        (await fetch(on.base + "/api/collection", { headers: { cookie } }))
          .status
      ).toBe(401);
    }
  });

  it("reads as the collector who approved, not as another", async () => {
    const owner = await issueToken(on, "owner");
    const other = await issueToken(on, "newcomer");
    const before = on.apiRequests.length;
    await bearerGet(on, "/api/collection", owner);
    await bearerGet(on, "/api/collection", other);
    const users = on.apiRequests
      .slice(before)
      .map((r) => r.headers["x-internal-user"]);
    expect(users[0]).not.toBe(users[1]);
    expect(users[1]).toBe(
      (
        await on.pool.query(
          `SELECT id FROM "user" WHERE email='newcomer@example.test'`
        )
      ).rows[0].id
    );
  });
});

/** One HTTP/1.1 request exactly as written (header lines in order, duplicates kept), for targets and headers fetch would refuse. */
function wire(
  gateway: TestGateway,
  method: string,
  target: string,
  headers: string[] = []
): Promise<{ status: number; body: string }> {
  const url = new URL(gateway.base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname, () =>
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: ${url.host}\r\n${headers.map((line) => line + "\r\n").join("")}Connection: close\r\n\r\n`
      )
    );
    let text = "";
    socket.on("data", (chunk) => (text += chunk));
    socket.on("error", reject);
    socket.on("close", () =>
      resolve({
        status: Number(text.split(" ")[1]),
        body: text.split("\r\n\r\n").slice(1).join("\r\n\r\n"),
      })
    );
  });
}

/** Holds the session table locked while `run` executes: any session lookup would wait, so a prompt answer shows there was none. */
async function withSessionsLocked<T>(
  gateway: TestGateway,
  run: () => Promise<T>
): Promise<T> {
  const client = await gateway.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE session IN ACCESS EXCLUSIVE MODE");
    return await run();
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

describe("Authorization is decided first", () => {
  const untouched = () => ({
    api: on.apiRequests.length,
    riftbound: riftboundSeen.length,
  });

  it("refuses a valid credential on any target but the Collection read, before the Pokémon 404, the alias, the Riftbound refusal, any session lookup or any upstream", async () => {
    const token = await issueToken(on, "owner");
    const bearer = `Authorization: Bearer ${token}`;
    const before = untouched();
    const targets = [
      // Not the Collection: the Pokémon prefix (an unknown route, a moved route, a catalog tree, dot segments, encoded and
      // backslash separators), Riftbound (a normal and a refused target), the bare prefixes.
      "/api/pokemon/collection",
      "/api/pokemon/want-list",
      "/api/pokemon/catalog/cards",
      "/api/pokemon/prices/editions",
      "/api/pokemon",
      "/api/pokemon/",
      "/api/pokemon/%2e%2e/collection",
      "/api/pokemon/../collection",
      "/api/pokemon/%2Fcollection",
      "/api/pokemon%2fcollection",
      "/api/pokemon\\collection",
      "/api\\pokemon/want-list",
      "/api/riftbound/collection",
      "/api/riftbound/cards?q=a",
      "/api/riftbound/%2e%2e/collection",
      "/api/riftbound\\cards",
      "/api/riftbound",
      "/api/",
      "/api",
      // Absolute-form, and the Collection reached by normalisation rather than as written.
      `${on.base}/api/collection`,
      `${on.base}/api/pokemon/want-list`,
      "/api/%2e%2e/api/collection",
      "/api/x/../collection",
      "/x/../api/collection",
      "/api/./collection",
      "/api//collection",
      "/api/collection/",
      "/api\\collection",
      "/%61pi/collection",
      // The Collection with a query the app never sends, a bare "?" included.
      "/api/collection?",
      "/api/collection?cursor=",
      "/api/collection?cursor=a&cursor=b",
      "/api/collection?cursor=a&x=1",
      "/api/collection?x=1",
      "/api/collection?cursor=a/b",
      "/api/collection?cursor=%zz",
      "/api/collection?cursor=a#f",
    ];
    await withSessionsLocked(on, async () => {
      for (const target of targets) {
        const result = await wire(on, "GET", target, [bearer]);
        expect(result.status, target).toBe(401);
        expect(result.body, target).toContain(
          '"error":"Authentication required"'
        );
      }
    });
    expect(untouched()).toEqual(before);
  });

  it("refuses every method but GET, HEAD included, even for the Collection", async () => {
    const token = await issueToken(on, "owner");
    const before = untouched();
    await withSessionsLocked(on, async () => {
      for (const method of [
        "HEAD",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
        "OPTIONS",
      ]) {
        const result = await wire(on, method, "/api/collection", [
          `Authorization: Bearer ${token}`,
        ]);
        expect(result.status, method).toBe(401);
      }
    });
    expect(untouched()).toEqual(before);
  });

  it("refuses a duplicated Authorization field in either order, whichever one is valid", async () => {
    const token = await issueToken(on, "owner");
    const valid = `Authorization: Bearer ${token}`;
    const junk = `Authorization: Bearer ${b64(randomBytes(32))}`;
    const before = untouched();
    await withSessionsLocked(on, async () => {
      for (const target of [
        "/api/collection",
        "/api/pokemon/want-list",
        "/api/riftbound/cards",
      ])
        for (const headers of [
          [valid, valid],
          [valid, junk],
          [junk, valid],
          [valid, "authorization: " + token],
          ["AUTHORIZATION: Bearer " + token, valid],
        ]) {
          const result = await wire(on, "GET", target, headers);
          expect(result.status, `${target} ${headers.length}`).toBe(401);
        }
    });
    expect(untouched()).toEqual(before);
  });

  it("refuses a valid credential beside a Cookie, and an invalid one beside a valid session, with no session lookup and no upstream", async () => {
    const token = await issueToken(on, "owner");
    const walk = await walkSignIn(on.base, "/auth/sign-in/google", "owner");
    const cookie = `Cookie: ${cookieHeader(walk.jar)}`;
    const junk = `Authorization: Bearer ${b64(randomBytes(32))}`;
    const before = untouched();
    await withSessionsLocked(on, async () => {
      for (const target of [
        "/api/collection",
        "/api/pokemon/want-list",
        "/api/pokemon/collection",
        "/api/riftbound/cards",
      ]) {
        for (const headers of [
          [`Authorization: Bearer ${token}`, cookie],
          [cookie, `Authorization: Bearer ${token}`],
          [`Authorization: Bearer ${token}`, "Cookie: "],
          [junk, cookie],
          ["Authorization: ", cookie],
          ["Authorization: Bearer", cookie],
        ]) {
          const result = await wire(on, "GET", target, headers);
          expect(result.status, `${target} ${headers.join(" | ")}`).toBe(401);
        }
      }
    });
    expect(untouched()).toEqual(before);
  });

  it("still serves the canonical read, with and without the app's cursor, and sends no Authorization upstream", async () => {
    const token = await issueToken(on, "owner");
    for (const target of [
      "/api/collection",
      "/api/collection?cursor=abc",
      "/api/collection?cursor=a%2Fb%3D-._~",
    ]) {
      const before = on.apiRequests.length;
      const result = await wire(on, "GET", target, [
        `Authorization: Bearer ${token}`,
      ]);
      expect(result.status, target).toBe(200);
      const forwarded = on.apiRequests.slice(before);
      expect(forwarded, target).toHaveLength(1);
      expect(forwarded[0].url).toBe(target);
      expect(forwarded[0].headers.authorization).toBeUndefined();
      expect(forwarded[0].headers.cookie).toBeUndefined();
    }
  });

  it("only accepts a credential of the collection scope", async () => {
    const token = await issueToken(on, "owner");
    await on.pool.query(
      "ALTER TABLE native_credential DROP CONSTRAINT native_credential_scope_check"
    );
    try {
      await on.pool.query(
        "UPDATE native_credential SET scope='other' WHERE token_hash=$1",
        [createHash("sha256").update(token).digest("hex")]
      );
      const result = await wire(on, "GET", "/api/collection", [
        `Authorization: Bearer ${token}`,
      ]);
      expect(result.status).toBe(401);
    } finally {
      await on.pool.query(
        "UPDATE native_credential SET scope='collection:read' WHERE scope='other'"
      );
      await on.pool.query(
        "ALTER TABLE native_credential ADD CONSTRAINT native_credential_scope_check CHECK (scope = 'collection:read')"
      );
    }
  });

  it("leaves a request without Authorization exactly as it was: the alias, the 404s and the Riftbound refusal", async () => {
    const walk = await walkSignIn(on.base, "/auth/sign-in/google", "owner");
    const cookie = `Cookie: ${cookieHeader(walk.jar)}`;
    const before = on.apiRequests.length;
    const alias = await wire(on, "GET", "/api/pokemon/want-list", [cookie]);
    expect(alias.status).toBe(200);
    expect(on.apiRequests.slice(before).map((seen) => seen.url)).toEqual([
      "/api/want-list",
    ]);
    const after = untouched();
    for (const target of [
      "/api/pokemon/collection",
      "/api/pokemon/%2e%2e/loans",
      "/api/pokemon\\want-list",
      "/api/riftbound/%2e%2e/loans",
      `${on.base}/api/riftbound/cards`,
    ]) {
      const result = await wire(on, "GET", target, [cookie]);
      expect(result.status, target).toBe(404);
    }
    expect(untouched()).toEqual(after);
    // An unauthenticated read of a protected route is the usual 401, not a native decision.
    expect((await wire(on, "GET", "/api/locations")).status).toBe(401);
  });

  it("leaves everything as dev has it while the switch is off, whatever Authorization says", async () => {
    const jar = (await walkSignIn(off.base, "/auth/sign-in/google", "owner"))
      .jar;
    const cookie = `Cookie: ${cookieHeader(jar)}`;
    const junk = "Authorization: Bearer junk";
    const before = off.apiRequests.length;
    expect(
      (await wire(off, "GET", "/api/pokemon/collection", [junk])).status
    ).toBe(404);
    expect(
      (await wire(off, "GET", "/api/pokemon/want-list", [junk, junk, cookie]))
        .status
    ).toBe(200);
    expect(
      (await wire(off, "GET", "/api/collection", [junk, cookie])).status
    ).toBe(200);
    expect((await wire(off, "GET", "/api/collection", [junk])).status).toBe(
      401
    );
    expect(off.apiRequests.slice(before).map((seen) => seen.url)).toEqual([
      "/api/want-list",
      "/api/collection",
    ]);
    for (const seen of off.apiRequests.slice(before))
      expect(seen.headers.authorization).toBeUndefined();
  });
});

describe("sign-out", () => {
  it("revokes only the credential it names, and always answers 204", async () => {
    const first = await issueToken(on, "owner");
    const second = await issueToken(on, "owner");
    const out = await fetch(on.base + "/auth/native/sign-out", {
      method: "POST",
      headers: { authorization: `Bearer ${first}` },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get("cache-control")).toBe("no-store");
    expect((await bearerGet(on, "/api/collection", first)).status).toBe(401);
    expect((await bearerGet(on, "/api/collection", second)).status).toBe(200);
    // Again, an unknown token, a malformed one and none at all: nothing changes and nothing leaks.
    for (const headers of [
      { authorization: `Bearer ${first}` },
      { authorization: `Bearer ${b64(randomBytes(32))}` },
      { authorization: "Bearer junk" },
      {},
    ]) {
      const response = await fetch(on.base + "/auth/native/sign-out", {
        method: "POST",
        headers,
      });
      expect(response.status).toBe(204);
    }
    expect((await bearerGet(on, "/api/collection", second)).status).toBe(200);
  });

  it("ignores a request that carries a cookie or an Origin header", async () => {
    const token = await issueToken(on, "owner");
    for (const headers of [
      { cookie: "better-auth.session_token=x" },
      { origin: on.base },
    ]) {
      const response = await fetch(on.base + "/auth/native/sign-out", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
      });
      expect(response.status).toBe(204);
    }
    expect((await bearerGet(on, "/api/collection", token)).status).toBe(200);
  });
});

describe("unchanged", () => {
  it("keeps the web cookie flow as it was, with native sign-in on", async () => {
    const walk = await walkSignIn(on.base, "/auth/sign-in/google", "owner");
    expect(walk.location).toBe("/collection");
    const session = await (
      await fetch(on.base + "/auth/session", {
        headers: { cookie: cookieHeader(walk.jar) },
      })
    ).json();
    expect(session.signedIn).toBe(true);
    // Other /auth paths are still refused as a next target.
    const other = await walkSignIn(
      on.base,
      `/auth/sign-in/google?next=${encodeURIComponent("/auth/native/token")}`,
      "owner"
    );
    expect(other.location).toBe("/collection");
    // The consent page and the callbacks add no CORS headers anywhere.
    const { challenge, state } = pkce();
    for (const path of [
      `/auth/native/start?challenge=${challenge}&state=${state}`,
      "/auth/session",
    ]) {
      const response = await fetch(on.base + path, {
        headers: { origin: "https://evil.example" },
      });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    const token = await issueToken(on, "owner");
    const read = await bearerGet(on, "/api/collection", token, {
      headers: { origin: "https://evil.example" },
    });
    expect(read.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("logs no code, verifier or token", () => {
    expect(secrets.length).toBeGreaterThan(10);
    const logs = on.logs() + off.logs();
    for (const secret of secrets) expect(logs).not.toContain(secret);
    expect(logs).not.toMatch(/prizecheck-native:\/\//);
  });
});
