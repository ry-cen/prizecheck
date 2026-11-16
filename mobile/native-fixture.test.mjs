import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { nativeFixture, NATIVE_SECOND_CURSOR } from "./native-fixture.mjs";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const challengeFor = (verifier) =>
  b64url(createHash("sha256").update(verifier).digest());

async function boot(options) {
  const clock = { at: 1_800_000_000_000 };
  const server = nativeFixture({ now: () => clock.at, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  // node:http, because fetch refuses to send some of the headers these tests need.
  const call = (method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, method, path, headers },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            })
          );
        }
      );
      req.on("error", reject);
      req.end(body);
    });
  const close = () => new Promise((done) => server.close(done));
  return { clock, origin, call, close };
}

function pkce() {
  const verifier = b64url(randomBytes(32));
  return {
    verifier,
    challenge: challengeFor(verifier),
    state: b64url(randomBytes(32)),
  };
}
const form = (fields) => new URLSearchParams(fields).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const JSON_TYPE = { "content-type": "application/json" };

/** Walks start -> consent page -> Allow, and returns the one-time code. */
async function approve(stub, { challenge, state }, ...rest) {
  const origin = rest.length ? rest[0] : stub.origin;
  const start = await stub.call(
    "GET",
    `/auth/native/start?challenge=${challenge}&state=${state}`
  );
  assert.equal(start.status, 302);
  const page = await stub.call("GET", start.headers.location);
  assert.equal(page.status, 200);
  const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)[1];
  const posted = await stub.call("POST", "/auth/native/approve", {
    headers: { ...FORM, ...(origin ? { origin } : {}) },
    body: form({ challenge, state, nonce }),
  });
  return { page, posted, nonce };
}
function codeOf(posted, state) {
  assert.equal(posted.status, 303);
  const location = new URL(posted.headers.location);
  assert.equal(
    `${location.protocol}//${location.host}${location.pathname}`,
    "prizecheck-native://auth/callback"
  );
  assert.deepEqual([...location.searchParams.keys()], ["code", "state"]);
  assert.equal(location.searchParams.get("state"), state);
  return location.searchParams.get("code");
}
const exchange = (stub, code, verifier, headers = {}) =>
  stub.call("POST", "/auth/native/token", {
    headers: { ...JSON_TYPE, ...headers },
    body: JSON.stringify({ code, verifier }),
  });
async function signIn(stub) {
  const attempt = pkce();
  const { posted } = await approve(stub, attempt);
  const response = await exchange(
    stub,
    codeOf(posted, attempt.state),
    attempt.verifier
  );
  assert.equal(response.status, 200);
  return JSON.parse(response.text);
}
const read = (stub, token, path = "/api/collection", extra = {}) =>
  stub.call(extra.method ?? "GET", path, {
    headers: { authorization: `Bearer ${token}`, ...(extra.headers ?? {}) },
  });

test("start validates parameters, then sends the signed-in collector to the consent page", async () => {
  const stub = await boot();
  try {
    const { challenge, state } = pkce();
    for (const query of [
      "",
      `?challenge=${challenge}`,
      `?challenge=${challenge}&state=short`,
      `?challenge=${challenge}&challenge=${challenge}&state=${state}`,
      `?challenge=${challenge}&state=${state}&extra=1`,
    ]) {
      const response = await stub.call("GET", `/auth/native/start${query}`);
      assert.equal(response.status, 400, query);
      assert.match(
        response.text,
        /This sign-in link isn't valid. Go back to the app and try again\./
      );
    }
    const ok = await stub.call(
      "GET",
      `/auth/native/start?challenge=${challenge}&state=${state}`
    );
    assert.equal(ok.status, 302);
    assert.equal(
      ok.headers.location,
      `/auth/native/approve?challenge=${challenge}&state=${state}`
    );
  } finally {
    await stub.close();
  }
});

test("the consent page carries the contract's text, headers, Allow form and Cancel link", async () => {
  const stub = await boot();
  try {
    const { challenge, state } = pkce();
    const page = await stub.call(
      "GET",
      `/auth/native/approve?challenge=${challenge}&state=${state}`
    );
    assert.equal(page.status, 200);
    assert.match(page.text, /Allow the app to read your Collection\?/);
    assert.match(
      page.text,
      /The app on this phone will be able to see your Collection\. It can't change anything\./
    );
    assert.match(page.text, /<button type="submit">Allow<\/button>/);
    assert.ok(
      page.text.includes(
        `href="prizecheck-native://auth/callback?error=access_denied&amp;state=${state}"`
      )
    );
    assert.equal(page.headers["cache-control"], "no-store");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(
      page.headers["content-security-policy"],
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
    );
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.doesNotMatch(page.text, /<script/);
  } finally {
    await stub.close();
  }
});

