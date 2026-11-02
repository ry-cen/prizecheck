// Diagnostic-only checks; run with node --import tsx --test scripts/test_newtab_capture.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Capture,
  LIMITS,
  remember,
  COMMAND_FIELDS,
  observeProtocol,
  safeUrl,
} from "../web/tests/support/newtab-capture";

test("URL projection drops credentials, query, fragment and non-http payloads", () => {
  assert.equal(
    safeUrl(
      "https://user:password@example.test/loans/fixture?token=secret#secret"
    ),
    "https://redacted.invalid/loans/:id"
  );
  assert.equal(safeUrl("about:blank"), "about:blank");
  assert.equal(safeUrl("data:text/html,private"), "[data:]");
});

test("network capture retains timing/correlation but never headers, bodies or URL secrets", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    "pw:protocol ◀ RECV " +
      JSON.stringify({
        method: "Network.requestWillBeSent",
        sessionId: "popup-session",
        params: {
          requestId: "request-1",
          frameId: "frame-1",
          timestamp: 12.5,
          request: {
            url: "https://user:password@example.test/loans/fixture?token=unique-secret#fragment-secret",
            method: "POST",
            headers: { authorization: "auth-secret", cookie: "cookie-secret" },
            postData: "body-secret",
          },
        },
      })
  );
  const data = JSON.stringify(capture.entries);
  for (const secret of [
    "password",
    "unique-secret",
    "fragment-secret",
    "auth-secret",
    "cookie-secret",
    "body-secret",
    "headers",
    "postData",
  ])
    assert.equal(data.includes(secret), false, secret);
  assert.equal(data.includes("request-1"), true);
  assert.equal(data.includes("frame-1"), true);
  assert.equal(data.includes("popup-session"), true);
  assert.equal(data.includes("12.5"), true);
});

test("target events preserve target/session/opener context identity without title text", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    "◀ RECV " +
      JSON.stringify({
        method: "Target.attachedToTarget",
        sessionId: "parent",
        params: {
          sessionId: "child",
          targetInfo: {
            targetId: "target",
            openerId: "opener",
            browserContextId: "context",
            type: "page",
            url: "https://example.test/loans/fixture?secret=hidden",
            title: "private-title",
          },
        },
      })
  );
  const data = JSON.stringify(capture.entries);
  for (const id of ["parent", "child", "target", "opener", "context"])
    assert.equal(data.includes(id), true);
  assert.equal(data.includes("private-title"), false);
  assert.equal(data.includes("hidden"), false);
});

test("initialization command replies clear the correlated pending operation without persisting result payload", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    'SEND ► {"id":7,"sessionId":"child","method":"Runtime.enable"}'
  );
  assert.equal(capture.pending.get("child:7"), "Runtime.enable");
  capture.protocol(
    '◀ RECV {"id":7,"sessionId":"child","result":{"secret":"result-secret"}}'
  );
  assert.equal(capture.pending.size, 0);
  assert.equal(capture.entries.length, 2);
  assert.equal(
    JSON.stringify(capture.entries).includes("result-secret"),
    false
  );
});

test("ignored events, malformed data and size/record bounds do not throw or hide truncation", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    '◀ RECV {"method":"Runtime.consoleAPICalled","params":{"private":"console-secret"}}'
  );
  assert.equal(capture.entries.length, 0);
  capture.protocol("◀ RECV {broken}");
  assert.equal(capture.unparseable, 1);
  capture.protocol("x".repeat(128 * 1024 + 1));
  assert.equal(capture.oversized, 1);
  for (let index = 0; index < 12001; index++)
    capture.record("browser-disconnected");
  assert.ok(capture.entries.length <= 4000);
  assert.ok(capture.dropped > 0);
});

test("observer restores its logger/namespace on failure and suppresses debug persistence", () => {
  let saved = 0;
  const debug = {
    namespaces: undefined as string | undefined,
    save: (_value?: string) => {
      saved++;
    },
    enable(value?: string) {
      this.save(value);
      this.namespaces = value;
    },
    log(_value: unknown) {},
  };
  const originalLog = debug.log;
  const capture = new Capture();
  capture.start();
  const restore = observeProtocol(debug, capture);
  try {
    assert.equal(debug.namespaces, "pw:protocol");
    debug.log.call(
      { namespace: "pw:protocol" },
      'SEND ► {"id":1,"method":"Page.enable"}'
    );
    throw new Error("synthetic test failure");
  } catch (error) {
    assert.equal((error as Error).message, "synthetic test failure");
  } finally {
    restore();
    restore();
  }
  assert.equal(debug.log, originalLog);
  assert.equal(debug.namespaces, undefined);
  assert.equal(saved, 0);
  assert.equal(capture.entries.length, 1);
});

