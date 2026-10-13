// TEST ONLY. Starts the real gateway (auth/src/server.ts) against its own fresh, migrated database, optionally with the
// OAuth test fake preloaded, and a recording stand-in for the FastAPI service. Shared by the OAuth gateway tests.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropDatabase, waitForServer } from "./servers.js";
import type { Jar } from "../../testing/oauth-fake/walk.js";
import { cookieHeader, keepCookies } from "../../testing/oauth-fake/walk.js";

export const OWNER = "owner@example.test";
export const PLACEHOLDER_CREDENTIALS = {
  GOOGLE_CLIENT_ID: "fake-google-client",
  GOOGLE_CLIENT_SECRET: "fake-google-secret",
  DISCORD_CLIENT_ID: "fake-discord-client",
  DISCORD_CLIENT_SECRET: "fake-discord-secret",
};

export async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

export type GatewayOptions = {
  /** Load auth/testing/oauth-fake/preload.ts before the gateway (default true). */
  preload?: boolean;
  /** Extra or overriding environment; `undefined` removes a variable. */
  env?: Record<string, string | undefined>;
};

export type TestGateway = {
  /** Where the test reaches the gateway; also its PUBLIC_ORIGIN. */
  base: string;
  /** A pool on this gateway's own database. */
  pool: Pool;
  /** Paths the gateway forwarded to the FastAPI stand-in. */
  apiPaths: string[];
  mailFile: string;
  logs: () => string;
  stop: () => Promise<void>;
};

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "ignore" });
    child.on("exit", (status) =>
      status === 0 ? resolve() : reject(new Error(`${args[0]} failed`))
    );
  });
}

export async function startGateway(
  options: GatewayOptions = {}
): Promise<TestGateway> {
  const admin = new Pool({ connectionString: process.env.DATABASE_URL });
  const database = "tcg_oauth_" + randomUUID().replaceAll("-", "");
  const directory = mkdtempSync(join(tmpdir(), "tcg-oauth-"));
  const mailFile = join(directory, "mail");
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.DATABASE_URL!);
  connection.pathname = "/" + database;
  const pool = new Pool({ connectionString: connection.toString() });
  const apiPaths: string[] = [];
  const api: Server = createHttpServer((request, response) => {
    apiPaths.push(request.url || "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const apiPort = await freePort();
  await new Promise<void>((resolve) =>
    api.listen(apiPort, "127.0.0.1", resolve)
  );
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: connection.toString(),
    AUTH_PORT: String(port),
    PUBLIC_ORIGIN: base,
    API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    OWNER_EMAIL: OWNER,
    SIGNUP_MODE: "owner-only",
    MAIL_MODE: "file",
    MAIL_FILE: mailFile,
    NODE_ENV: "test",
    EMAIL_SIGN_IN: "off",
    ...PLACEHOLDER_CREDENTIALS,
  };
  for (const [key, value] of Object.entries(options.env || {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  let output = "";
  let child: ChildProcess | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child!.once("exit", resolve));
    }
    await new Promise((resolve) => api.close(resolve));
    await pool.end();
    await dropDatabase(admin, database);
    await admin.end();
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    await run(".venv/bin/python", ["scripts/migrate.py"], env);
    const preload =
      options.preload === false
        ? []
        : ["--import", "./auth/testing/oauth-fake/preload.ts"];
    child = spawn(
      "node",
      ["--import", "tsx", ...preload, "auth/src/server.ts"],
      { env, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    // waitForServer fails at once if the child exits; the catch below adds the gateway's own output.
    const ready = await waitForServer(
      [child],
      `${base}/auth/session`,
      (r) => r.ok
    );
    if (!ready) throw new Error("Gateway did not start");
    await ready.body?.cancel();
    return { base, pool, apiPaths, mailFile, logs: () => output, stop };
  } catch (error) {
    await stop();
    throw new Error(
      `${error instanceof Error ? error.message : "Gateway failed"}: ${output}`
    );
  }
}

/** Signs in with an email code, as the existing journeys do, and keeps the session cookie in `jar`. */
export async function emailCodeSignIn(
  gateway: TestGateway,
  email: string,
  jar: Jar = new Map()
): Promise<Jar> {
  const post = (path: string, body: object) =>
    fetch(gateway.base + path, {
      method: "POST",
      headers: { origin: gateway.base, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  await gateway.pool.query("DELETE FROM auth_send_event");
  if ((await post("/auth/request-code", { email })).status !== 202)
    throw new Error("Code request failed");
  const lines = readFileSync(gateway.mailFile, "utf8").trim().split("\n");
  const code = JSON.parse(lines.at(-1)!).otp as string;
  const verified = await post("/auth/verify-code", { email, code });
  if (verified.status !== 200) throw new Error("Code sign-in failed");
  keepCookies(jar, verified);
  return jar;
}

/** GET /auth/session with the jar's cookies. */
export async function sessionOf(
  gateway: TestGateway,
  jar: Jar
): Promise<{ signedIn: boolean; userId: string | null }> {
  return (
    await fetch(`${gateway.base}/auth/session`, {
      headers: { cookie: cookieHeader(jar) },
    })
  ).json();
}

/** Every account row for a user, token columns included. */
export async function accountsOf(gateway: TestGateway, userId: string) {
  return (
    await gateway.pool.query(
      `SELECT "providerId","accountId","accessToken","refreshToken","idToken",
        "accessTokenExpiresAt","refreshTokenExpiresAt","scope"
       FROM account WHERE "userId"=$1 ORDER BY "providerId","accountId"`,
      [userId]
    )
  ).rows;
}