test("approving issues a code with a 303 to the callback, only for the exact Origin and a valid nonce", async () => {
  const stub = await boot();
  try {
    const attempt = pkce();
    for (const origin of [
      undefined,
      "null",
      "http://127.0.0.1:1",
      "http://evil.example",
    ]) {
      const { posted } = await approve(stub, pkce(), origin);
      assert.equal(posted.status, 403, String(origin));
      assert.doesNotMatch(posted.headers.location ?? "", /code=/);
    }
    const { page } = await approve(stub, attempt);
    const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)[1];
    // A nonce is bound to its challenge and state.
    const other = pkce();
    for (const fields of [
      { challenge: other.challenge, state: attempt.state, nonce },
      { challenge: attempt.challenge, state: other.state, nonce },
      { challenge: attempt.challenge, state: attempt.state, nonce: "x" },
      { challenge: attempt.challenge, state: attempt.state },
    ]) {
      const response = await stub.call("POST", "/auth/native/approve", {
        headers: { ...FORM, origin: stub.origin },
        body: form(fields),
      });
      assert.equal(response.status, 400);
      assert.doesNotMatch(response.headers.location ?? "", /code=/);
    }
    // A nonce lasts through the next ten-minute window, then goes stale.
    stub.clock.at += 9 * 60_000;
    const accepted = await stub.call("POST", "/auth/native/approve", {
      headers: { ...FORM, origin: stub.origin },
      body: form({ challenge: attempt.challenge, state: attempt.state, nonce }),
    });
    assert.equal(accepted.status, 303);
    stub.clock.at += 25 * 60_000;
    const stale = await stub.call("POST", "/auth/native/approve", {
      headers: { ...FORM, origin: stub.origin },
      body: form({ challenge: attempt.challenge, state: attempt.state, nonce }),
    });
    assert.equal(stale.status, 400);
    assert.equal(
      (
        await stub.call(
          "GET",
          `/auth/native/approve?challenge=${attempt.challenge}`
        )
      ).status,
      400
    );
  } finally {
    await stub.close();
  }
});

test("a code exchanges once, and a wrong verifier neither succeeds nor burns it", async () => {
  const stub = await boot();
  try {
    const attempt = pkce();
    const { posted } = await approve(stub, attempt);
    const code = codeOf(posted, attempt.state);
    const wrong = await exchange(stub, code, b64url(randomBytes(32)));
    assert.equal(wrong.status, 400);
    assert.deepEqual(JSON.parse(wrong.text), { error: "invalid_grant" });
    const [first, second] = await Promise.all([
      exchange(stub, code, attempt.verifier),
      exchange(stub, code, attempt.verifier),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 400]);
    const won = first.status === 200 ? first : second;
    const body = JSON.parse(won.text);
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(new Date(body.expires_at).toISOString(), body.expires_at);
    assert.equal(won.headers["cache-control"], "no-store");
    assert.equal(
      (await exchange(stub, code, attempt.verifier)).status,
      400,
      "a used code does not work again"
    );
  } finally {
    await stub.close();
  }
});

test("an expired code fails", async () => {
  const stub = await boot();
  try {
    const attempt = pkce();
    const { posted } = await approve(stub, attempt);
    stub.clock.at += 61_000;
    const response = await exchange(
      stub,
      codeOf(posted, attempt.state),
      attempt.verifier
    );
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.text), { error: "invalid_grant" });
  } finally {
    await stub.close();
  }
});