test("existing debug configuration is left untouched rather than silently overridden", () => {
  const debug = {
    namespaces: "existing",
    enable() {
      throw Error("must not enable");
    },
    save() {},
    log() {},
  };
  const log = debug.log;
  const capture = new Capture();
  capture.start();
  observeProtocol(debug, capture)();
  assert.equal(debug.log, log);
  assert.equal(debug.namespaces, "existing");
  assert.equal(
    JSON.stringify(capture.entries).includes("protocol-unavailable"),
    true
  );
});

test("dynamic and unknown path segments never survive any URL projection", () => {
  const capture = new Capture();
  capture.start();
  for (const path of [
    "/invite/invite-secret",
    "/published/publication-secret",
    "/loans/loan-secret",
    "/unknown/user-secret",
    "/user-secret",
    "/%69nvite/encoded-secret",
  ]) {
    const url = `https://user:password@example.test${path}?token=query-secret#fragment-secret`;
    capture.record("request", { url });
    capture.protocol(
      "◀ RECV " +
        JSON.stringify({
          method: "Target.targetInfoChanged",
          params: { targetInfo: { url } },
        })
    );
  }
  const output = JSON.stringify(capture.entries);
  for (const secret of [
    "invite-secret",
    "publication-secret",
    "loan-secret",
    "user-secret",
    "encoded-secret",
    "password",
    "query-secret",
    "fragment-secret",
  ])
    assert.equal(output.includes(secret), false, secret);
});

test("response headers, Set-Cookie and response bodies never enter output", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    "◀ RECV " +
      JSON.stringify({
        method: "Network.responseReceived",
        params: {
          requestId: "response-id",
          response: {
            url: "https://example.test/published/token-secret",
            status: 200,
            headers: { "Set-Cookie": "cookie-secret" },
            body: "response-body-secret",
          },
        },
      })
  );
  capture.protocol('SEND ► {"id":8,"method":"Network.getResponseBody"}');
  capture.protocol('◀ RECV {"id":8,"result":{"body":"command-body-secret"}}');
  const output = JSON.stringify(capture.entries);
  for (const secret of [
    "Set-Cookie",
    "cookie-secret",
    "response-body-secret",
    "command-body-secret",
    "token-secret",
  ])
    assert.equal(output.includes(secret), false, secret);
});

test("unlisted command methods and their replies are rejected", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    'SEND ► {"id":9,"method":"Runtime.unreviewedDiagnosticMethod","params":{"url":"secret"}}'
  );
  capture.protocol('◀ RECV {"id":9,"result":{"secret":"secret"}}');
  assert.equal(capture.entries.length, 0);
  assert.equal(capture.pending.size, 0);
});

test("public and protocol capture ignore both sides of the click window", () => {
  const capture = new Capture();
  const record = () => {
    capture.record("request", { url: "https://example.test/loans/secret" });
    capture.protocol('SEND ► {"id":1,"method":"Page.enable"}');
  };
  record();
  assert.equal(capture.entries.length, 0);
  capture.start();
  record();
  assert.equal(capture.entries.length, 2);
  capture.stop();
  const count = capture.entries.length;
  record();
  capture.start();
  record();
  assert.equal(capture.entries.length, count);
});

test("public records obey field, event and total UTF-8 output budgets", () => {
  const capture = new Capture();
  capture.start();
  capture.record("request", { method: "🧪".repeat(36000) });
  assert.ok(Buffer.byteLength(JSON.stringify(capture.entries)) < 8192);
  for (let i = 0; i < 12000; i++)
    capture.record("request", { method: "x".repeat(256) });
  const output = capture.serialize();
  assert.ok(Buffer.byteLength(output) <= 512 * 1024);
  for (const entry of capture.entries)
    assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= 8192);
  assert.ok(capture.dropped > 0);
  assert.ok(capture.oversized > 0);
});

test("listed commands retain only their explicitly permitted envelope fields", () => {
  for (const method of Object.keys(COMMAND_FIELDS)) {
    const capture = new Capture();
    capture.start();
    capture.protocol(
      "SEND ► " +
        JSON.stringify({
          id: 1,
          method,
          params: {
            sessionId: "parameter-secret",
            targetId: "parameter-secret",
            url: "https://example.test/invite/parameter-secret",
            source: "source-secret",
          },
        })
    );
    capture.protocol(
      '◀ RECV {"id":1,"result":{"body":"response-secret","frameTree":{"secret":"frame-secret"},"sessionId":"result-secret"}}'
    );
    assert.equal(capture.entries.length, 2, method);
    assert.equal(capture.pending.size, 0, method);
    for (const secret of [
      "parameter-secret",
      "source-secret",
      "response-secret",
      "frame-secret",
      "result-secret",
    ])
      assert.equal(
        capture.serialize().includes(secret),
        false,
        `${method}: ${secret}`
      );
    for (const entry of capture.entries) {
      const data = JSON.parse(JSON.stringify(entry)).data;
      assert.deepEqual(Object.keys(data).sort(), [
        "direction",
        "hasError",
        "id",
        "method",
        "reply",
      ]);
    }
  }
});

