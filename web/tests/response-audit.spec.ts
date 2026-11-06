import { createServer, type ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import {
  AUDIT_BODY_BUFFER_BYTES,
  DOCUMENT_REPLACED,
  auditPage,
  type AuditedHop,
} from "./support/responseAudit";

/** This spec owns only a tiny HTTP fixture, not the application stack or a database. */
async function viewerServer() {
  const held: ServerResponse[] = [];
  const navigation: ServerResponse[] = [];
  const loading: ServerResponse[] = [];
  const go: ServerResponse[] = [];
  const counts = new Map<string, number>();
  const waiters: { path: string; count: number; resolve: () => void }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/trades/held") held.push(response);
    else if (path === "/nocontent" || path === "/slow")
      navigation.push(response);
    else if (path === "/go") go.push(response);
    else if (path === "/loading") {
      loading.push(response);
      const iframe = new URL(
        request.url ?? "/",
        "http://127.0.0.1"
      ).searchParams.has("iframe");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.write(`<!doctype html><!-- ${"x".repeat(1024)} --><script>
        document.addEventListener("DOMContentLoaded", () => fetch("/parsed"));
        window.proceed = async () => {
          await fetch("/go");
          history.pushState(null, "", "/nocontent");
          fetch("/pushed");
        };
        ${
          iframe
            ? ""
            : `(async () => {
          await (await fetch("/api/trades/open")).text();
          fetch("/api/trades/held").then(r => r.text()).then(t => document.title = t);
          window.proceed();
        })();`
        }
        </script>${iframe ? '<iframe src="/frame"></iframe>' : ""}`);
    } else if (path === "/frame")
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`<!doctype html><script>
        (async () => {
          await (await fetch("/api/trades/open")).text();
          fetch("/api/trades/held").then(r => r.text()).then(t => document.title = t);
          parent.proceed();
        })();
      </script>`);
    else if (path === "/one" || path === "/two")
      response
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end("<!doctype html><main>Viewer document</main>");
    else if (path === "/api/trades/open")
      response
        .writeHead(200, { "content-type": "text/plain" })
        .end("public terms");
    else response.writeHead(204).end();
    counts.set(path, (counts.get(path) ?? 0) + 1);
    for (const waiter of waiters)
      if (waiter.path === path && (counts.get(path) ?? 0) >= waiter.count)
        waiter.resolve();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP fixture did not bind its own port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    held,
    navigation,
    loading,
    go,
    received(path: string, count: number) {
      if ((counts.get(path) ?? 0) >= count) return Promise.resolve();
      return new Promise<void>((resolve) =>
        waiters.push({ path, count, resolve })
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    },
  };
}
type Fixture = Awaited<ReturnType<typeof viewerServer>>;
async function withViewer(
  page: Page,
  run: (
    server: Fixture,
    audit: Awaited<ReturnType<typeof auditPage>>,
    firstHeldBody: Promise<void>
  ) => Promise<void>
) {
  const server = await viewerServer();
  let audit: Awaited<ReturnType<typeof auditPage>> | undefined;
  let bodyInspected!: () => void;
  const firstHeldBody = new Promise<void>((resolve) => {
    bodyInspected = resolve;
  });
  try {
    audit = await auditPage(
      page,
      (url) => new URL(url).pathname.startsWith("/api/trades/"),
      (response) => {
        if (new URL(response.url()).pathname === "/api/trades/held")
          bodyInspected();
      }
    );
    await page.goto(`${server.origin}/one`);
    await run(server, audit, firstHeldBody);
  } finally {
    audit?.dispose();
    await server.close();
  }
}
async function inspectHeldRoute(
  page: Page,
  server: Fixture,
  firstHeldBody: Promise<void>
) {
  const body = page.evaluate(() =>
    fetch("/api/trades/held").then((response) => response.text())
  );
  await server.received("/api/trades/held", 1);
  server.held[0].end("public held terms");
  expect(await body).toBe("public held terms");
  await firstHeldBody;
}
async function startHeld(page: Page, server: Fixture, count: number) {
  const observed = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/trades/held"
  );
  await page.evaluate(() => {
    // The audit owns classification of this intentionally interrupted request.
    // Chromium may reject fetch on the cut; no transport outcome is asserted here.
    void fetch("/api/trades/held").catch(() => undefined);
  });
  await server.received("/api/trades/held", count);
  return observed;
}

// WP-3 gate: these tests deliberately create no audit; it would void the control.
async function readAfterCommit(page: Page, origin: string, durable: boolean) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send(
    "Network.enable",
    durable
      ? {
          maxTotalBufferSize: AUDIT_BODY_BUFFER_BYTES,
          enableDurableMessages: true,
        }
      : {}
  );
  await page.goto(`${origin}/one`);
  let requestId = "";
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.url.endsWith("/api/trades/open"))
      requestId = event.requestId;
  });
  const finished = new Promise<void>((resolve) =>
    cdp.on("Network.loadingFinished", (event) => {
      if (event.requestId === requestId) resolve();
    })
  );
  await page.evaluate(() => fetch("/api/trades/open").then((r) => r.text()));
  await finished;
  await page.goto(`${origin}/two`);
  return cdp.send("Network.getResponseBody", { requestId });
}
for (const interception of ["plain", "with page.route"]) {
  test(`a complete body survives a committed replacement, ${interception}`, async ({
    page,
  }) => {
    const server = await viewerServer();
    try {
      if (interception === "with page.route")
        await page.route(/never-matches/, (route) => route.continue());
      expect((await readAfterCommit(page, server.origin, true)).body).toBe(
        "public terms"
      );
    } finally {
      await server.close();
    }
  });
}
test("control: without durable messages the same read fails", async ({
  page,
}) => {
  const server = await viewerServer();
  try {
    await expect(readAfterCommit(page, server.origin, false)).rejects.toThrow(
      /No resource|No data found/
    );
  } finally {
    await server.close();
  }
});

