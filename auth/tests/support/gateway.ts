import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as netServer } from "node:net";
import { join } from "node:path";
import type { Pool } from "pg";
import { expect } from "vitest";

export function freePort() {
  return new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export const hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const signer = (secret: string) => (message: string) =>
  createHmac("sha256", secret).update(message).digest("hex");

export type Behaviour = (
  request: IncomingMessage,
  response: ServerResponse,
  body: string
) => void;
export type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};

/** Records text requests before invoking the test's current response script. */
export function scriptedApi(seen: Seen[], currentBehaviour: () => Behaviour) {
  return createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body,
      });
      currentBehaviour()(request, response, body);
    });
  });
}

/** Signs up through the gateway using the last code written to the fixture mail file. */
export async function signUp(
  post: (path: string, body: string) => Promise<Response>,
  email: string,
  directory: string,
  pool: Pool
) {
  expect(
    (await post("/auth/request-code", JSON.stringify({ email }))).status
  ).toBe(202);
  const code = JSON.parse(
    readFileSync(join(directory, "mail"), "utf8").trim().split("\n").at(-1)!
  ).otp;
  const signin = await post(
    "/auth/verify-code",
    JSON.stringify({ email, code })
  );
  expect(signin.status).toBe(200);
  const cookie = signin.headers.get("set-cookie")!.split(";")[0];
  const userId = (
    await pool.query('SELECT id FROM "user" WHERE email=$1', [email])
  ).rows[0].id;
  return { cookie, userId };
}

/** Reads the current cookie for each request, including requests made during sign-up. */
export function createGatewayPost(
  current: () => { base: string; origin: string; cookie: string }
) {
  return async (
    path: string,
    body: string,
    extra: Record<string, string> = {}
  ) => {
    const { base, origin, cookie } = current();
    return fetch(base + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", cookie, ...extra },
      body,
    });
  };
}