test("the token route refuses cookies, an Origin, malformed bodies and floods", async () => {
  const stub = await boot();
  try {
    const attempt = pkce();
    const { posted } = await approve(stub, attempt);
    const code = codeOf(posted, attempt.state);
    for (const headers of [{ cookie: "a=b" }, { origin: stub.origin }]) {
      const response = await exchange(stub, code, attempt.verifier, headers);
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.text), { error: "invalid_request" });
    }
    for (const body of [
      "not json",
      "[]",
      JSON.stringify({ code }),
      JSON.stringify({ code, verifier: "short" }),
      JSON.stringify({ code, verifier: attempt.verifier, extra: 1 }),
      JSON.stringify({ code: "x".repeat(2000), verifier: attempt.verifier }),
    ]) {
      const response = await stub.call("POST", "/auth/native/token", {
        headers: JSON_TYPE,
        body,
      });
      assert.equal(response.status, 400, body.slice(0, 20));
    }
    const form = await stub.call("POST", "/auth/native/token", {
      headers: FORM,
      body: `code=${code}`,
    });
    assert.equal(form.status, 400);
    // The refused attempts never touched the code.
    assert.equal((await exchange(stub, code, attempt.verifier)).status, 200);
    let limited = 0;
    for (let i = 0; i < 40; i += 1) {
      limited +=
        (await exchange(stub, code, attempt.verifier)).status === 429 ? 1 : 0;
    }
    assert.ok(limited > 0, "a durable per-address limit answers 429");
  } finally {
    await stub.close();
  }
});

test("the bearer reads only GET /api/collection, with two sample pages", async () => {
  const stub = await boot();
  try {
    const { token } = await signIn(stub);
    const first = await read(stub, token);
    assert.equal(first.status, 200);
    const page = JSON.parse(first.text);
    assert.deepEqual(
      page.entries.map((e) => e.printing_name),
      ["Bulbasaur", "Charmander"]
    );
    assert.equal(page.next_cursor, NATIVE_SECOND_CURSOR);
    const second = JSON.parse(
      (
        await read(
          stub,
          token,
          `/api/collection?cursor=${NATIVE_SECOND_CURSOR}`
        )
      ).text
    );
    assert.deepEqual(
      second.entries.map((e) => e.printing_name),
      ["Squirtle"]
    );
    assert.equal(second.next_cursor, null);
    assert.equal(
      (await read(stub, token, "/api/collection?cursor=nope")).status,
      400
    );

    const denied = async (response) => {
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(response.text), {
        error: "Authentication required",
      });
    };
    await denied(
      await read(stub, token, "/api/collection", { method: "POST" })
    );
    await denied(await read(stub, token, "/api/holdings"));
    await denied(await read(stub, token, "/api/collection/extra"));
    await denied(
      await read(stub, token, "/api/collection", { headers: { cookie: "a=b" } })
    );
    await denied(await read(stub, "a".repeat(42)));
    await denied(await read(stub, "a".repeat(43)));
    await denied(await stub.call("GET", "/api/collection"));
    await denied(
      await stub.call("GET", "/api/collection", {
        headers: { authorization: `Basic ${token}` },
      })
    );
    // The raw token is no web session.
    await denied(
      await stub.call("GET", "/api/collection", {
        headers: { cookie: `session=${token}` },
      })
    );
  } finally {
    await stub.close();
  }
});

test("a credential expires after its lifetime", async () => {
  const stub = await boot({ tokenLifetimeMs: 1000 });
  try {
    const { token } = await signIn(stub);
    assert.equal((await read(stub, token)).status, 200);
    stub.clock.at += 1001;
    assert.equal((await read(stub, token)).status, 401);
  } finally {
    await stub.close();
  }
});

test("sign-out revokes only that credential and always answers 204", async () => {
  const stub = await boot();
  try {
    const a = await signIn(stub);
    const b = await signIn(stub);
    const refused = await stub.call("POST", "/auth/native/sign-out", {
      headers: { authorization: `Bearer ${a.token}`, origin: stub.origin },
    });
    assert.equal(refused.status, 204);
    assert.equal(
      (await read(stub, a.token)).status,
      200,
      "an Origin voids the request"
    );
    const out = await stub.call("POST", "/auth/native/sign-out", {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(out.status, 204);
    assert.equal((await read(stub, a.token)).status, 401);
    assert.equal((await read(stub, b.token)).status, 200);
    assert.equal(
      (await stub.call("POST", "/auth/native/sign-out")).status,
      204
    );
  } finally {
    await stub.close();
  }
});

test("other routes are 404 and the listener is loopback", async () => {
  const stub = await boot();
  try {
    assert.equal((await stub.call("GET", "/auth/native/token")).status, 404);
    assert.equal((await stub.call("GET", "/")).status, 404);
    assert.match(stub.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await stub.close();
  }
});
