import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nativeFixture, NATIVE_SECOND_CURSOR } from "./native-fixture.mjs";

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");
const challengeFor = (verifier) =>
  b64url(createHash("sha256").update(verifier).digest());

// node:http, because fetch refuses to send some of the headers these tests need.
const makeCall =
  (port) =>
  (method, path, { headers = {}, body } = {}) =>
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

async function boot(options) {
  const clock = { at: 1_800_000_000_000 };
  const server = nativeFixture({ now: () => clock.at, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const call = makeCall(port);
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
    assert.equal(page.headers["referrer-policy"], "same-origin");
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.equal(
      page.headers["content-security-policy"],
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' prizecheck-native:; base-uri 'none'; frame-ancestors 'none'"
    );
    assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
    assert.doesNotMatch(page.text, /<script/);
  } finally {
    await stub.close();
  }
});

test("approving with Origin: null is still refused with a 403 and no code", async () => {
  const stub = await boot();
  try {
    const { posted } = await approve(stub, pkce(), "null");
    assert.equal(posted.status, 403);
    assert.doesNotMatch(posted.headers.location ?? "", /code=/);
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
      // A well-formed request with a nonce that does not verify is 403; a missing nonce is a malformed request, 400.
      assert.equal(response.status, "nonce" in fields ? 403 : 400);
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
    assert.equal(stale.status, 403);
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
    let limitedResponse;
    for (let i = 0; i < 40 && !limitedResponse; i += 1) {
      const next = await exchange(stub, code, attempt.verifier);
      if (next.status === 429) limitedResponse = next;
    }
    assert.ok(limitedResponse, "a durable per-address limit answers 429");
    assert.deepEqual(JSON.parse(limitedResponse.text), {
      error: "too_many_requests",
    });
    assert.equal(limitedResponse.headers["retry-after"], "3600");
    // Validation comes before the limit: a malformed body is still 400 once the address is limited.
    const malformed = await stub.call("POST", "/auth/native/token", {
      headers: JSON_TYPE,
      body: "not json",
    });
    assert.equal(malformed.status, 400);
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

test("sign-out revokes only that credential, answers 204 for a revoked or unknown one, and 400 for a shape that names none", async () => {
  const stub = await boot();
  try {
    const a = await signIn(stub);
    const b = await signIn(stub);
    const refused = await stub.call("POST", "/auth/native/sign-out", {
      headers: { authorization: `Bearer ${a.token}`, origin: stub.origin },
    });
    assert.equal(refused.status, 400);
    assert.deepEqual(JSON.parse(refused.text), { error: "invalid_request" });
    assert.equal(
      (await read(stub, a.token)).status,
      200,
      "an Origin voids the request"
    );
    const cookie = await stub.call("POST", "/auth/native/sign-out", {
      headers: { authorization: `Bearer ${a.token}`, cookie: "a=b" },
    });
    assert.equal(cookie.status, 400);
    const out = await stub.call("POST", "/auth/native/sign-out", {
      headers: { authorization: `Bearer ${a.token}` },
    });
    assert.equal(out.status, 204);
    assert.equal((await read(stub, a.token)).status, 401);
    assert.equal((await read(stub, b.token)).status, 200);
    // Again, and a token nobody issued: not usable, so 204.
    for (const token of [a.token, b64url(randomBytes(32))])
      assert.equal(
        (
          await stub.call("POST", "/auth/native/sign-out", {
            headers: { authorization: `Bearer ${token}` },
          })
        ).status,
        204
      );
    assert.equal((await read(stub, b.token)).status, 200);
    // No header, a malformed one: 400.
    assert.equal(
      (await stub.call("POST", "/auth/native/sign-out")).status,
      400
    );
    assert.equal(
      (
        await stub.call("POST", "/auth/native/sign-out", {
          headers: { authorization: "Bearer junk" },
        })
      ).status,
      400
    );
  } finally {
    await stub.close();
  }
});

test("an injected sign-out failure answers 503, keeps the credential, and a later retry revokes it", async () => {
  const stub = await boot();
  try {
    const a = await signIn(stub);
    const b = await signIn(stub);
    const state = async (method = "GET", path = "/fixture/state") =>
      JSON.parse((await stub.call(method, path)).text);
    assert.deepEqual(await state(), { live: 2, refused: 0, confirmed: 0 });
    assert.deepEqual(await state("POST", "/fixture/sign-out/fail"), {
      live: 2,
      refused: 0,
      confirmed: 0,
    });
    const signOut = (token) =>
      stub.call("POST", "/auth/native/sign-out", {
        headers: { authorization: `Bearer ${token}` },
      });
    assert.equal((await signOut(a.token)).status, 503);
    assert.equal((await signOut(b.token)).status, 503);
    // A bad shape is still 400 while the fault is on, and counts nothing.
    assert.equal(
      (await stub.call("POST", "/auth/native/sign-out")).status,
      400
    );
    assert.equal((await read(stub, a.token)).status, 200);
    assert.deepEqual(await state(), { live: 2, refused: 2, confirmed: 0 });
    await state("POST", "/fixture/sign-out/ok");
    assert.equal((await signOut(a.token)).status, 204);
    assert.equal((await read(stub, a.token)).status, 401);
    assert.deepEqual(await state(), { live: 1, refused: 2, confirmed: 1 });
    // A second retry of the same token is 204 and leaves `confirmed` alone.
    assert.equal((await signOut(a.token)).status, 204);
    assert.deepEqual(await state(), { live: 1, refused: 2, confirmed: 1 });
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

test("approve validates before it rate limits, limits after 20 valid requests, and caps the body at 2048 bytes", async () => {
  const stub = await boot();
  try {
    const attempt = pkce();
    const { page } = await approve(stub, attempt);
    const nonce = /name="nonce" value="([^"]+)"/.exec(page.text)[1];
    const good = {
      challenge: attempt.challenge,
      state: attempt.state,
      nonce,
    };
    const post = (body) =>
      stub.call("POST", "/auth/native/approve", {
        headers: { ...FORM, origin: stub.origin },
        body,
      });
    assert.equal(
      (await post(form(good) + "&pad=" + "a".repeat(2100))).status,
      400
    );
    let last;
    for (let i = 0; i < 25; i += 1) last = await post(form(good));
    assert.equal(last.status, 429);
    assert.equal(
      (await post(form({ ...good, nonce: "x" }))).status,
      403,
      "an invalid request is refused as itself, not as a flood"
    );
  } finally {
    await stub.close();
  }
});

test("the stub's stdout carries only allowlisted route lines, never a request value", async () => {
  // A child process, so its stdout is exactly the stub's and nothing else.
  const moduleUrl = new URL("./native-fixture.mjs", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { nativeFixture, stdoutLog } from ${JSON.stringify(moduleUrl)};
       const server = nativeFixture({ log: stdoutLog });
       server.listen(0, "127.0.0.1", () => process.stderr.write("port=" + server.address().port + "\\n"));`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: fileURLToPath(new URL(".", import.meta.url)),
    }
  );
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  try {
    const port = await new Promise((resolve, reject) => {
      let err = "";
      child.stderr.on("data", (chunk) => {
        err += chunk;
        const match = /port=(\d+)/.exec(err);
        if (match) resolve(Number(match[1]));
      });
      child.on("exit", () => reject(new Error("stub exited early")));
    });
    const stub = { origin: `http://127.0.0.1:${port}`, call: makeCall(port) };
    const secrets = {
      verifier: "V".repeat(43),
      challenge: challengeFor("V".repeat(43)),
      state: "S".repeat(43),
      code: "C".repeat(43),
      token: "T".repeat(43),
      cursor: "cursor-SECRETVALUE",
      extra: "extra-SECRETVALUE",
    };
    // A full flow with a known challenge and state (the real code and token are random).
    const attempt = {
      verifier: secrets.verifier,
      challenge: secrets.challenge,
      state: secrets.state,
    };
    const { posted } = await approve(stub, attempt);
    const code = codeOf(posted, attempt.state);
    secrets.code = code;
    const exchanged = await exchange(stub, code, attempt.verifier);
    assert.equal(exchanged.status, 200);
    const { token } = JSON.parse(exchanged.text);
    secrets.token = token;
    assert.equal((await read(stub, token)).status, 200);
    assert.equal(
      (
        await read(
          stub,
          token,
          `/api/collection?cursor=${NATIVE_SECOND_CURSOR}`
        )
      ).status,
      200
    );
    assert.equal(
      (
        await stub.call("POST", "/auth/native/sign-out", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
      204
    );
    await stub.call("GET", "/fixture/state");
    // Malformed and unknown requests.
    const odd = "/odd-path-SECRETVALUE/" + "x".repeat(3000);
    await stub.call("GET", odd);
    await stub.call("PUT", odd);
    await stub.call("DELETE", "/auth/native/token");
    await stub.call(
      "GET",
      `/auth/native/start?challenge=${secrets.challenge}&state=${secrets.state}&extra=${secrets.extra}`
    );
    await stub.call("POST", "/auth/native/token", {
      headers: JSON_TYPE,
      body: JSON.stringify({
        code: secrets.code,
        verifier: secrets.verifier,
        extra: secrets.extra,
      }),
    });
    await stub.call(
      "GET",
      `/api/collection?cursor=${secrets.cursor}&extra=${secrets.extra}`,
      {
        headers: { authorization: `Bearer ${secrets.token}` },
      }
    );
    await stub.call("GET", `/api/other?extra=${secrets.extra}`);
    await stub.call("POST", "/auth/native/approve", {
      headers: { ...FORM, origin: stub.origin },
      body: form({
        challenge: secrets.challenge,
        state: secrets.state,
        nonce: "bad",
        extra: secrets.extra,
      }),
    });
    // Let the last response's finish event write its line.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const lines = out.split("\n").filter((line) => line !== "");
    assert.ok(lines.length >= 14, `expected route lines, got ${lines.length}`);
    const allowed =
      /^native-fixture route=(start|approve_get|approve_post|token|collection|sign_out|fixture|other) method=(GET|POST|OTHER) status=\d{3}$/;
    for (const line of lines) assert.match(line, allowed);
    assert.ok(lines.some((line) => line.includes("route=other method=OTHER")));
    for (const label of [
      "start",
      "approve_get",
      "approve_post",
      "token",
      "collection",
      "sign_out",
      "fixture",
    ])
      assert.ok(
        lines.some((line) => line.includes(`route=${label} `)),
        label
      );
    for (const value of [
      ...Object.values(secrets),
      "SECRETVALUE",
      "?",
      "/auth",
      "/api",
      "odd-path",
      "Bearer",
    ])
      assert.ok(
        !out.includes(value),
        `output must not contain ${value.slice(0, 12)}`
      );
  } finally {
    child.kill();
    await once(child, "exit");
  }
});