test("cut", async ({ page }) => {
  await withViewer(page, async (server, audit, firstHeldBody) => {
    await inspectHeldRoute(page, server, firstHeldBody);
    await startHeld(page, server, 2);
    await page.goto(`${server.origin}/two`);
    const bodies = await audit.finish();
    expect(bodies).toContain("public held terms");
    expect(
      audit.abortedRequests.some(
        (entry) =>
          (entry.request as AuditedHop).url.endsWith("/api/trades/held") &&
          entry.reason === DOCUMENT_REPLACED
      )
    ).toBe(true);
  });
});

test("live, same-document", async ({ page }) => {
  await withViewer(page, async (server, audit) => {
    await startHeld(page, server, 1);
    const changed = page.waitForEvent("framenavigated", {
      predicate: (frame) =>
        frame === page.mainFrame() && frame.url().endsWith("/still-live"),
    });
    await page.evaluate(() => history.pushState(null, "", "/still-live"));
    await changed;
    audit.stop();
    server.held[0].end("marker from the live document");
    const bodies = await audit.finish();
    expect(bodies).toContain("marker from the live document");
  });
});

async function pendingBeforeBody(audit: Awaited<ReturnType<typeof auditPage>>) {
  audit.stop();
  const proof = audit.finish();
  const early = await Promise.race([
    proof.then(() => "finished"),
    new Promise((resolve) => setTimeout(resolve, 1_000, "pending")),
  ]);
  expect(early).toBe("pending");
  return { proof };
}

for (const schedule of [
  "failed navigation first",
  "DOMContentLoaded first",
  "with a surviving iframe",
]) {
  test(`still-loading document, ${schedule}`, async ({ page }) => {
    await withViewer(page, async (server, audit) => {
      const iframe = schedule === "with a surviving iframe";
      await page.goto(`${server.origin}/loading${iframe ? "?iframe=1" : ""}`, {
        waitUntil: "commit",
      });
      await server.received("/loading", 1);
      if (iframe) await server.received("/frame", 1);
      await server.received("/api/trades/open", 1);
      await server.received("/api/trades/held", 1);
      await server.received("/go", 1);
      const navigation = page
        .goto(`${server.origin}/nocontent`)
        .catch(() => undefined);
      await server.received("/nocontent", 1);
      server.go[0].writeHead(204).end();
      await server.received("/pushed", 1);
      const fail = async () => {
        if (!server.navigation[0].destroyed)
          server.navigation[0].writeHead(204).end();
        await navigation;
      };
      const parse = async () => {
        server.loading[0].end("</html>");
        await server.received("/parsed", 1);
      };
      if (schedule === "DOMContentLoaded first") {
        await parse();
        await fail();
      } else {
        await fail();
        await parse();
      }
      const { proof } = await pendingBeforeBody(audit);
      server.held[0].end("marker from the surviving document");
      expect(await proof).toContain("marker from the surviving document");
      expect(audit.abortedRequests).toEqual([]);
    });
  });
}

test("new document after a cut", async ({ page }) => {
  await withViewer(page, async (server, audit, firstHeldBody) => {
    await inspectHeldRoute(page, server, firstHeldBody);
    await startHeld(page, server, 2);
    await page.goto(`${server.origin}/two`);
    await startHeld(page, server, 3);
    const { proof } = await pendingBeforeBody(audit);
    server.held[2].end("marker from the new document");
    const bodies = await proof;
    expect(bodies).toContain("marker from the new document");
    expect(
      audit.abortedRequests.some(
        (entry) =>
          (entry.request as AuditedHop).url.endsWith("/api/trades/held") &&
          entry.reason === DOCUMENT_REPLACED
      )
    ).toBe(true);
  });
});

const blockNode = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
test("a body received just before commit is inspected", async ({ page }) => {
  await withViewer(page, async (server, audit, firstHeldBody) => {
    await inspectHeldRoute(page, server, firstHeldBody);
    await startHeld(page, server, 2);
    const next = page.goto(`${server.origin}/slow`);
    await server.received("/slow", 1);
    server.held[1].end("marker delivered before commit");
    blockNode(250);
    server.navigation[0]
      .writeHead(200, { "content-type": "text/html; charset=utf-8" })
      .end("<!doctype html><main>Next</main>");
    blockNode(250);
    await next;
    expect(await audit.finish()).toContain("marker delivered before commit");
    expect(audit.abortedRequests).toEqual([]);
  });
});
test("a fulfilled audited response is inspected", async ({ page }) => {
  await withViewer(page, async (_server, audit) => {
    await page.route("**/api/trades/held", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/plain",
        body: "fulfilled marker",
      })
    );
    expect(
      await page.evaluate(() =>
        fetch("/api/trades/held").then((response) => response.text())
      )
    ).toBe("fulfilled marker");
    expect(await audit.finish()).toContain("fulfilled marker");
  });
});
