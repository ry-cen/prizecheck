// Disposable instrumentation for validation/sh02-instrumented. Never merge as a fix.
import * as fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

export const LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  statusBytes: 64 * 1024,
  messageBytes: 512 * 1024,
  entries: 256,
  workers: 16,
});
const commands = new Set([
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.setAutoAttach",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Browser.getWindowForTarget",
  "Browser.setWindowBounds",
  "Page.enable",
  "Page.getFrameTree",
  "Page.createIsolatedWorld",
  "Page.setLifecycleEventsEnabled",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.setInterceptFileChooserDialog",
  "Page.setFontFamilies",
  "Runtime.enable",
  "Runtime.addBinding",
  "Runtime.runIfWaitingForDebugger",
  "Log.enable",
  "Network.enable",
  "Network.setCacheDisabled",
  "Network.setExtraHTTPHeaders",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Fetch.continueResponse",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "Emulation.setFocusEmulationEnabled",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Emulation.setUserAgentOverride",
  "Emulation.setLocaleOverride",
  "Emulation.setTimezoneOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setDefaultBackgroundColorOverride",
  "Emulation.setEmulatedVisionDeficiency",
  "Input.dispatchMouseEvent",
]);
const events = new Set([
  "Target.targetCreated",
  "Target.attachedToTarget",
  "Target.targetInfoChanged",
  "Target.detachedFromTarget",
  "Target.targetDestroyed",
  "Page.frameNavigated",
  "Page.lifecycleEvent",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.frameRequestedNavigation",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
  "Inspector.targetCrashed",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Fetch.requestPaused",
]);
const number = (v) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const identifier = (v) =>
  typeof v === "string" &&
  /^(?:[a-f0-9]{1,64}|[0-9]+\.[0-9]+|interception-job-[0-9.]+)$/i.test(v)
    ? v
    : undefined;
const choice = (v, choices) => (choices.includes(v) ? v : undefined);
const specFile = (v) =>
  typeof v === "string" && /^[a-z0-9-]+\.spec\.ts$/.test(path.basename(v))
    ? path.basename(v)
    : "other";

/** Only fixed route classes survive. No host, path identifier, query, fragment or token is retained. */
export function routeClass(value) {
  if (value === "about:blank") return "blank";
  if (value === "" || value === ":") return "initial-empty";
  try {
    const url = new URL(value);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return "external";
    if (/^\/loans\/[^/]+\/?$/.test(url.pathname)) return "loan-detail";
    if (url.pathname === "/loans") return "loans";
    if (url.pathname.startsWith("/src/") || url.pathname.startsWith("/@"))
      return "local-module";
    if (url.pathname.startsWith("/api/")) return "local-api";
    if (url.pathname.startsWith("/auth/")) return "local-auth";
    return "local-other";
  } catch {
    return undefined;
  }
}

/** The only protocol-to-artifact projection. Never spread a protocol object into output. */
export function project(message, replyMethod) {
  const method = replyMethod ?? message.method;
  if (!commands.has(method) && !events.has(method)) return undefined;
  const p = message.params ?? {},
    r = message.result ?? {};
  const target = p.targetInfo ?? {},
    frame = p.frame ?? r.frameTree?.frame ?? {};
  return {
    method,
    id: number(message.id),
    session: identifier(message.sessionId),
    child_session: identifier(p.sessionId ?? r.sessionId),
    context: identifier(
      target.browserContextId ?? p.browserContextId ?? r.browserContextId
    ),
    target: identifier(target.targetId ?? p.targetId ?? r.targetId),
    opener: identifier(target.openerId),
    target_type: choice(target.type, [
      "page",
      "iframe",
      "browser",
      "worker",
      "service_worker",
      "other",
    ]),
    waiting_for_debugger:
      typeof p.waitingForDebugger === "boolean"
        ? p.waitingForDebugger
        : undefined,
    frame: identifier(frame.id ?? p.frameId ?? p.context?.auxData?.frameId),
    parent_frame: identifier(frame.parentId),
    loader: identifier(frame.loaderId ?? p.loaderId),
    route: routeClass(
      target.url ?? frame.url ?? p.request?.url ?? p.response?.url
    ),
    request: identifier(p.requestId),
    network_request: identifier(p.networkId),
    resource: choice(p.type ?? p.resourceType, [
      "Document",
      "Script",
      "Stylesheet",
      "Fetch",
      "XHR",
      "Image",
      "Font",
      "Other",
      "WebSocket",
    ]),
    status: number(p.response?.status ?? p.responseStatusCode),
    lifecycle: choice(p.name, [
      "init",
      "commit",
      "DOMContentLoaded",
      "load",
      "networkIdle",
      "networkAlmostIdle",
      "firstPaint",
      "firstContentfulPaint",
    ]),
    disposition: choice(p.disposition, [
      "currentTab",
      "newTab",
      "newWindow",
      "download",
    ]),
    execution_context: number(p.context?.id ?? p.executionContextId),
    timestamp: number(p.timestamp),
    encoded_bytes: number(p.encodedDataLength),
    mouse_type: choice(p.type, ["mousePressed", "mouseReleased", "mouseMoved"]),
    modifiers: number(p.modifiers),
    has_error: message.error !== undefined,
    error_code: number(message.error?.code),
  };
}

