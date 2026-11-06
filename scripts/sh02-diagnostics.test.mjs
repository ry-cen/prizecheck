import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createCapture,
  createSink,
  LIMITS,
  project,
  routeClass,
} from "./sh02-diagnostics.mjs";

const secret = "DO-NOT-RETAIN-PRIVATE-CREDENTIAL";
const protocol = (capture, direction, message) =>
  capture.protocol(
    `${direction === "send" ? "SEND ► " : "◀ RECV "}${JSON.stringify(message)}`
  );

test("the pinned debug singleton reaches only the allowlisted sink, including when that sink fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sh02-debug-test-"));
  try {
    for (const broken of [false, true]) {
      const output = path.join(root, broken ? "unwritable" : "logs");
      if (broken) fs.writeFileSync(output, "not a directory");
      const result = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { createRequire } from 'node:module';
        import { installDiagnostics } from './scripts/sh02-diagnostics.mjs';
        installDiagnostics();
        if (process.env.DEBUG !== '') throw new Error('capture changed subprocess logging');
        const debug = createRequire(import.meta.url)('playwright-core/lib/utilsBundle').debug;
        debug('pw:protocol')('SEND ► ' + JSON.stringify({ id: 1, method: 'Page.enable', params: { body: '${secret}' } }));
      `,
        ],
        {
          cwd: path.resolve(import.meta.dirname, ".."),
          encoding: "utf8",
          env: {
            ...process.env,
            DEBUG: "",
            TEST_LOG_DIR: output,
            TEST_BROWSER_OUTPUT: "/parallel",
            TEST_WORKER_INDEX: "0",
            TEST_PARALLEL_INDEX: "0",
          },
        }
      );
      assert.equal(result.status, 0, result.stderr);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
      if (!broken) {
        const prefix = path.join(output, "sh02", "parallel-worker-0-stack-0");
        const status = JSON.parse(
          fs.readFileSync(`${prefix}.status.json`, "utf8")
        );
        assert.equal(status.internal_errors, 0);
        assert.equal(status.parse_errors, 0);
        assert.equal(status.pending_commands[0].method, "Page.enable");
        assert.ok(!fs.readFileSync(`${prefix}.jsonl`, "utf8").includes(secret));
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("protocol projection removes secrets even in known commands, replies and URLs", () => {
  for (const method of [
    "Page.getFrameTree",
    "Network.requestWillBeSent",
    "Network.responseReceived",
    "Fetch.requestPaused",
    "Runtime.executionContextCreated",
    "Target.attachedToTarget",
  ]) {
    const payload = {
      url: `http://localhost/loans/${secret}?token=${secret}#${secret}`,
      headers: { Cookie: secret },
      body: secret,
      postData: secret,
      source: secret,
    };
    const message = {
      method,
      id: 7,
      sessionId: secret,
      error: { message: secret, data: secret, code: -1 },
      params: {
        ...payload,
        request: payload,
        response: { ...payload, status: 200 },
        frame: { ...payload, id: "abc" },
        targetInfo: {
          ...payload,
          targetId: "def",
          title: secret,
          type: "page",
        },
      },
      result: { frameTree: { frame: payload }, value: secret },
    };
    const output = JSON.stringify(project(message));
    assert.ok(!output.includes(secret));
    for (const forbidden of [
      "http",
      "headers",
      "Cookie",
      "body",
      "postData",
      "source",
      "title",
    ])
      assert.ok(!output.includes(forbidden), forbidden);
  }
  assert.equal(
    project({ method: "Runtime.evaluate", params: { expression: secret } }),
    undefined
  );
  assert.equal(
    routeClass(`https://${secret}.example/${secret}?${secret}`),
    "external"
  );
  assert.equal(
    routeClass(`http://localhost/loans/${secret}?${secret}`),
    "loan-detail"
  );
});

