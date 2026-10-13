import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { walkSignIn } from "../testing/oauth-fake/walk.js";
import {
  PLACEHOLDER_CREDENTIALS,
  freePort,
  startGateway,
  type TestGateway,
} from "./support/oauth-gateway.js";

describe("OAuth routes without the fake (the real redirect to the provider)", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway({ preload: false });
  }, 60_000);
  afterAll(() => gateway?.stop(), 30_000);

  it("lists the configured providers and the email switch, the same for everyone", async () => {
    const anonymous = await fetch(`${gateway.base}/auth/methods`);
    expect(anonymous.status).toBe(200);
    const body = await anonymous.json();
    expect(body).toEqual({
      providers: [
        { id: "google", name: "Google" },
        { id: "discord", name: "Discord" },
      ],
      emailSignIn: false,
    });
    const withCookie = await fetch(`${gateway.base}/auth/methods`, {
      headers: { cookie: "better-auth.session_token=forged" },
    });
    expect(await withCookie.json()).toEqual(body);
  });

  it("starts Google sign-in with a 302 to Google, PKCE and the state cookie", async () => {
    const response = await fetch(`${gateway.base}/auth/sign-in/google`, {
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const to = new URL(response.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(to.searchParams.get("client_id")).toBe("fake-google-client");
    expect(to.searchParams.get("redirect_uri")).toBe(
      `${gateway.base}/api/auth/callback/google`
    );
    expect(to.searchParams.get("code_challenge")).toBeTruthy();
    expect(to.searchParams.get("state")).toBeTruthy();
    expect(to.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "openid",
      "profile",
    ]);
    expect(to.searchParams.get("access_type")).toBeNull();
    expect(response.headers.getSetCookie().join("\n")).toMatch(
      /better-auth\.state=/
    );
  });

  it("starts Discord sign-in with a 302 to Discord, even with a browser cookie and no Origin", async () => {
    const response = await fetch(`${gateway.base}/auth/sign-in/discord`, {
      redirect: "manual",
      headers: { cookie: "better-auth.session_token=stale" },
    });
    expect(response.status).toBe(302);
    const to = new URL(response.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe(
      "https://discord.com/api/oauth2/authorize"
    );
    expect(to.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "email",
      "identify",
    ]);
    expect(to.searchParams.get("prompt")).toBe("none");
  });

  it("returns 404 for an unknown provider on the start and callback routes", async () => {
    for (const path of [
      "/auth/sign-in/github",
      "/auth/sign-in/",
      "/auth/sign-in/google/extra",
      "/api/auth/callback/github?code=x&state=y",
      "/api/auth/callback/Google?code=x&state=y",
    ]) {
      const response = await fetch(gateway.base + path, { redirect: "manual" });
      expect(response.status, path).toBe(404);
    }
    expect(gateway.apiPaths).toEqual([]);
  });

  it("returns 404 for every other /api/auth path and never forwards it to the API", async () => {
    for (const [method, path] of [
      ["GET", "/api/auth"],
      ["GET", "/api/auth/ok"],
      ["GET", "/api/auth/error"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/sign-in/email-otp"],
      ["POST", "/api/auth/email-otp/send-verification-otp"],
      ["GET", "/api/auth/list-accounts"],
      ["POST", "/api/auth/link-social"],
      ["POST", "/api/auth/unlink-account"],
      ["POST", "/api/auth/callback/google"],
    ]) {
      const response = await fetch(gateway.base + path, {
        method,
        redirect: "manual",
        headers: { origin: gateway.base, "content-type": "application/json" },
        body: method === "POST" ? "{}" : undefined,
      });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(gateway.apiPaths).toEqual([]);
    expect((await fetch(`${gateway.base}/api/health`)).status).toBe(200);
    expect(gateway.apiPaths).toEqual(["/api/health"]);
  });
});

describe("OAuth routes through the fake", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startGateway();
  }, 60_000);
  afterAll(() => gateway?.stop(), 30_000);

  it("relays the callback's Location and session cookie, with the query string intact", async () => {
    const walk = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "owner"
    );
    expect(walk.callback?.status).toBe(302);
    expect(walk.location).toBe("/collection");
    const cookies = walk.callback!.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/better-auth\.session_token=/);
    expect(cookies).toMatch(/HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Lax/i);
    expect(walk.callback!.headers.get("cache-control")).toBe("no-store");
  });

  it("lands on a safe next path and falls back to /collection otherwise", async () => {
    const cases: [string, string][] = [
      ["/decks", "/decks"],
      ["/collection?set=base#top", "/collection?set=base#top"],
      ["//evil.example/x", "/collection"],
      ["/.//evil.example", "/collection"],
      ["/\\evil.example", "/collection"],
      ["https://evil.example/x", "/collection"],
      ["/api/locations", "/collection"],
      ["/auth/session", "/collection"],
      ["decks", "/collection"],
    ];
    for (const [next, landing] of cases) {
      const walk = await walkSignIn(
        gateway.base,
        `/auth/sign-in/discord?next=${encodeURIComponent(next)}`,
        "owner"
      );
      expect(walk.location, next).toBe(landing);
    }
  });

  it("sends a cancelled consent back to the sign-in page with access_denied", async () => {
    const walk = await walkSignIn(
      gateway.base,
      "/auth/sign-in/google",
      "cancel"
    );
    expect(walk.location).toBe("/sign-in?provider=google&error=access_denied");
  });
});

it("refuses to start with a half-configured provider", async () => {
  for (const missing of ["GOOGLE_CLIENT_SECRET", "DISCORD_CLIENT_ID"]) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...PLACEHOLDER_CREDENTIALS,
      OWNER_EMAIL: "owner@example.test",
      SIGNUP_MODE: "owner-only",
      AUTH_PORT: String(await freePort()),
    };
    delete env[missing];
    const child = spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => (errors += chunk));
    const status = await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(() => resolve("running"), 10_000)),
    ]);
    if (status === "running") child.kill();
    expect(status, missing).toBe(1);
    expect(errors).toMatch(
      /_CLIENT_ID and .*_CLIENT_SECRET must be set together/
    );
  }
}, 30_000);
