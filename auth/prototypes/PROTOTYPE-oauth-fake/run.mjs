// PROTOTYPE — throwaway. Answers ticket 134: can local dev and CI sign in through the REAL Better Auth
// google() and discord() providers with (1) the provider's server-side calls faked in-process and
// (2) the browser's trip to accounts.google.com / discord.com faked with Playwright context.route?
// In-memory database, no gateway, no Postgres. Run: node auth/prototypes/PROTOTYPE-oauth-fake/run.mjs
import { createServer } from "node:http";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { chromium } from "playwright";

const PORT = 4917;
const ORIGIN = `http://localhost:${PORT}`;

// Test identities, chosen by the fake `code` the fake consent page returns.
const IDENTITIES = {
  owner: { sub: "100000000000000000001", email: "owner@example.test", verified: true, name: "Owner Person" },
  newbie: { sub: "100000000000000000002", email: "new@example.test", verified: true, name: "New Collector" },
  unverified: { sub: "100000000000000000003", email: "unverified@example.test", verified: false, name: "Unverified" },
};

// (1) Server-side fake: intercept only the provider hosts, pass everything else through.
const realFetch = globalThis.fetch;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const calls = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const rawBody = input instanceof Request ? await input.clone().text() : init?.body;
  const body = rawBody ? new URLSearchParams(String(rawBody)) : null;
  const who = () => IDENTITIES[(body?.get("code") || "").replace("fake-", "")];
  if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
    calls.push(`google token (code=${body.get("code")}, code_verifier ${body.get("code_verifier") ? "present" : "MISSING"})`);
    const id = who();
    // Unsigned ID token: Better Auth decodes it without verifying the signature on the callback path.
    const idToken = `${b64({ alg: "none" })}.${b64({ iss: "https://accounts.google.com", aud: "fake-google-client", sub: id.sub, email: id.email, email_verified: id.verified, name: id.name, picture: "https://lh3.googleusercontent.com/fake" })}.sig`;
    return Response.json({ access_token: "g-at", id_token: idToken, expires_in: 3600, token_type: "Bearer", scope: "openid email profile" });
  }
  if (url.host === "discord.com" && url.pathname === "/api/oauth2/token") {
    calls.push(`discord token (code=${body.get("code")})`);
    return Response.json({ access_token: `d-at-${body.get("code")}`, refresh_token: "d-rt", expires_in: 604800, token_type: "Bearer", scope: "identify email" });
  }
  if (url.host === "discord.com" && decodeURIComponent(url.pathname) === "/api/users/@me") {
    const auth_ = input instanceof Request ? input.headers.get("authorization") : new Headers(init?.headers).get("authorization");
    const code = String(auth_).replace("Bearer d-at-fake-", "");
    calls.push(`discord profile (${code})`);
    const id = IDENTITIES[code];
    return Response.json({ id: id.sub, username: id.name.toLowerCase().replace(/ /g, ""), global_name: id.name, avatar: null, email: id.email, verified: id.verified, discriminator: "0" });
  }
  // Finding from run 4: unmatched provider-host calls must fail closed, never reach the real provider.
  if (/(^|\.)(google\.com|googleapis\.com|discord\.com)$/.test(url.host)) throw new Error(`PROTOTYPE fake refused ${url.href}`);
  calls.push(`passthrough ${url.href}`);
  return realFetch(input, init);
};

const db = { user: [], session: [], account: [], verification: [] };
const auth = betterAuth({
  database: memoryAdapter(db),
  secret: "prototype-secret-prototype-secret-0123456789",
  baseURL: ORIGIN,
  basePath: "/api/auth",
  trustedOrigins: [ORIGIN],
  socialProviders: {
    google: { clientId: "fake-google-client", clientSecret: "x" },
    discord: { clientId: "fake-discord-client", clientSecret: "x" },
  },
  user: {
    // The gate from the gates decision: refuse unverified provider emails before any row exists.
    validateUserInfo: async ({ user, source }) => {
      if (source?.method === "oauth" && user.emailVerified !== true) return { error: "email_not_verified" };
    },
  },
});

// Stand-in for the gateway's two routes from the gateway decision.
const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const start = url.pathname.match(/^\/auth\/sign-in\/([a-z]+)$/);
  if (start) {
    const r = await auth.api.signInSocial({ body: { provider: start[1], callbackURL: "/done", errorCallbackURL: "/signin" }, asResponse: true });
    const { url: to } = await r.json();
    res.writeHead(302, { location: to, "set-cookie": r.headers.getSetCookie() });
    return res.end();
  }
  if (url.pathname.startsWith("/api/auth/callback/")) {
    const r = await auth.handler(new Request(ORIGIN + req.url, { headers: { cookie: req.headers.cookie || "" } }));
    res.writeHead(r.status, { location: r.headers.get("location") || "", "set-cookie": r.headers.getSetCookie() });
    return res.end();
  }
  if (url.pathname === "/done" || url.pathname === "/signin") {
    const s = await auth.api.getSession({ headers: new Headers({ cookie: req.headers.cookie || "" }) });
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ page: url.pathname, error: url.searchParams.get("error"), user: s?.user ?? null }));
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// (2) Browser-side fake: answer the provider's consent page with a redirect carrying a fake code.
const browser = await chromium.launch();
async function signIn(provider, identity) {
  const context = await browser.newContext();
  const seen = [];
  // Finding from run 1: Playwright routes only the FIRST request of a redirect chain, so a route on
  // accounts.google.com never fires for our 302. Route our own start URL instead, fetch it without
  // following redirects, and answer the provider hop ourselves.
  await context.route(`${ORIGIN}/auth/sign-in/**`, async (route) => {
    const r = await route.fetch({ maxRedirects: 0 });
    const u = new URL(r.headers()["location"]);
    seen.push(u.host + u.pathname);
    const back = new URL(u.searchParams.get("redirect_uri"));
    back.searchParams.set("code", `fake-${identity}`);
    back.searchParams.set("state", u.searchParams.get("state"));
    const cookies = r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
    // Finding from run 2: Chromium doesn't follow a 302 that route.fulfill returns for a navigation, so
    // serve a tiny fake consent page that forwards to the callback instead.
    return route.fulfill({ status: 200, headers: [{ name: "content-type", value: "text/html" }, ...cookies],
      body: `<p>PROTOTYPE fake consent for ${identity}</p><script>location.replace(${JSON.stringify(back.toString())})</script>` });
  });
  // Belt and braces: never let a test reach a real provider page.
  await context.route(/^https:\/\/(accounts\.google\.com|discord\.com)\//, (route) => route.abort());
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/auth/sign-in/${provider}`);
  await page.waitForURL(/\/(done|signin)/);
  const text = await page.locator("body").innerText(); if (!text.trim().startsWith("{")) { console.log("DEBUG url", page.url(), "seen", seen, "calls", calls, "text", text.slice(0,200)); }
  const result = JSON.parse(text);
  await context.close();
  return { provider, identity, interceptedConsent: seen, landed: result.page, error: result.error, user: result.user && { email: result.user.email, name: result.user.name, emailVerified: result.user.emailVerified } };
}

for (const [p, i] of [["google", "owner"], ["discord", "owner"], ["discord", "newbie"], ["google", "unverified"]]) {
  console.log(JSON.stringify(await signIn(p, i)));
}
console.log("users:", db.user.map((u) => u.email), "accounts:", db.account.map((a) => `${a.providerId}:${a.accountId}`));
console.log("provider calls:", calls);
await browser.close();
server.close();
