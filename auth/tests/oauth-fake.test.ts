import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import {
  createServer as createHttpServer,
  type RequestListener,
} from "node:http";
import { createServer as createNetServer } from "node:net";
import {
  CONSENT_PATH,
  FakeRefused,
  createFakeFetch,
  identities,
  isLoopbackOrigin,
  wrapRequestListener,
} from "../testing/oauth-fake/core.js";
import { walkSignIn, cookieHeader } from "../testing/oauth-fake/walk.js";

const PRELOAD = "./auth/testing/oauth-fake/preload.ts";
const FIXTURE = "auth/tests/support/oauth-fake-server.ts";
const CREDENTIALS = {
  GOOGLE_CLIENT_ID: "fake-google-client",
  GOOGLE_CLIENT_SECRET: "fake-google-secret",
  DISCORD_CLIENT_ID: "fake-discord-client",
  DISCORD_CLIENT_SECRET: "fake-discord-secret",
};
const OWNER = "owner@example.test";

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function launch(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn("node", ["--import", "tsx", "--import", PRELOAD, FIXTURE], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("fake provider fetch", () => {
  const passed: string[] = [];
  const real = (async (input: RequestInfo | URL) => {
    passed.push(String(input));
    return new Response("passed");
  }) as typeof fetch;
  const fake = createFakeFetch(real, { ...CREDENTIALS, OWNER_EMAIL: OWNER });
  it("matches Discord's encoded profile path after decoding it", async () => {
    const response = await fake("https://discord.com/api/users/%40me", {
      headers: { authorization: "Bearer fake-discord-access-owner" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: "100000000000000001",
      email: OWNER,
      verified: true,
    });
  });
  it("throws on any provider-host request it does not answer", async () => {
    for (const url of [
      "https://www.googleapis.com/oauth2/v3/certs",
      "https://discord.com/api/v10/users/@me",
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://cdn.discordapp.com/x.png",
    ]) {
      await expect(fake(url)).rejects.toBeInstanceOf(FakeRefused);
    }
  });
  it("passes every other host through untouched", async () => {
    expect(await (await fake("http://127.0.0.1:9/api/health")).text()).toBe(
      "passed"
    );
    expect(passed).toEqual(["http://127.0.0.1:9/api/health"]);
  });
  it("refuses a Google token request without PKCE or with the wrong client", async () => {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: "fake-owner",
      client_id: "fake-google-client",
      redirect_uri: "http://127.0.0.1/api/auth/callback/google",
    });
    expect(
      (
        await fake("https://oauth2.googleapis.com/token", {
          method: "POST",
          body,
        })
      ).status
    ).toBe(400);
    body.set("code_verifier", "v");
    body.set("client_id", "other");
    expect(
      (
        await fake("https://oauth2.googleapis.com/token", {
          method: "POST",
          body,
        })
      ).status
    ).toBe(401);
  });
});

describe("loopback guard", () => {
  it("accepts only loopback origins", () => {
    for (const origin of [
      "http://localhost:5173",
      "http://127.0.0.1:3001",
      "http://[::1]:8080",
    ])
      expect(isLoopbackOrigin(origin)).toBe(true);
    for (const origin of [
      undefined,
      "",
      "https://prizecheck.example.com",
      "http://localhost.example.com",
      "http://127.0.0.2",
      "http://app.test",
      "not a url",
    ])
      expect(isLoopbackOrigin(origin)).toBe(false);
  });
  it("stops the process before anything listens when PUBLIC_ORIGIN is not loopback, whatever NODE_ENV says", async () => {
    for (const env of [
      {
        PUBLIC_ORIGIN: "https://prizecheck.example.com",
        NODE_ENV: "development",
      },
      { PUBLIC_ORIGIN: "", NODE_ENV: "test" },
    ]) {
      const child = launch({
        ...CREDENTIALS,
        ...env,
        FIXTURE_PORT: String(await freePort()),
      });
      let output = "";
      child.stdout!.on("data", (c) => (output += c));
      child.stderr!.on("data", (c) => (output += c));
      const status = await new Promise((resolve) =>
        child.once("exit", resolve)
      );
      expect(status).not.toBe(0);
      expect(output).toContain("OAuth fake refuses to load");
      expect(output).not.toContain("READY");
    }
  });
});

describe("server wrapper", () => {
  let base = "";
  let reply: RequestListener = (_q, s) => {
    s.writeHead(404);
    s.end();
  };
  const server = createHttpServer();
  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server.on(
      "request",
      wrapRequestListener((q, s) => reply(q, s), base, { OWNER_EMAIL: OWNER })
    );
    await new Promise<void>((resolve) =>
      server.listen(port, "127.0.0.1", resolve)
    );
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  const authorize = `https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=s1&redirect_uri=${encodeURIComponent("http://127.0.0.1:1/api/auth/callback/google")}`;
  it("rewrites a redirect to a provider into a redirect to the consent page, keeping cookies", async () => {
    reply = (_q, s) => {
      s.writeHead(302, {
        location: authorize,
        "set-cookie": ["state=abc; Path=/; HttpOnly"],
      });
      s.end();
    };
    const response = await fetch(
      `${base}/auth/sign-in/google?fake_identity=owner`,
      { redirect: "manual" }
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, base);
    expect(location.pathname).toBe(CONSENT_PATH);
    expect(Object.fromEntries(location.searchParams)).toEqual({
      provider: "google",
      state: "s1",
      redirect_uri: "http://127.0.0.1:1/api/auth/callback/google",
      identity: "owner",
    });
    expect(response.headers.getSetCookie()).toEqual([
      "state=abc; Path=/; HttpOnly",
    ]);
  });
  it("rewrites a provider redirect set with setHeader too", async () => {
    reply = (_q, s) => {
      s.statusCode = 302;
      s.setHeader("Location", authorize);
      s.end();
    };
    const response = await fetch(`${base}/x`, { redirect: "manual" });
    expect(new URL(response.headers.get("location")!, base).pathname).toBe(
      CONSENT_PATH
    );
  });
  it("rewrites a provider redirect given as a raw header array", async () => {
    reply = (_q, s) => {
      s.writeHead(302, ["Location", authorize, "X-Kept", "1"]);
      s.end();
    };
    const response = await fetch(`${base}/raw`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!, base).pathname).toBe(
      CONSENT_PATH
    );
    expect(response.headers.get("x-kept")).toBe("1");
  });
  it("refuses a raw-array redirect to an unknown provider path", async () => {
    reply = (_q, s) => {
      s.writeHead(302, [
        "Location",
        "https://accounts.google.com/signin/elsewhere",
      ]);
      s.end();
    };
    const response = await fetch(`${base}/raw`, { redirect: "manual" });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });
  it("passes other responses through untouched", async () => {
    for (const [status, location] of [
      [302, "/collection"],
      [302, "http://127.0.0.1:1/signin?error=too_many_sign_ups"],
      [404, ""],
      [200, ""],
    ] as const) {
      reply = (_q, s) => {
        s.writeHead(
          status,
          location ? { location, "x-kept": "1" } : { "x-kept": "1" }
        );
        s.end("body");
      };
      const response = await fetch(`${base}/y`, { redirect: "manual" });
      expect(response.status).toBe(status);
      expect(response.headers.get("location")).toBe(location || null);
      expect(response.headers.get("x-kept")).toBe("1");
      expect(await response.text()).toBe("body");
    }
  });
  it("refuses a redirect to an unknown provider path", async () => {
    reply = (_q, s) => {
      s.writeHead(302, {
        location: "https://accounts.google.com/signin/elsewhere",
      });
      s.end();
    };
    const response = await fetch(`${base}/z`, { redirect: "manual" });
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
  });
  it("serves consent: a forward for a chosen identity, a list without one, 400 for a foreign callback", async () => {
    const query = (extra: Record<string, string>) =>
      new URLSearchParams({
        provider: "google",
        state: "s1",
        redirect_uri: `${base}/api/auth/callback/google`,
        ...extra,
      });
    const chosen = await fetch(
      `${base}${CONSENT_PATH}?${query({ identity: "owner" })}`
    );
    expect(chosen.status).toBe(200);
    expect(chosen.headers.get("x-fake-oauth-callback")).toBe(
      `${base}/api/auth/callback/google?code=fake-owner&state=s1`
    );
    const cancelled = await fetch(`${base}${CONSENT_PATH}?${query({})}`, {
      headers: { cookie: "fake_oauth_identity=cancel" },
    });
    expect(cancelled.headers.get("x-fake-oauth-callback")).toBe(
      `${base}/api/auth/callback/google?error=access_denied&state=s1`
    );
    const list = await fetch(`${base}${CONSENT_PATH}?${query({})}`);
    const html = await list.text();
    for (const name of [...Object.keys(identities(OWNER)), "cancel"])
      expect(html).toContain(`identity=${name}`);
    expect(list.headers.get("x-fake-oauth-callback")).toBeNull();
    expect(
      (
        await fetch(
          `${base}${CONSENT_PATH}?${query({ identity: "owner", redirect_uri: "https://evil.example/api/auth/callback/google" })}`
        )
      ).status
    ).toBe(400);
    expect(
      (await fetch(`${base}${CONSENT_PATH}?${query({ identity: "nobody" })}`))
        .status
    ).toBe(400);
  });
});

