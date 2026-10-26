import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { dropDatabase, launch, serverReady } from "./support/servers";

// The scanner's number table and fingerprint file are binary attachments (#310, plumbing D4 and D5): the gateway must
// stream them unchanged, with no Content-Encoding and no text decoding. It runs against its own database and a scripted
// API, so what the browser receives is compared byte for byte with what the API sent.
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_scanner_gateway_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-scanner-gateway-"));
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const secret = process.env.INTERNAL_AUTH_SECRET!;
let pool: Pool;
let gateway: ChildProcess;
let api: Server;
let base = "";
let cookie = "";
let userId = "";

type Seen = {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
};
const seen: Seen[] = [];
let behaviour: (
  request: IncomingMessage,
  response: ServerResponse,
  body: string
) => void = () => undefined;

function freePort() {
  return new Promise<number>((resolve) => {
    const probe = netServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}
const hex = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const sign = (message: string) =>
  createHmac("sha256", secret).update(message).digest("hex");

async function gatewayPost(
  path: string,
  body: string,
  extra: Record<string, string> = {}
) {
  return fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": "application/json", cookie, ...extra },
    body,
  });
}

// The timeout covers serverReady's 30 s deadline plus the migration and sign-in on a loaded host.
beforeAll(async () => {
  await admin.query(`CREATE DATABASE "${database}"`);
  const connection = new URL(process.env.DATABASE_URL!);
  connection.pathname = "/" + database;
  pool = new Pool({ connectionString: connection.toString() });
  const port = await freePort();
  const apiPort = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    EMAIL_SIGN_IN: "on",
    DATABASE_URL: connection.toString(),
    AUTH_PORT: String(port),
    API_ORIGIN: `http://127.0.0.1:${apiPort}`,
    MAIL_MODE: "file",
    MAIL_FILE: join(directory, "mail"),
    SIGNUP_MODE: "local-public",
    NODE_ENV: "test",
    OWNER_EMAIL: "owner@example.test",
    PUBLIC_ORIGIN: origin,
  };
  await new Promise<void>((resolve, reject) => {
    spawn(".venv/bin/python", ["scripts/migrate.py"], {
      env,
      stdio: "ignore",
    }).on("exit", (status) =>
      status === 0 ? resolve() : reject(new Error("Migration failed"))
    );
  });
  api = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body,
      });
      behaviour(request, response, body);
    });
  });
  await new Promise<void>((resolve) =>
    api.listen(apiPort, "127.0.0.1", resolve)
  );
  gateway = launch("node", ["--import", "tsx", "auth/src/server.ts"], env);
  await serverReady([gateway], base + "/auth/session");
  const email = "scanner-reader@example.test";
  expect(
    (await gatewayPost("/auth/request-code", JSON.stringify({ email }))).status
  ).toBe(202);
  const code = JSON.parse(
    readFileSync(join(directory, "mail"), "utf8").trim().split("\n").at(-1)!
  ).otp;
  const signin = await gatewayPost(
    "/auth/verify-code",
    JSON.stringify({ email, code })
  );
  expect(signin.status).toBe(200);
  cookie = signin.headers.get("set-cookie")!.split(";")[0];
  userId = (await pool.query('SELECT id FROM "user" WHERE email=$1', [email]))
    .rows[0].id;
}, 60_000);

afterAll(async () => {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await new Promise((resolve) => gateway.once("exit", resolve));
  }
  api?.closeAllConnections();
  await new Promise((resolve) => api?.close(resolve));
  await pool?.end();
  await dropDatabase(admin, database);
  await admin.end();
  rmSync(directory, { recursive: true, force: true });
});

/** `size` bytes holding every byte value 0x00 to 0xFF in turn: NUL, invalid UTF-8, a gzip magic number and all. */
function everyByte(size: number) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 256;
  return bytes;
}

const attachment = (
  bytes: Buffer,
  filename: string
): ((request: IncomingMessage, response: ServerResponse) => void) => {
  return (_, response) => {
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-length": String(bytes.length),
    });
    response.end(bytes);
  };
};

describe("scanner binary attachments", () => {
  for (const [path, filename] of [
    ["/api/scanner/cards/0123456789abcdef", "cards.json.gz"],
    ["/api/scanner/fingerprints/" + "ab".repeat(32), "fingerprints.bin"],
  ] as const) {
    it(`passes ${path.split("/")[3]} bytes 0x00 to 0xFF through unchanged`, async () => {
      // More than one chunk, so a text decode or a buffer split would show.
      const bytes = everyByte(256 * 1024 + 7);
      bytes[0] = 0x1f;
      bytes[1] = 0x8b;
      behaviour = attachment(bytes, filename);
      seen.length = 0;
      const response = await fetch(base + path, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream"
      );
      expect(response.headers.get("content-disposition")).toBe(
        `attachment; filename="${filename}"`
      );
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      const received = Buffer.from(await response.arrayBuffer());
      expect(received.length).toBe(bytes.length);
      expect(hex(received)).toBe(hex(bytes));
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toBe(path);
      expect(seen[0].headers["x-internal-user"]).toBe(userId);
    });
  }

  it("keeps the API's error answers as JSON", async () => {
    behaviour = (_, response) => {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ detail: { code: "CARDS_NOT_CURRENT" } }));
    };
    const response = await fetch(base + "/api/scanner/cards/0123456789abcdef", {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
    expect((await response.json()).detail.code).toBe("CARDS_NOT_CURRENT");
  });
});