test("field byte boundary is exact for ASCII and multibyte strings", () => {
  const capture = new Capture();
  capture.start();
  for (const reason of [
    "x".repeat(256),
    "x".repeat(257),
    "🧪".repeat(64),
    "🧪".repeat(65),
  ])
    capture.record("request", { method: reason });
  for (const entry of capture.entries)
    assert.equal(
      Buffer.byteLength((entry as { data: { method: string } }).data.method),
      256
    );
  assert.equal(capture.oversized, 2);
});

test("oversized events are dropped rather than bypassing the total budget", () => {
  const capture = new Capture();
  capture.start();
  capture.record("before-click", {
    pending: Array.from({ length: LIMITS.items }, () => ({
      method: "x".repeat(LIMITS.fieldBytes),
    })),
  });
  assert.equal(capture.entries.length, 0);
  assert.equal(capture.dropped, 1);
  capture.record("request", { method: "retained" });
  assert.equal(capture.entries.length, 1);
});

test("total attachment limit includes counters and event separators", () => {
  const capture = new Capture();
  capture.start();
  for (let i = 0; i < 12000; i++)
    capture.record("request", { method: "x".repeat(LIMITS.fieldBytes) });
  const count = capture.entries.length;
  capture.record("request", { method: "x".repeat(LIMITS.fieldBytes) });
  assert.equal(capture.entries.length, count);
  assert.ok(Buffer.byteLength(capture.serialize()) <= LIMITS.totalBytes);
  assert.ok(Buffer.byteLength(capture.serialize()) > LIMITS.totalBytes - 2048);
});

test("retained requests/pages/commands and marker snapshots stay bounded", () => {
  for (const limit of [LIMITS.requests, LIMITS.pages, LIMITS.pending]) {
    const map = new Map<number, string>();
    for (let i = 0; i < limit + 1; i++)
      assert.equal(remember(map, i, "bounded-value", limit), i < limit);
    assert.equal(map.size, limit);
    assert.equal(remember(map, 0, "updated", limit), true);
    assert.equal(map.get(0), "updated");
  }
  const capture = new Capture();
  capture.snapshot("before-window", {});
  capture.start();
  for (let i = 0; i < LIMITS.snapshots + 1; i++)
    capture.snapshot("before-click", {
      pages: Array.from({ length: 1000 }, () => ({
        url: "https://example.test/invite/secret",
      })),
    });
  assert.equal(capture.entries.length, LIMITS.snapshots);
  assert.ok(capture.dropped > 0);
  const events = JSON.parse(capture.serialize()).events;
  assert.ok(
    events.every(
      (e: { data: { pages: unknown[] } }) =>
        e.data.pages.length === LIMITS.items
    )
  );
  assert.equal(capture.serialize().includes("secret"), false);
  capture.stop();
  capture.snapshot("after-window", {});
  assert.equal(capture.entries.length, LIMITS.snapshots);
});

test("pending protocol keys cannot retain oversized identifiers", () => {
  const capture = new Capture();
  capture.start();
  for (let i = 0; i < LIMITS.pending + 1; i++)
    capture.protocol(`SEND ► {"id":${i},"method":"Page.enable"}`);
  assert.equal(capture.pending.size, LIMITS.pending);
  capture.protocol(
    "SEND ► " +
      JSON.stringify({
        id: 1000,
        sessionId: "x".repeat(1000),
        method: "Page.enable",
      })
  );
  assert.ok(
    [...capture.pending.keys()].every(
      (key) => Buffer.byteLength(key) <= LIMITS.fieldBytes
    )
  );
  assert.ok(capture.oversized > 0);
});

test("public output also excludes header/body fields and sanitizes URL strings in arrays", () => {
  const capture = new Capture();
  capture.start();
  capture.record("before-click", {
    headers: { "Set-Cookie": "cookie-secret" },
    body: "body-secret",
    serviceWorkers: ["https://example.test/invite/worker-secret"],
    expectedUrl: "https://example.test/published/publication-secret",
  });
  for (const secret of [
    "Set-Cookie",
    "cookie-secret",
    "body-secret",
    "worker-secret",
    "publication-secret",
  ])
    assert.equal(capture.serialize().includes(secret), false, secret);
});

