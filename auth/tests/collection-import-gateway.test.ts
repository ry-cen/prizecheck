import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
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

// Collection Import's gateway limits (#226, spec "Gateway and proxy"): the start route alone takes a file up to 5 MiB,
// forwarded as the bytes that arrived; the changes route joins decklist import's 64 KiB; every other route keeps
// 16 KiB. The gateway runs against its own database and a scripted API that records the exact bytes it receives.
const admin = new Pool({ connectionString: process.env.DATABASE_URL });
const database = "tcg_import_gateway_" + randomUUID().replaceAll("-", "");
const directory = mkdtempSync(join(tmpdir(), "tcg-import-gateway-"));
const origin = process.env.TEST_ORIGIN || "http://localhost:5173";
const secret = process.env.INTERNAL_AUTH_SECRET!;
const FIVE_MIB = 5 * 1024 * 1024;
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
  body: Buffer;
};
const seen: Seen[] = [];

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

async function post(
  path: string,
  body: string | Buffer,
  contentType = "application/json"
) {
  return fetch(base + path, {
    method: "POST",
    headers: { origin, "content-type": contentType, cookie },
    body,
  });
}

/** `size` bytes holding every byte value in turn: NUL, invalid UTF-8 and all. */
function binary(size: number) {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 256;
  return bytes;
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
  api = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method!,
        url: request.url!,
        headers: request.headers,
        body: Buffer.concat(chunks),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) =>
    api.listen(apiPort, "127.0.0.1", resolve)
  );
  gateway = launch("node", ["--import", "tsx", "auth/src/server.ts"], env);
  await serverReady([gateway], base + "/auth/session");
  const email = "collection-importer@example.test";
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

describe("Collection Import bodies", () => {
  it("lets the start route carry a 5 MiB file with its query and content type, and refuses 5 MiB + 1 byte with 413", async () => {
    seen.length = 0;
    const file = binary(FIVE_MIB);
    const started = await post(
      "/api/collection-imports?location_id=leaf-1",
      file,
      "application/zip"
    );
    expect(started.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/api/collection-imports?location_id=leaf-1");
    expect(seen[0].headers["content-type"]).toBe("application/zip");
    expect(seen[0].body.length).toBe(FIVE_MIB);
    expect(seen[0].body.equals(file)).toBe(true);
    // Signed over the path without its query and over the bytes forwarded, as the API checks them.
    expect(seen[0].headers["x-internal-signature"]).toBe(
      sign(
        `POST\n/api/collection-imports\n${hex(file)}\n${userId}\n${seen[0].headers["x-internal-time"]}`
      )
    );
    const over = Buffer.concat([file, Buffer.from([0x0a])]);
    const refused = await post(
      "/api/collection-imports?location_id=leaf-1",
      over,
      "text/csv"
    );
    expect(refused.status).toBe(413);
    expect(seen).toHaveLength(1);
  });

  it("forwards a Windows-1252 file and bytes that aren't UTF-8 unchanged", async () => {
    seen.length = 0;
    // "Poké Ball “Promo”" in Windows-1252 (0xE9, 0x93, 0x94 aren't UTF-8 on their own), a NUL, and enough three-byte
    // UTF-8 characters that some fall across the gateway's read chunks.
    const file = Buffer.concat([
      Buffer.from(
        "Quantity,Name\r\n1,Pok\xe9 Ball \x93Promo\x94\r\n",
        "latin1"
      ),
      Buffer.from([0x00, 0xff, 0xfe]),
      Buffer.from("€".repeat(100_000), "utf8"),
    ]);
    const contentType = "text/csv; charset=windows-1252";
    const response = await post(
      "/api/collection-imports?location_id=leaf-2",
      file,
      contentType
    );
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].headers["content-type"]).toBe(contentType);
    expect(seen[0].body.equals(file)).toBe(true);
    expect(seen[0].headers["x-internal-signature"]).toBe(
      sign(
        `POST\n/api/collection-imports\n${hex(file)}\n${userId}\n${seen[0].headers["x-internal-time"]}`
      )
    );
  });

  it("gives the changes route 64 KiB and keeps every other Collection Import route at 16 KiB", async () => {
    seen.length = 0;
    const id = randomUUID();
    const wide = " ".repeat(65_536 - 2) + "{}";
    expect(
      (await post(`/api/collection-imports/${id}/changes`, wide)).status
    ).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].body.toString("utf8")).toBe(wide);
    expect(
      (await post(`/api/collection-imports/${id}/changes`, wide + " ")).status
    ).toBe(413);
    expect(seen).toHaveLength(1);
    // 16 KiB still reaches the API through the other routes, and a byte more never does (the 16 KiB reader answers
    // 503, as before).
    const narrow = " ".repeat(16_384 - 2) + "{}";
    expect(
      (await post(`/api/collection-imports/${id}/save`, narrow)).status
    ).toBe(200);
    expect(seen).toHaveLength(2);
    for (const path of [
      `/api/collection-imports/${id}/save`,
      `/api/collection-imports/${id}/changes/more`,
      `/api/collection-imports/${id}`,
      "/api/collection-imports/",
      "/api/collection-imports/current",
      "/api/locations",
    ])
      expect((await post(path, narrow + " ")).status).toBe(503);
    // nginx folds these spellings into its 5m location, but the gateway matches the literal path and keeps them at
    // 16 KiB.
    for (const path of [
      "/api//collection-imports",
      "/api/collection-%69mports",
    ])
      expect((await post(path, narrow + " ")).status).toBe(503);
    // Only POST gets the start route's 5 MiB.
    const put = await fetch(
      base + "/api/collection-imports?location_id=leaf-3",
      {
        method: "PUT",
        headers: { origin, "content-type": "text/csv", cookie },
        body: narrow + " ",
      }
    );
    expect(put.status).toBe(503);
    expect(seen).toHaveLength(2);
  });

  it("keeps decklist import's routes at 64 KiB", async () => {
    seen.length = 0;
    const exact = " ".repeat(65_536 - 2) + "{}";
    for (const path of ["/api/decks/import/review", "/api/decks/import"]) {
      expect((await post(path, exact)).status).toBe(200);
      expect((await post(path, exact + " ")).status).toBe(413);
    }
    expect(seen).toHaveLength(2);
  });

  it("requires a session before reading a file", async () => {
    seen.length = 0;
    const response = await fetch(
      base + "/api/collection-imports?location_id=x",
      {
        method: "POST",
        headers: { origin, "content-type": "text/csv" },
        body: "Quantity,Name\n1,Starmie\n",
      }
    );
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});