describe("sign-in through the preloaded fake and real Better Auth providers", () => {
  let child: ChildProcess;
  let base = "";
  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    child = launch({
      ...CREDENTIALS,
      OWNER_EMAIL: OWNER,
      PUBLIC_ORIGIN: base,
      FIXTURE_PORT: String(port),
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (c) => String(c).includes("READY") && resolve());
      child.once("exit", () => reject(new Error("fixture exited")));
    });
  });
  afterAll(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once("exit", r));
    }
  });
  async function state(jar: Map<string, string>) {
    return (
      await fetch(`${base}/fixture/state`, {
        headers: { cookie: cookieHeader(jar) },
      })
    ).json();
  }
  it("signs the owner in with Google, then links Discord and a second owner account to the same user", async () => {
    const google = await walkSignIn(base, "/auth/sign-in/google", "owner");
    expect(google.location).toBe("/done");
    expect((await state(google.jar)).user).toMatchObject({
      email: OWNER,
      emailVerified: true,
      name: "Owner Collector",
      image: "https://lh3.googleusercontent.com/a/fake-owner",
    });
    const discord = await walkSignIn(base, "/auth/sign-in/discord", "owner");
    expect(discord.location).toBe("/done");
    const second = await walkSignIn(
      base,
      "/auth/sign-in/google",
      "owner-second"
    );
    expect(second.location).toBe("/done");
    const after = await state(second.jar);
    expect(after.user.email).toBe(OWNER);
    expect(
      after.accounts
        .filter((a: { userEmail: string }) => a.userEmail === OWNER)
        .map(
          (a: { providerId: string; accountId: string }) =>
            `${a.providerId}:${a.accountId}`
        )
        .sort()
    ).toEqual([
      "discord:100000000000000001",
      "google:100000000000000000001",
      "google:100000000000000000002",
    ]);
  });
  it("resolves every other identity", async () => {
    const newcomer = await walkSignIn(
      base,
      "/auth/sign-in/discord",
      "newcomer"
    );
    expect(newcomer.location).toBe("/done");
    expect((await state(newcomer.jar)).user).toMatchObject({
      email: "newcomer@example.test",
      emailVerified: true,
      image: expect.stringMatching(
        /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/
      ),
    });
    const elsewhere = await walkSignIn(
      base,
      "/auth/sign-in/google",
      "different-email"
    );
    expect((await state(elsewhere.jar)).user).toMatchObject({
      email: "owner.elsewhere@example.test",
      emailVerified: true,
    });
    const unverified = await walkSignIn(
      base,
      "/auth/sign-in/google",
      "unverified"
    );
    expect((await state(unverified.jar)).user).toMatchObject({
      email: "unverified@example.test",
      emailVerified: false,
    });
    for (const provider of ["google", "discord"]) {
      const missing = await walkSignIn(
        base,
        `/auth/sign-in/${provider}`,
        "no-email"
      );
      expect(missing.location).toBe("/signin?error=email_not_found");
      const cancel = await walkSignIn(
        base,
        `/auth/sign-in/${provider}`,
        "cancel"
      );
      expect(cancel.location).toBe("/signin?error=access_denied");
    }
    const renamed = await walkSignIn(
      base,
      "/auth/sign-in/discord",
      "owner-renamed"
    );
    expect(renamed.location).toBe("/done");
    const moved = await walkSignIn(base, "/auth/sign-in/google", "owner-moved");
    expect(moved.location).toBe("/done");
    expect((await state(moved.jar)).user.email).toBe(OWNER);
  });
});