/** Each file has a hard byte ceiling; all I/O failures disable capture, never the test. */
export function createSink(directory, stem, io = fs) {
  let fd,
    statusFd,
    bytes = 0,
    stopped = false;
  const health = { dropped: 0, io_errors: 0, status_overflow: false };
  const attempt = (fn) => {
    try {
      return fn();
    } catch {
      health.io_errors++;
      stopped = true;
    }
  };
  attempt(() => {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fd = io.openSync(path.join(directory, `${stem}.jsonl`), "wx", 0o600);
    statusFd = io.openSync(
      path.join(directory, `${stem}.status.json`),
      "wx",
      0o600
    );
  });
  return {
    event(record) {
      if (stopped || fd === undefined) {
        health.dropped++;
        return;
      }
      attempt(() => {
        let line = JSON.stringify(record) + "\n";
        if (bytes + Buffer.byteLength(line) > LIMITS.bytes - 256) {
          line =
            JSON.stringify({
              kind: "capture-limit",
              limit_bytes: LIMITS.bytes,
            }) + "\n";
          stopped = true;
          health.dropped++;
        }
        const written = io.writeSync(fd, line);
        bytes += written;
        if (written !== Buffer.byteLength(line))
          throw new Error("partial diagnostic write");
      });
    },
    status(record) {
      if (statusFd === undefined) return;
      attempt(() => {
        let data = JSON.stringify({ ...record, ...health, bytes });
        if (Buffer.byteLength(data) > LIMITS.statusBytes) {
          health.status_overflow = true;
          data = JSON.stringify({ ...health, bytes, kind: "status-limit" });
        }
        io.ftruncateSync(statusFd, 0);
        if (io.writeSync(statusFd, data, 0, "utf8") !== Buffer.byteLength(data))
          throw new Error("partial status write");
      });
    },
    close() {
      for (const handle of [fd, statusFd])
        if (handle !== undefined) attempt(() => io.closeSync(handle));
      stopped = true;
    },
  };
}

