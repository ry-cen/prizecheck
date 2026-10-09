import { describe, it, expect } from "vitest";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { PublicReadLimiter } from "../src/publicReads.js";

describe("public read abuse boundary", () => {
  it("limits one caller, preserves other callers, and expires the window", () => {
    const limiter = new PublicReadLimiter(2, 2);
    expect(limiter.take("192.0.2.1", 0)).toBe(true);
    expect(limiter.take("192.0.2.1", 0)).toBe(true);
    expect(limiter.take("192.0.2.1", 1)).toBe(false);
    expect(limiter.take("192.0.2.2", 1)).toBe(true);
    expect(limiter.take("192.0.2.3", 1)).toBe(false);
    expect(limiter.take("192.0.2.1", 60_000)).toBe(true);
    expect(limiter.retryAfter(60_001)).toBe(60);
  });
});

describe("public catalog records rebuild", () => {
  it("restores lost records from PostgreSQL without touching discovery or waking a database for anonymous reads", async () => {
    const database = new Pool({ connectionString: process.env.DATABASE_URL });
    // A counting listener stands in for PostgreSQL behind the anonymous read path: every connection is a wakeup.
    let wakeups = 0;
    const counter: Server = createServer((socket) => {
      wakeups++;
      socket.destroy();
    });
    const listen = (server: Server) =>
      new Promise<number>((resolve) =>
        server.listen(0, "127.0.0.1", () =>
          resolve((server.address() as { port: number }).port)
        )
      );
    const freePort = async () => {
      const probe = createServer();
      const port = await listen(probe);
      await new Promise((resolve) => probe.close(resolve));
      return port;
    };
    const directory = mkdtempSync(join(tmpdir(), "public-catalog-rebuild-"));
    const records = join(directory, "records");
    const children: ChildProcess[] = [];
    const created = { identity: "", printing: "", edition: "" };
    const python = (script: string, extra: Record<string, string> = {}) =>
      spawnSync(".venv/bin/python", [script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PUBLIC_PROJECTION_DIR: directory,
          PUBLIC_PROJECTION_ADAPTER: "filesystem",
          ...extra,
        },
        encoding: "utf8",
      });
    const readRecords = (printingRef: string, editionRef: string) =>
      JSON.parse(
        execFileSync(
          ".venv/bin/python",
          [
            "-c",
            `import json, time
from app.public_projection import public_record_store
from app.public_records import catalog_edition_key, catalog_printing_key, quarantine_key
keys = [catalog_printing_key('${printingRef}'), catalog_edition_key('${editionRef}'), quarantine_key('${editionRef}')]
rows = public_record_store().read_records(keys, deadline=time.monotonic() + 5).records
print(json.dumps([rows[k].value for k in keys]))`,
          ],
          {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PUBLIC_PROJECTION_DIR: directory,
              PUBLIC_PROJECTION_ADAPTER: "filesystem",
              PYTHONPATH: "api",
            },
            encoding: "utf8",
          }
        )
      );
    try {
      // A manual Printing and Edition, seeded with SQL: triggers give them reviewed-state rows and enqueue them.
      created.identity = (
        await database.query(
          "INSERT INTO catalog_identity(identity_key,display_name) VALUES ($1,'Gateway Rebuild Card') RETURNING id",
          [`gateway-rebuild-${Date.now()}`]
        )
      ).rows[0].id;
      const printing = (
        await database.query(
          "INSERT INTO catalog_printing(source,identity_id) VALUES ('manual',$1) RETURNING id,public_ref",
          [created.identity]
        )
      ).rows[0];
      created.printing = printing.id;
      await database.query(
        "INSERT INTO catalog_printing_display(printing_id,display_name,set_id,set_name,collector_number) VALUES ($1,'Gateway Rebuild Card','gw','Gateway Set','7')",
        [printing.id]
      );
      const edition = (
        await database.query(
          `INSERT INTO catalog_edition(printing_id,descriptor_key,descriptor) VALUES ($1,'normal','{"finish":"normal"}') RETURNING id,public_ref`,
          [printing.id]
        )
      ).rows[0];
      created.edition = edition.id;

      // Published Deck projection with enough Listed decks for a real discovery cursor.
      const snapshot = {
        title: "Rebuild boundary deck",
        published_at: "2026-01-02T03:04:05Z",
        version: 1,
        total: "3",
        identities: [
          {
            name: "Pikachu",
            quantity: "3",
            editions: [
              {
                set_id: "base",
                set_name: "Base Set",
                collector_number: "25",
                variant: { label: "Unspecified Variant" },
                image_url: null,
                quantity: "3",
                edition_ref: "a".repeat(48),
                printing_ref: "b".repeat(48),
              },
            ],
          },
        ],
        checks: {
          size_status: "short",
          shortage: "57",
          excess: "0",
          identities: [
            { name: "Pikachu", quantity: "3", status: "within_limit" },
          ],
        },
      };
      const token = "R".repeat(32);
      const listed = Object.fromEntries(
        Array.from({ length: 31 }, (_, index) => [
          `M${String(index).padStart(31, "0")}`,
          {
            visibility: "listed",
            snapshot: {
              ...snapshot,
              title: `Listed ${index}`,
              published_at: `2026-02-01T00:00:${String(index).padStart(2, "0")}Z`,
            },
          },
        ])
      );
      const projection = join(directory, "current.json");
      writeFileSync(
        projection,
        JSON.stringify({
          format: 1,
          revision: 0,
          decks: { [token]: { visibility: "unlisted", snapshot }, ...listed },
        })
      );

      // The anonymous read path points at the counting listener, never at PostgreSQL.
      const databasePort = await listen(counter);
      const apiPort = await freePort();
      const gatewayPort = await freePort();
      const isolated = {
        ...process.env,
        DATABASE_URL: `postgresql://nobody:nobody@127.0.0.1:${databasePort}/none`,
        PUBLIC_PROJECTION_DIR: directory,
        PUBLIC_PROJECTION_ADAPTER: "filesystem",
      };
      children.push(
        spawn(
          ".venv/bin/uvicorn",
          [
            "app.main:app",
            "--app-dir",
            "api",
            "--host",
            "127.0.0.1",
            "--port",
            String(apiPort),
            "--no-access-log",
          ],
          { cwd: process.cwd(), env: isolated, stdio: "ignore" }
        ),
        spawn("node", ["--import", "tsx", "auth/src/server.ts"], {
          cwd: process.cwd(),
          env: {
            ...isolated,
            AUTH_PORT: String(gatewayPort),
            API_ORIGIN: `http://127.0.0.1:${apiPort}`,
          },
          stdio: "ignore",
        })
      );
      const gateway = `http://127.0.0.1:${gatewayPort}`;
      let ready = false;
      for (let attempt = 0; attempt < 100 && !ready; attempt++) {
        try {
          ready =
            (await fetch(gateway + "/api/public/discovery")).status === 200;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(ready).toBe(true);
      const read = (path: string) => fetch(gateway + path);

      // Create the records store and publish: the values reflect reviewed state, not a bare allowlist copy.
      expect(python("scripts/init_public_records.py").status).toBe(0);
      const first = python("scripts/backfill_public_catalog.py");
      expect(first.status).toBe(0);
      const published = readRecords(printing.public_ref, edition.public_ref);
      expect(Object.keys(published[0]).sort()).toEqual([
        "collector_number",
        "image_url",
        "live",
        "name",
        "printing_ref",
        "revision",
        "set_id",
        "set_name",
      ]);
      expect(published[0].live).toMatchObject({
        state: "unsupported",
        identity: null,
      });
      expect(Object.keys(published[1]).sort()).toEqual([
        "descriptor",
        "edition_ref",
        "marketplace",
        "printing_ref",
        "revision",
      ]);
      expect(published[1].marketplace).toMatchObject({
        state: "unverified",
        product_id: null,
        quote_lookup: null,
      });
      expect(published[2]).toMatchObject({
        edition_ref: edition.public_ref,
        state: "clear",
      });

      const baseline = wakeups;
      const before = {
        projection: readFileSync(projection, "utf8"),
        deck: await (await read(`/api/public/decks/${token}`)).text(),
        page: await (await read("/api/public/discovery")).json(),
      };
      expect(before.page.decks).toHaveLength(30);
      expect(before.page.next_cursor).toBeTruthy();

      // Durable loss of the records directory: the rebuild refuses to invent a store.
      renameSync(records, records + ".away");
      const refused = python("scripts/backfill_public_catalog.py");
      expect(refused.status).toBe(1);
      expect(refused.stderr).not.toContain("Traceback");
      expect(existsSync(records)).toBe(false);
      // Deck and discovery reads do not depend on the records store.
      expect((await read(`/api/public/decks/${token}`)).status).toBe(200);

      // Recovery: initialize an empty store, rebuild from PostgreSQL, values return.
      expect(python("scripts/init_public_records.py").status).toBe(0);
      const rebuilt = python("scripts/backfill_public_catalog.py");
      expect(rebuilt.status).toBe(0);
      expect(rebuilt.stdout).toContain("rebuilt");
      expect(readRecords(printing.public_ref, edition.public_ref)).toEqual(
        published
      );

      // Nothing about Published Decks or discovery moved, and no anonymous read woke a database.
      expect(readFileSync(projection, "utf8")).toBe(before.projection);
      expect(await (await read(`/api/public/decks/${token}`)).text()).toBe(
        before.deck
      );
      const after = await (await read("/api/public/discovery")).json();
      expect(after.revision).toBe(before.page.revision);
      expect(after).toEqual(before.page);
      const next = await read(
        `/api/public/discovery?cursor=${encodeURIComponent(before.page.next_cursor)}`
      );
      expect(next.status).toBe(200);
      expect((await next.json()).decks).toHaveLength(1);
      expect(wakeups).toBe(baseline);
      // Control: a private route does wake the database, so the counter is live.
      await fetch(`http://127.0.0.1:${apiPort}/api/locations`);
      expect(wakeups).toBeGreaterThan(baseline);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
      await new Promise((resolve) => counter.close(resolve));
      rmSync(directory, { recursive: true, force: true });
      if (created.edition)
        await database.query(
          "DELETE FROM catalog_public_outbox WHERE target_id = ANY($1::uuid[])",
          [[created.edition, created.printing]]
        );
      if (created.edition)
        await database.query("DELETE FROM catalog_edition WHERE id = $1", [
          created.edition,
        ]);
      if (created.printing)
        await database.query("DELETE FROM catalog_printing WHERE id = $1", [
          created.printing,
        ]);
      if (created.identity)
        await database.query("DELETE FROM catalog_identity WHERE id = $1", [
          created.identity,
        ]);
      await database.end();
    }
  });
});
