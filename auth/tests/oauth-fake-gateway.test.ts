import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { CONSENT_PATH } from "../testing/oauth-fake/core.js";
import { PLACEHOLDER_CREDENTIALS } from "./support/oauth-gateway.js";
import { waitForServer } from "./support/servers.js";

// The preload must leave the real gateway's own routes alone and add only the consent page (#150 builds on this).
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
let child: ChildProcess;
let base = "";
let logs = "";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(
    "node",
    [
      "--import",
      "tsx",
      "--import",
      "./auth/testing/oauth-fake/preload.ts",
      "auth/src/server.ts",
    ],
    {
      env: {
        ...process.env,
        AUTH_PORT: String(port),
        PUBLIC_ORIGIN: origin,
        OWNER_EMAIL: "owner@example.test",
        SIGNUP_MODE: "owner-only",
        ...PLACEHOLDER_CREDENTIALS,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  child.stdout?.on("data", (chunk) => (logs += chunk));
  child.stderr?.on("data", (chunk) => (logs += chunk));
  const ready = await waitForServer(
    [child],
    `${base}/auth/session`,
    (r) => r.ok
  );
  if (!ready) throw new Error(`Gateway did not start: ${logs}`);
  await ready.body?.cancel();
});

afterAll(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});

it("serves the fake consent page from the real gateway and leaves its routes unchanged", async () => {
  const session = await fetch(`${base}/auth/session`);
  expect(session.status).toBe(200);
  expect(await session.json()).toEqual({ signedIn: false, userId: null });
  expect((await fetch(`${base}/no-such-route`)).status).toBe(404);
  expect(
    (await fetch(`${base}/auth/sign-out`, { method: "POST", body: "{}" }))
      .status
  ).toBe(403);
  const query = new URLSearchParams({
    provider: "discord",
    state: "s1",
    redirect_uri: `${origin}/api/auth/callback/discord`,
    identity: "owner",
  });
  const consent = await fetch(`${base}${CONSENT_PATH}?${query}`);
  expect(consent.status).toBe(200);
  expect(consent.headers.get("x-fake-oauth-callback")).toBe(
    `${origin}/api/auth/callback/discord?code=fake-owner&state=s1`
  );
});