export function createCapture(sink) {
  const pending = new Map(),
    contexts = new Set(),
    sessions = new Map(),
    requests = new Map();
  const flags = {
    internal_errors: 0,
    parse_errors: 0,
    state_overflow: 0,
    target_tests: 0,
    modified_clicks: 0,
    protocol_messages: 0,
    closed_pending_commands: 0,
    closed_pending_requests: 0,
  };
  let active = false,
    browser,
    cleanup = [];
  const safe = (fn) => {
    try {
      fn();
    } catch {
      flags.internal_errors++;
    }
  };
  const emit = (record) =>
    sink.event({ wall_ms: Date.now(), mono_ms: performance.now(), ...record });
  const boundedSet = (map, key, value) => {
    if (key === undefined) return;
    if (!map.has(key) && map.size >= LIMITS.entries) {
      flags.state_overflow++;
      return;
    }
    map instanceof Set ? map.add(key) : map.set(key, value);
  };
  const status = (complete = false) =>
    sink.status({
      kind: "worker-status",
      complete,
      active_target_test: active,
      ...flags,
      observed_contexts: [...contexts],
      attached_sessions: [...sessions.values()],
      pending_commands: [...pending.values()],
      pending_requests: [...requests.values()],
    });
  const listen = (emitter, event, fn) => {
    if (cleanup.length >= LIMITS.entries) {
      flags.state_overflow++;
      return;
    }
    const wrapped = (...args) => safe(() => fn(...args));
    emitter.on(event, wrapped);
    cleanup.push(() => emitter.off(event, wrapped));
  };
  const snapshot = (reason, observe = false) => {
    const all = browser.contexts();
    if (all.length > LIMITS.entries) flags.state_overflow++;
    emit({
      kind: "resources",
      reason,
      contexts: all.length,
      pages: all.map((c) => c.pages().length).slice(0, LIMITS.entries),
      observed_contexts: contexts.size,
      attached_sessions: sessions.size,
    });
    if (!observe) return;
    all.slice(0, LIMITS.entries).forEach((context, context_index) => {
      const watch = (page, event) => {
        emit({
          kind: "public-page",
          event,
          context_index,
          route: routeClass(page.url()),
          closed: page.isClosed(),
        });
        for (const name of ["close", "crash", "domcontentloaded", "load"])
          listen(page, name, () =>
            emit({
              kind: "public-page",
              event: name,
              context_index,
              route: routeClass(page.url()),
              closed: page.isClosed(),
            })
          );
      };
      context
        .pages()
        .slice(0, LIMITS.entries)
        .forEach((p) => watch(p, "present-before-click"));
      listen(context, "page", (p) => watch(p, "page"));
      listen(context, "close", () =>
        emit({ kind: "public-context-close", context_index })
      );
    });
  };
  return {
    start() {
      safe(() => status());
    },
    protocol(text) {
      safe(() => {
        if (typeof text !== "string") return;
        const offset = text.indexOf("{");
        const envelope = text.slice(0, offset < 0 ? 256 : offset);
        // debug adds a timestamp/namespace (and sometimes ANSI colours) before the message.
        const direction = envelope.includes("SEND ► ")
          ? "send"
          : envelope.includes("◀ RECV ")
            ? "receive"
            : undefined;
        if (!direction) return;
        // Ignore unneeded payloads before parsing expensive evaluate/DOM replies.
        const prefix = text.slice(offset, offset + 256),
          method = /"method":"([^"]+)"/.exec(prefix)?.[1];
        if (method && !commands.has(method) && !events.has(method)) return;
        const replyId = Number(/"id":(\d+)/.exec(prefix)?.[1]);
        if (
          !method &&
          Number.isFinite(replyId) &&
          ![...pending.values()].some((p) => p.id === replyId)
        )
          return;
        if (offset < 0 || text.length > LIMITS.messageBytes) {
          flags.parse_errors++;
          return;
        }
        let message;
        try {
          message = JSON.parse(text.slice(offset));
        } catch {
          flags.parse_errors++;
          return;
        }
        const key = `${identifier(message.sessionId) ?? "root"}:${message.id}`;
        const sent = pending.get(key);
        const fields = project(
          message,
          message.method ? undefined : sent?.method
        );
        if (!fields) return;
        flags.protocol_messages++;
        if (direction === "send" && commands.has(fields.method))
          boundedSet(pending, key, { ...fields, sent_ms: performance.now() });
        else if (!message.method) {
          pending.delete(key);
          if (
            !fields.has_error &&
            fields.method === "Target.createBrowserContext"
          )
            boundedSet(contexts, fields.context);
          if (
            !fields.has_error &&
            fields.method === "Target.disposeBrowserContext"
          )
            contexts.delete(sent?.context);
        }
        if (fields.method === "Target.attachedToTarget")
          boundedSet(sessions, fields.child_session, {
            session: fields.child_session,
            context: fields.context,
            target: fields.target,
            type: fields.target_type,
          });
        if (fields.method === "Target.detachedFromTarget") {
          sessions.delete(fields.child_session);
          for (const [key, value] of pending)
            if (value.session === fields.child_session) {
              pending.delete(key);
              flags.closed_pending_commands++;
            }
          for (const [key, value] of requests)
            if (value.session === fields.child_session) {
              requests.delete(key);
              flags.closed_pending_requests++;
            }
        }
        if (fields.method === "Target.targetDestroyed")
          for (const [key, value] of sessions)
            if (value.target === fields.target) sessions.delete(key);
        const requestKey = `${fields.session}:${fields.request}`;
        if (fields.method === "Network.requestWillBeSent")
          boundedSet(requests, requestKey, fields);
        if (
          ["Network.loadingFinished", "Network.loadingFailed"].includes(
            fields.method
          )
        )
          requests.delete(requestKey);
        if (
          active &&
          direction === "send" &&
          fields.method === "Input.dispatchMouseEvent" &&
          fields.mouse_type === "mousePressed" &&
          fields.modifiers & (2 | 4)
        ) {
          flags.modified_clicks++;
          snapshot("before-modified-click", flags.modified_clicks === 1);
          status();
        }
        if (active)
          emit({
            kind: "protocol",
            direction,
            reply: !message.method,
            ...fields,
          });
      });
    },
    boundary(who, info, phase) {
      safe(() => {
        browser = who;
        const file = specFile(info.file);
        if (phase === "begin" && file === "social-loans-desktop.spec.ts") {
          active = true;
          flags.target_tests++;
        }
        emit({
          kind: "fixture-test",
          phase,
          file,
          line: number(info.line),
          status: choice(info.status, [
            "passed",
            "failed",
            "timedOut",
            "skipped",
            "interrupted",
          ]),
        });
        snapshot(`test-${phase}`);
        if (phase === "end") {
          for (const remove of cleanup) safe(remove);
          cleanup = [];
          active = false;
        }
        status();
      });
    },
    finish() {
      safe(() => {
        status(true);
        sink.close();
      });
    },
    failed() {
      flags.internal_errors++;
      safe(() => status());
    },
  };
}

