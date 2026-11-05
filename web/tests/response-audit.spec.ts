import { createServer, type ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { auditPage } from "./support/responseAudit";

/** This spec owns only a tiny HTTP fixture, not the application stack or a database. */
async function viewerServer() {
  const held: ServerResponse[] = [];
  const navigation: ServerResponse[] = [];
  const counts = new Map<string, number>();
  const waiters: { path: string; count: number; resolve: () => void }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/trades/held") held.push(response);
    else if (path === "/nocontent") navigation.push(response);
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
    audit: ReturnType<typeof auditPage>,
    firstHeldBody: Promise<void>
  ) => Promise<void>
) {
  const server = await viewerServer();
  let audit: ReturnType<typeof auditPage> | undefined;
  let bodyInspected!: () => void;
  const firstHeldBody = new Promise<void>((resolve) => {
    bodyInspected = resolve;
  });
  try {
    audit = auditPage(
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

test("cut", async ({ page }) => {
  await withViewer(page, async (server, audit, firstHeldBody) => {
    await inspectHeldRoute(page, server, firstHeldBody);
    const cut = await startHeld(page, server, 2);
    await page.goto(`${server.origin}/two`);
    const bodies = await audit.finish();
    expect(bodies).toContain("public held terms");
    expect(audit.abortedRequests.some((entry) => entry.request === cut)).toBe(
      true
    );
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

test("same-URL pushState during a navigation that does not commit", async ({
  page,
}) => {
  await withViewer(page, async (server, audit) => {
    await startHeld(page, server, 1);
    const navigating = page.waitForRequest(
      (request) =>
        request.isNavigationRequest() &&
        request.url() === `${server.origin}/nocontent`
    );
    await page.evaluate(() => {
      location.href = "/nocontent";
    });
    await server.received("/nocontent", 1);
    await navigating;
    const changed = page.waitForEvent("framenavigated", {
      predicate: (frame) =>
        frame === page.mainFrame() &&
        frame.url() === `${server.origin}/nocontent`,
    });
    await page.evaluate(() => history.pushState(null, "", "/nocontent"));
    await changed;
    // A pushState may cancel the pending navigation in Chromium. Either way,
    // no new document committed, and the API response must still be inspected.
    if (!server.navigation[0].destroyed)
      server.navigation[0].writeHead(204).end();
    audit.stop();
    server.held[0].end("marker after the uncommitted navigation");
    const bodies = await audit.finish();
    expect(bodies).toContain("marker after the uncommitted navigation");
  });
});

test("new document after a cut", async ({ page }) => {
  await withViewer(page, async (server, audit, firstHeldBody) => {
    await inspectHeldRoute(page, server, firstHeldBody);
    const cut = await startHeld(page, server, 2);
    await page.goto(`${server.origin}/two`);
    await startHeld(page, server, 3);
    audit.stop();
    server.held[2].end("marker from the new document");
    const bodies = await audit.finish();
    expect(bodies).toContain("marker from the new document");
    expect(audit.abortedRequests.some((entry) => entry.request === cut)).toBe(
      true
    );
  });
});