test("native click records initialization replies, pending navigation and public Page without driving it", () => {
  const records = [],
    statuses = [];
  const capture = createCapture({
    event: (r) => records.push(r),
    status: (r) => statuses.push(r),
    close() {},
  });
  const context = new EventEmitter(),
    opener = new EventEmitter();
  opener.url = () => `http://localhost/loans?${secret}`;
  opener.isClosed = () => false;
  context.pages = () => [opener];
  // Any accidental command/navigation on the Browser is an error; only the client-local census is allowed.
  const browser = new Proxy(
    { contexts: () => [context] },
    {
      get: (obj, key) => {
        if (!(key in obj))
          throw new Error("diagnostics attempted a browser command");
        return obj[key];
      },
    }
  );
  const info = {
    file: "/checkout/web/tests/social-loans-desktop.spec.ts",
    line: 21,
  };
  capture.boundary(browser, info, "begin");
  protocol(capture, "send", { id: 1, method: "Target.createBrowserContext" });
  protocol(capture, "receive", { id: 1, result: { browserContextId: "aa" } });
  protocol(capture, "send", {
    id: 2,
    method: "Input.dispatchMouseEvent",
    sessionId: "ab",
    params: { type: "mousePressed", modifiers: 2 },
  });
  protocol(capture, "receive", {
    method: "Target.attachedToTarget",
    params: {
      sessionId: "bb",
      waitingForDebugger: true,
      targetInfo: {
        targetId: "cc",
        browserContextId: "aa",
        type: "page",
        url: "",
      },
    },
  });
  protocol(capture, "send", {
    id: 3,
    method: "Page.getFrameTree",
    sessionId: "bb",
  });
  protocol(capture, "receive", {
    id: 3,
    sessionId: "bb",
    result: { frameTree: { frame: { id: "cc", url: "about:blank" } } },
  });
  protocol(capture, "send", {
    id: 4,
    method: "Runtime.runIfWaitingForDebugger",
    sessionId: "bb",
  });
  protocol(capture, "receive", {
    method: "Network.requestWillBeSent",
    sessionId: "bb",
    params: {
      requestId: "123.1",
      type: "Document",
      request: { url: `http://localhost/loans/${secret}?${secret}` },
    },
  });
  const child = new EventEmitter();
  child.url = () => "about:blank";
  child.isClosed = () => false;
  context.emit("page", child);
  capture.boundary(browser, { ...info, status: "timedOut" }, "end");
  capture.finish();
  assert.equal(statuses.at(-1).internal_errors, 0);
  assert.equal(statuses.at(-1).modified_clicks, 1);
  assert.deepEqual(statuses.at(-1).observed_contexts, ["aa"]);
  assert.ok(
    statuses
      .at(-1)
      .pending_commands.some(
        (r) => r.method === "Runtime.runIfWaitingForDebugger"
      )
  );
  assert.equal(statuses.at(-1).pending_requests[0].route, "loan-detail");
  assert.ok(
    records.some(
      (r) => r.reply && r.method === "Page.getFrameTree" && r.route === "blank"
    )
  );
  assert.ok(
    records.some(
      (r) => r.kind === "resources" && r.reason === "before-modified-click"
    )
  );
  assert.ok(
    records.some((r) => r.kind === "public-page" && r.event === "page")
  );
  assert.equal(context.listenerCount("page"), 0);
  assert.equal(opener.listenerCount("close"), 0);
  assert.ok(!JSON.stringify([records, statuses]).includes(secret));
});

test("output and state are bounded and malformed capture does not throw", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sh02-test-"));
  try {
    const sink = createSink(root, "worker");
    for (let i = 0; i < 400; i++)
      sink.event({ kind: "size-test", padding: "a".repeat(4096) });
    sink.status({ complete: true });
    sink.close();
    assert.ok(
      fs.statSync(path.join(root, "worker.jsonl")).size <= LIMITS.bytes
    );
    assert.ok(
      fs
        .readFileSync(path.join(root, "worker.jsonl"), "utf8")
        .includes('"kind":"capture-limit"')
    );
    assert.ok(
      JSON.parse(fs.readFileSync(path.join(root, "worker.status.json")))
        .dropped > 0
    );
    assert.ok(
      fs.statSync(path.join(root, "worker.status.json")).size <=
        LIMITS.statusBytes
    );
    const states = [];
    const capture = createCapture({
      event() {},
      status: (s) => states.push(s),
      close() {},
    });
    capture.protocol("◀ RECV {invalid JSON");
    for (let i = 0; i < LIMITS.entries + 10; i++)
      protocol(capture, "send", {
        id: i,
        method: "Page.enable",
        sessionId: "aa",
      });
    capture.finish();
    assert.equal(states[0].parse_errors, 1);
    assert.equal(states[0].pending_commands.length, LIMITS.entries);
    assert.equal(states[0].state_overflow, 10);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

test("filesystem failure and observer failure cannot escape into a test", () => {
  const unavailable = createSink("unused", "worker", {
    mkdirSync() {
      throw new Error(secret);
    },
  });
  assert.doesNotThrow(() => {
    unavailable.event({ kind: "event" });
    unavailable.status({ complete: false });
    unavailable.close();
  });
  const states = [];
  const capture = createCapture({
    event() {},
    status: (s) => states.push(s),
    close() {},
  });
  assert.doesNotThrow(() =>
    capture.boundary(
      {
        contexts() {
          throw new Error(secret);
        },
      },
      { file: "social-loans-desktop.spec.ts" },
      "begin"
    )
  );
  assert.doesNotThrow(() => capture.finish());
  assert.equal(states[0].internal_errors, 1);
  assert.ok(!JSON.stringify(states).includes(secret));
});

test("a mid-capture write error is reported without throwing or exposing its message", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sh02-write-test-"));
  try {
    let dataFd;
    const io = {
      ...fs,
      openSync(name, ...args) {
        const fd = fs.openSync(name, ...args);
        if (name.endsWith(".jsonl")) dataFd = fd;
        return fd;
      },
      writeSync(fd, ...args) {
        if (fd === dataFd) throw new Error(secret);
        return fs.writeSync(fd, ...args);
      },
    };
    const sink = createSink(root, "worker", io);
    assert.doesNotThrow(() => {
      sink.event({ kind: "example" });
      sink.status({ complete: false });
      sink.close();
    });
    const status = fs.readFileSync(
      path.join(root, "worker.status.json"),
      "utf8"
    );
    assert.equal(JSON.parse(status).io_errors, 1);
    assert.ok(!status.includes(secret));
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});