test("protocol field projection cannot retain nested arbitrary payload objects", () => {
  const capture = new Capture();
  capture.start();
  capture.protocol(
    '◀ RECV {"method":"Target.targetCreated","params":{"targetInfo":{"targetId":{"secret":"nested-secret"}}}}'
  );
  assert.equal(capture.serialize().includes("nested-secret"), false);
});

test("unknown public events are dropped without retaining names or values", () => {
  const capture = new Capture();
  capture.start();
  capture.record("unlisted-event-secret", { token: "unlisted-event-value" });
  assert.equal(capture.entries.length, 0);
  assert.equal(capture.rejectedEvents, 1);
  assert.equal(capture.dropped, 1);
  assert.equal(capture.serialize().includes("unlisted-event-secret"), false);
  assert.equal(capture.serialize().includes("unlisted-event-value"), false);
});

test("public schemas retain allowed fields and reject all unlisted names and values", () => {
  const capture = new Capture();
  capture.start();
  const unexpected = {
    authorization: "authorization-secret",
    token: "token-secret",
    responseBody: "response-body-secret",
    credential: "credential-secret",
    arbitraryExtra: "extra-secret",
  };
  capture.record("request", {
    id: 7,
    page: "page-0",
    url: "http://localhost:5173/loans/private-id",
    method: "GET",
    navigation: true,
    type: "document",
    ...unexpected,
  });
  const serialized = capture.serialize();
  for (const [key, value] of Object.entries(unexpected)) {
    assert.equal(serialized.includes(key), false, key);
    assert.equal(serialized.includes(value), false, value);
  }
  assert.deepEqual(JSON.parse(serialized).events[0].data, {
    id: 7,
    page: "page-0",
    url: "http://localhost:5173/loans/:id",
    method: "GET",
    navigation: true,
    type: "document",
  });
  assert.equal(capture.rejectedFields, 5);
});

test("nested public fields have exact schemas and reject wrong types", () => {
  const capture = new Capture();
  capture.start();
  capture.snapshot("before-click", {
    openerClosed: "invalid-boolean-secret",
    viewport: { width: 1440, height: 1000, token: "viewport-secret" },
    cpu: {
      user: 10,
      system: "invalid-number-secret",
      credential: "cpu-secret",
    },
    pending: [{ id: 8, method: "GET", authorization: "pending-secret" }],
    pages: [
      { id: "page-0", url: "about:blank", arbitraryExtra: "page-secret" },
    ],
    serviceWorkers: [
      "http://localhost:5173/worker-secret",
      { token: "worker-object-secret" },
    ],
  });
  const serialized = capture.serialize();
  for (const secret of [
    "invalid-boolean-secret",
    "viewport-secret",
    "invalid-number-secret",
    "cpu-secret",
    "pending-secret",
    "page-secret",
    "worker-secret",
    "worker-object-secret",
    "authorization",
    "credential",
    "arbitraryExtra",
    "token",
  ])
    assert.equal(serialized.includes(secret), false, secret);
  assert.equal(capture.rejectedFields, 4);
  assert.equal(capture.rejectedValues, 3);
  assert.deepEqual(JSON.parse(serialized).events[0].data, {
    viewport: { width: 1440, height: 1000 },
    cpu: { user: 10 },
    pending: [{ id: 8, method: "GET" }],
    pages: [{ id: "page-0", url: "about:blank" }],
    serviceWorkers: ["http://localhost:5173/<redacted>"],
  });
});