let installed;
function destination(env) {
  const phase = choice(path.basename(env.TEST_BROWSER_OUTPUT ?? ""), [
    "parallel",
    "serial",
  ]);
  return env.TEST_LOG_DIR && phase
    ? { directory: path.join(env.TEST_LOG_DIR, "sh02"), phase }
    : undefined;
}
export function installDiagnostics(env = process.env) {
  if (installed) return;
  const output = destination(env);
  if (
    !output ||
    !/^\d+$/.test(env.TEST_WORKER_INDEX ?? "") ||
    !/^\d+$/.test(env.TEST_PARALLEL_INDEX ?? "")
  )
    return;
  const worker = Number(env.TEST_WORKER_INDEX),
    stack = Number(env.TEST_PARALLEL_INDEX);
  if (worker >= LIMITS.workers || stack >= LIMITS.workers) return;
  installed = createCapture(
    createSink(
      output.directory,
      `${output.phase}-worker-${worker}-stack-${stack}`
    )
  );
  installed.start();
  const inheritedDebug = process.env.DEBUG;
  try {
    // verify.py strips DEBUG. Enable the installed singleton here, before browser launch.
    const debug = createRequire(import.meta.url)(
      "playwright-core/lib/utilsBundle"
    ).debug;
    const previous = debug.log;
    debug.log = function (...args) {
      if (this?.namespace === "pw:protocol") {
        // No raw fallback, even if parsing or capture fails.
        installed.protocol(args[0]);
      } else previous.apply(this, args);
    };
    debug.enable([debug.namespaces, "pw:protocol"].filter(Boolean).join(","));
    if (!debug.enabled("pw:protocol")) installed.failed();
  } catch {
    installed.failed();
  } finally {
    // Loading debug and debug.enable save DEBUG. Do not enable raw logging in test subprocesses.
    if (inheritedDebug === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = inheritedDebug;
  }
  process.once("exit", () => installed.finish());
}
export function diagnosticTestBoundary(browser, info, phase) {
  // Called by an automatic harness fixture; instrumentation cannot reject its use/teardown.
  try {
    installed?.boundary(browser, info, phase);
  } catch {
    /* diagnostics only */
  }
}

/** Reporter callbacks provide every test's order, including specs outside the collectors fixture. */
export default class Sh02Reporter {
  constructor() {
    try {
      const output = destination(process.env);
      if (output)
        this.sink = createSink(output.directory, `${output.phase}-order`);
      this.sink?.status({
        kind: "order-status",
        complete: false,
        tests_started: 0,
      });
    } catch {
      /* diagnostics only */
    }
    this.sequence = 0;
    this.sequences = new WeakMap();
  }
  printsToStdio() {
    return false;
  }
  record(phase, test, result) {
    try {
      if (phase === "begin") this.sequences.set(result, ++this.sequence);
      this.sink?.event({
        kind: "test-order",
        wall_ms: Date.now(),
        sequence: this.sequences.get(result),
        phase,
        file: specFile(test.location.file),
        line: number(test.location.line),
        worker: number(result.workerIndex),
        stack: number(result.parallelIndex),
        worker_capture_available:
          result.workerIndex < LIMITS.workers &&
          result.parallelIndex < LIMITS.workers,
        status:
          phase === "end"
            ? choice(result.status, [
                "passed",
                "failed",
                "timedOut",
                "skipped",
                "interrupted",
              ])
            : undefined,
        duration_ms: phase === "end" ? number(result.duration) : undefined,
      });
    } catch {
      /* diagnostics only */
    }
  }
  onTestBegin(test, result) {
    this.record("begin", test, result);
  }
  onTestEnd(test, result) {
    this.record("end", test, result);
  }
  onEnd() {
    try {
      this.sink?.status({
        kind: "order-status",
        complete: true,
        tests_started: this.sequence,
      });
      this.sink?.close();
    } catch {
      /* diagnostics only */
    }
  }
}
