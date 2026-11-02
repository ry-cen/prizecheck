// Diagnostic-only checks; run with node --import tsx --test scripts/test_newtab_capture.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Capture,
  observeProtocol,
  safeUrl,
} from "../web/tests/support/newtab-capture";

test("URL projection drops credentials, query, fragment and non-http payloads", () => {
  assert.equal(
    safeUrl(
      "https://user:password@example.test/loans/fixture?token=secret#secret"
    ),
    "https://example.test/loans/fixture"
  );
  assert.equal(safeUrl("about:blank"), "about:blank");
  assert.equal(safeUrl("data:text/html,private"), "[data:]");
});

test("network capture retains timing/correlation but never headers, bodies or URL secrets", () => {
  const capture = new Capture();
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
  capture.protocol(
    '◀ RECV {"method":"Runtime.consoleAPICalled","params":{"private":"console-secret"}}'
  );
  assert.equal(capture.entries.length, 0);
  capture.protocol("◀ RECV {broken}");
  assert.equal(capture.unparseable, 1);
  capture.protocol("x".repeat(128 * 1024 + 1));
  assert.equal(capture.oversized, 1);
  for (let index = 0; index < 12001; index++) capture.record("synthetic");
  assert.equal(capture.entries.length, 12000);
  assert.equal(capture.dropped, 1);
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
  observeProtocol(debug, capture)();
  assert.equal(debug.log, log);
  assert.equal(debug.namespaces, "existing");
  assert.equal(
    JSON.stringify(capture.entries).includes("protocol-unavailable"),
    true
  );
});