test("every permitted public event preserves its schema and rejects extra fields", () => {
  const request = {
    id: 7,
    page: "page-0",
    url: "about:blank",
    method: "GET",
    navigation: true,
    type: "document",
  };
  const snapshot = {
    expectedUrl: "about:blank",
    openerUrl: "about:blank",
    openerClosed: false,
    viewport: { width: 1440, height: 1000 },
    cpu: { user: 10, system: 2 },
    eventLoop: { idle: 3, active: 4, utilization: 0.5 },
    pending: [request],
    pages: [{ id: "page-0", url: "about:blank" }],
    serviceWorkers: ["about:blank"],
  };
  const events: Record<string, object> = {
    "context.page": { page: "page-0", url: "about:blank", opener: true },
    framenavigated: { page: "page-0", main: true, url: "about:blank" },
    load: { page: "page-0", url: "about:blank" },
    domcontentloaded: { page: "page-0", url: "about:blank" },
    close: { page: "page-0" },
    crash: { page: "page-0" },
    request,
    requestfinished: { id: 7 },
    requestfailed: { id: 7 },
    response: { id: 7, status: 200, url: "about:blank" },
    serviceworker: { url: "about:blank" },
    "browser-disconnected": {},
    start: {
      pid: 1,
      workerIndex: 0,
      parallelIndex: 0,
      repeatEachIndex: 0,
      retry: 0,
      workers: 2,
    },
    "protocol-unavailable": { reason: "logger enable failed" },
    "protocol-window-start": { version: "1.63.0" },
    "before-click": snapshot,
    "click-completed": snapshot,
    "page-event-delivered": snapshot,
    "url-assertions-passed": snapshot,
    "window-ended": { ...snapshot, viewport: null },
    end: {
      status: "failed",
      dropped: 0,
      oversized: 0,
      unparseable: 0,
      pendingProtocolCommands: [{ id: "session:1", method: "Page.enable" }],
      pendingRequests: [request],
      cpu: { user: 10, system: 2 },
      eventLoop: { idle: 3, active: 4, utilization: 0.5 },
    },
  };
  const unexpected = {
    authorization: "authorization-secret",
    token: "token-secret",
    responseBody: "response-body-secret",
    credential: "credential-secret",
    arbitraryExtra: "extra-secret",
  };
  for (const [event, data] of Object.entries(events)) {
    const capture = new Capture();
    capture.start();
    capture.record(event, { ...data, ...unexpected });
    const output = capture.serialize();
    assert.deepEqual(JSON.parse(output).events[0].data, data, event);
    assert.equal(capture.rejectedFields, 5, event);
    assert.equal(capture.rejectedValues, 0, event);
    for (const [key, value] of Object.entries(unexpected)) {
      assert.equal(output.includes(key), false, `${event}: ${key}`);
      assert.equal(output.includes(value), false, `${event}: ${value}`);
    }
  }
});

test("protocol recording boundary enforces method-specific typed field schemas", () => {
  const capture = new Capture();
  capture.start();
  capture.record("protocol", {
    method: "Runtime.unreviewedDiagnosticMethod",
    token: "method-secret",
  });
  assert.equal(capture.entries.length, 0);
  assert.equal(capture.rejectedValues, 1);
  capture.record("protocol", {
    method: "Page.enable",
    direction: "send",
    id: 1,
    targetUrl: "unlisted-command-field-secret",
    credential: "credential-secret",
  });
  capture.record("protocol", {
    method: "Network.responseReceived",
    direction: "receive",
    requestId: "request-1",
    status: 200,
    timestamp: 12,
    responseBody: "response-body-secret",
    frameId: "unlisted-event-field-secret",
    requestUrl: "http://localhost:5173/published/publication-secret",
  });
  const output = capture.serialize();
  for (const secret of [
    "method-secret",
    "unlisted-command-field-secret",
    "credential-secret",
    "response-body-secret",
    "unlisted-event-field-secret",
    "publication-secret",
    "credential",
    "responseBody",
  ])
    assert.equal(output.includes(secret), false, secret);
  const events = JSON.parse(output).events;
  assert.deepEqual(events[0].data, {
    direction: "send",
    id: 1,
    method: "Page.enable",
  });
  assert.deepEqual(events[1].data, {
    direction: "receive",
    method: "Network.responseReceived",
    requestId: "request-1",
    status: 200,
    timestamp: 12,
    requestUrl: "http://localhost:5173/published/:token",
  });
  assert.equal(capture.rejectedFields, 4);
});

test("schema rejection does not read unlisted values or retain invalid typed values", () => {
  const capture = new Capture();
  capture.start();
  const data = Object.defineProperty(
    {
      id: "invalid-id-secret",
      navigation: { token: "invalid-navigation-secret" },
      method: "GET",
    },
    "authorization",
    {
      enumerable: true,
      get() {
        throw new Error("must not read unlisted value");
      },
    }
  );
  capture.record("request", data);
  assert.equal(capture.rejectedFields, 1);
  assert.equal(capture.rejectedValues, 2);
  capture.record("protocol-unavailable", { reason: "unlisted-reason-secret" });
  capture.record("protocol-window-start", {
    version: "unlisted-version-secret",
  });
  assert.equal(capture.rejectedValues, 4);
  const output = capture.serialize();
  for (const secret of [
    "authorization",
    "invalid-id-secret",
    "invalid-navigation-secret",
    "unlisted-reason-secret",
    "unlisted-version-secret",
  ])
    assert.equal(output.includes(secret), false, secret);
  assert.deepEqual(JSON.parse(output).events[0].data, { method: "GET" });
});
