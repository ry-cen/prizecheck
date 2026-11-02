// Disposable diagnostics for diag/loans-newtab-capture; never merge this adapter into the harness.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Page, Request } from "@playwright/test";
import { test as base } from "./collectors";

type Message = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code?: number };
};
type Debug = {
  namespaces?: string;
  enable: (namespaces?: string) => void;
  save: (namespaces?: string) => void;
  log: (this: { namespace?: string }, ...args: unknown[]) => void;
};

// Bounds apply to retained state as well as the compact serialized attachment.
export const LIMITS = {
  fieldBytes: 256,
  eventBytes: 8192,
  totalBytes: 512 * 1024,
  events: 4000,
  pending: 256,
  requests: 128,
  pages: 16,
  items: 32,
  snapshots: 8,
} as const;

export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:") {
      // Only explicitly known static routes may survive; never echo an unknown path component.
      const parts = url.pathname.split("/").filter(Boolean);
      const first = parts[0] ?? "";
      const staticRoutes = new Set([
        "loans",
        "published",
        "invite",
        "collection",
        "decks",
        "settings",
        "friends",
        "trades",
        "catalog",
        "sign-in",
        "api",
        "auth",
        "assets",
      ]);
      let path = first
        ? staticRoutes.has(first)
          ? `/${first}`
          : "/<redacted>"
        : "/";
      if (parts.length > 1 && staticRoutes.has(first)) {
        path +=
          first === "loans"
            ? "/:id"
            : first === "published" || first === "invite"
              ? "/:token"
              : "/<redacted>";
      }
      // Even a hostname can contain an invite/token. Keep only known local test origins.
      const origin = [
        "localhost",
        "127.0.0.1",
        "[::1]",
        "redacted.invalid",
      ].includes(url.hostname)
        ? url.origin
        : `${url.protocol}//redacted.invalid`;
      return origin + path;
    }
    return value === "about:blank" ? value : `[${url.protocol}]`;
  } catch {
    return "[invalid URL]";
  }
}

// Commands have NO permitted parameter/result payload fields. Only the shared envelope below
// (direction/id/method/sessionId/reply/hasError/errorCode) is retained for these exact methods.
export const COMMAND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "Target.setAutoAttach": [],
  "Target.attachToTarget": [],
  "Target.detachFromTarget": [],
  "Page.enable": [],
  "Page.getFrameTree": [],
  "Page.createIsolatedWorld": [],
  "Page.setLifecycleEventsEnabled": [],
  "Page.addScriptToEvaluateOnNewDocument": [],
  "Page.setInterceptFileChooserDialog": [],
  "Runtime.enable": [],
  "Runtime.addBinding": [],
  "Runtime.runIfWaitingForDebugger": [],
  "Log.enable": [],
  "Network.enable": [],
  "Network.setCacheDisabled": [],
  "Network.setExtraHTTPHeaders": [],
  "Fetch.enable": [],
  "Emulation.setFocusEmulationEnabled": [],
  "Emulation.setDeviceMetricsOverride": [],
  "Emulation.setTouchEmulationEnabled": [],
  "Emulation.setUserAgentOverride": [],
  "Emulation.setLocaleOverride": [],
  "Emulation.setTimezoneOverride": [],
  "Emulation.setEmulatedMedia": [],
  "Emulation.setEmulatedVisionDeficiency": [],
  "Emulation.setDefaultBackgroundColorOverride": [],
  "Emulation.setFontFamilies": [],
  "Browser.getWindowForTarget": [],
};
const EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "Target.targetCreated": [
    "targetId",
    "browserContextId",
    "openerId",
    "targetType",
    "targetUrl",
  ],
  "Target.attachedToTarget": [
    "childSessionId",
    "targetId",
    "browserContextId",
    "openerId",
    "targetType",
    "targetUrl",
    "waitingForDebugger",
  ],
  "Target.targetInfoChanged": [
    "targetId",
    "browserContextId",
    "openerId",
    "targetType",
    "targetUrl",
  ],
  "Target.detachedFromTarget": ["childSessionId", "targetId"],
  "Target.targetDestroyed": ["targetId"],
  "Page.frameNavigated": ["frameId", "parentFrameId", "loaderId", "frameUrl"],
  "Page.lifecycleEvent": ["frameId", "loaderId", "timestamp", "lifecycle"],
  "Page.frameStartedLoading": ["frameId"],
  "Page.frameStoppedLoading": ["frameId"],
  "Page.frameRequestedNavigation": ["frameId", "disposition"],
  "Network.requestWillBeSent": [
    "requestId",
    "frameId",
    "loaderId",
    "requestUrl",
    "requestMethod",
    "resourceType",
    "timestamp",
    "wallTime",
  ],
  "Network.responseReceived": [
    "requestId",
    "loaderId",
    "requestUrl",
    "resourceType",
    "timestamp",
    "status",
  ],
  "Network.loadingFinished": ["requestId", "timestamp", "encodedDataLength"],
  "Network.loadingFailed": [
    "requestId",
    "timestamp",
    "resourceType",
    "canceled",
  ],
  "Runtime.executionContextCreated": ["executionContextId", "frameId"],
  "Runtime.executionContextDestroyed": ["executionContextId"],
  "Runtime.executionContextsCleared": [],
};

/** Deliberately excludes headers, bodies, source, titles, console messages and arbitrary results. */
export function protocolFields(message: Message) {
  const p = message.params ?? {};
  const target = p.targetInfo ?? {};
  const frame = p.frame ?? {};
  const response = p.response ?? {};
  const request = p.request ?? {};
  const projected: Record<string, unknown> = {
    childSessionId: p.sessionId,
    targetId: target.targetId ?? p.targetId,
    browserContextId: target.browserContextId,
    openerId: target.openerId,
    targetType: target.type,
    targetUrl: safeUrl(target.url),
    frameId: frame.id ?? p.frameId ?? p.context?.auxData?.frameId,
    parentFrameId: frame.parentId,
    waitingForDebugger: p.waitingForDebugger,
    disposition: p.disposition,
    executionContextId: p.context?.id ?? p.executionContextId,
    loaderId: frame.loaderId ?? p.loaderId,
    frameUrl: safeUrl(frame.url),
    requestId: p.requestId,
    requestUrl: safeUrl(request.url ?? response.url),
    requestMethod: request.method,
    resourceType: p.type,
    status: response.status,
    timestamp: p.timestamp,
    wallTime: p.wallTime,
    lifecycle: p.name,
    encodedDataLength: p.encodedDataLength,
    canceled: p.canceled,
  };
  const fields = Object.hasOwn(EVENT_FIELDS, message.method ?? "")
    ? EVENT_FIELDS[message.method!]
    : [];
  return Object.fromEntries(
    fields.map((key) => {
      const value = projected[key];
      return [
        key,
        typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
          ? value
          : undefined,
      ];
    })
  );
}

export function remember<K, V>(
  map: Map<K, V>,
  key: K,
  value: V,
  limit: number
): boolean {
  if (!map.has(key) && map.size >= limit) return false;
  map.set(key, value);
  return true;
}

// Every recording path, including nested snapshots and protocol projections, passes through
// an exact schema. Schema keys are trusted constants; rejected names/values are counted, never echoed.
type Fields = Readonly<Record<string, Field>>;
type Field =
  | { kind: "text" | "url" | "number" | "boolean" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "object"; fields: Fields; nullable?: boolean }
  | { kind: "array"; item: Field };
const text: Field = { kind: "text" };
const url: Field = { kind: "url" };
const number: Field = { kind: "number" };
const boolean: Field = { kind: "boolean" };
const enumeration = (...values: string[]): Field => ({ kind: "enum", values });
const object = (fields: Fields, nullable = false): Field => ({
  kind: "object",
  fields,
  nullable,
});
const array = (item: Field): Field => ({ kind: "array", item });
const cpuFields = { user: number, system: number };
const loopFields = { idle: number, active: number, utilization: number };
const requestFields = {
  id: number,
  page: text,
  url,
  method: text,
  navigation: boolean,
  type: text,
};
const commandMethod = enumeration(...Object.keys(COMMAND_FIELDS));
const snapshotFields = {
  expectedUrl: url,
  openerUrl: url,
  openerClosed: boolean,
  viewport: object({ width: number, height: number }, true),
  cpu: object(cpuFields),
  eventLoop: object(loopFields),
  pending: array(object(requestFields)),
  pages: array(object({ id: text, url })),
  serviceWorkers: array(url),
};
const PUBLIC_FIELDS: Readonly<Record<string, Fields>> = {
  "context.page": { page: text, url, opener: boolean },
  framenavigated: { page: text, main: boolean, url },
  load: { page: text, url },
  domcontentloaded: { page: text, url },
  close: { page: text },
  crash: { page: text },
  request: requestFields,
  requestfinished: { id: number },
  requestfailed: { id: number },
  response: { id: number, status: number, url },
  serviceworker: { url },
  "browser-disconnected": {},
  start: {
    pid: number,
    workerIndex: number,
    parallelIndex: number,
    repeatEachIndex: number,
    retry: number,
    workers: number,
  },
  "protocol-unavailable": {
    reason: enumeration(
      "existing debug namespaces; left untouched",
      "logger enable failed",
      "unsupported installed adapter"
    ),
  },
  "protocol-window-start": { version: enumeration("1.63.0") },
  "before-click": snapshotFields,
  "click-completed": snapshotFields,
  "page-event-delivered": snapshotFields,
  "url-assertions-passed": snapshotFields,
  "window-ended": snapshotFields,
  end: {
    status: enumeration(
      "url-assertions-passed",
      "window-ended",
      "passed",
      "failed",
      "timedOut",
      "skipped",
      "interrupted"
    ),
    dropped: number,
    oversized: number,
    unparseable: number,
    pendingProtocolCommands: array(object({ id: text, method: commandMethod })),
    pendingRequests: array(object(requestFields)),
    cpu: object(cpuFields),
    eventLoop: object(loopFields),
  },
};
// The event-method allowlist above selects a subset of these exact, typed output fields.
const PROTOCOL_FIELDS: Fields = {
  childSessionId: text,
  targetId: text,
  browserContextId: text,
  openerId: text,
  targetType: text,
  targetUrl: url,
  frameId: text,
  parentFrameId: text,
  waitingForDebugger: boolean,
  disposition: text,
  executionContextId: number,
  loaderId: text,
  frameUrl: url,
  requestId: text,
  requestUrl: url,
  requestMethod: text,
  resourceType: text,
  status: number,
  timestamp: number,
  wallTime: number,
  lifecycle: text,
  encodedDataLength: number,
  canceled: boolean,
};
const protocolEnvelope: Fields = {
  direction: enumeration("send", "receive"),
  id: number,
  method: enumeration(
    ...Object.keys(COMMAND_FIELDS),
    ...Object.keys(EVENT_FIELDS)
  ),
  sessionId: text,
  errorCode: number,
  hasError: boolean,
  reply: boolean,
};

export class Capture {
  entries: object[] = [];
  pending = new Map<string, string>();
  dropped = 0;
  oversized = 0;
  unparseable = 0;
  rejectedEvents = 0;
  rejectedFields = 0;
  rejectedValues = 0;
  active = false;
  finished = false;
  private bytes = 0;
  private snapshots = 0;
  start() {
    if (!this.finished) this.active = true;
  }
  stop() {
    this.active = false;
    this.finished = true;
  }
  private project(value: unknown, field: Field, depth = 0): unknown {
    if (value === undefined) return undefined; // Optional fields are omitted, not rejected.
    if (depth >= 5) {
      this.oversized++;
      return undefined;
    }
    if (field.kind === "object" && field.nullable && value === null)
      return null;
    if (
      (field.kind === "text" || field.kind === "url") &&
      typeof value === "string"
    ) {
      const projected =
        field.kind === "url" ||
        /^(https?:|data:|javascript:|about:)/i.test(value)
          ? safeUrl(value)!
          : value;
      if (Buffer.byteLength(projected) <= LIMITS.fieldBytes) return projected;
      this.oversized++;
      let result = "";
      for (const char of projected) {
        if (Buffer.byteLength(result + char) > LIMITS.fieldBytes) break;
        result += char;
      }
      return result;
    }
    if (
      field.kind === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)
    )
      return value;
    if (field.kind === "boolean" && typeof value === "boolean") return value;
    if (
      field.kind === "enum" &&
      typeof value === "string" &&
      field.values.includes(value)
    )
      return value;
    if (field.kind === "array" && Array.isArray(value)) {
      if (value.length > LIMITS.items) this.oversized++;
      return value.slice(0, LIMITS.items).flatMap((item) => {
        const projected = this.project(item, field.item, depth + 1);
        return projected === undefined ? [] : [projected];
      });
    }
    if (
      field.kind === "object" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      const data = value as Record<string, unknown>;
      // Do not read unlisted values, including accessors. Never retain rejected names.
      for (const key of Object.keys(data))
        if (!Object.hasOwn(field.fields, key)) this.rejectedFields++;
      return Object.fromEntries(
        Object.entries(field.fields).flatMap(([key, schema]) => {
          if (!Object.hasOwn(data, key)) return [];
          const projected = this.project(data[key], schema, depth + 1);
          return projected === undefined ? [] : [[key, projected]];
        })
      );
    }
    this.rejectedValues++;
    return undefined;
  }
  record(event: string, data: object = {}) {
    if (!this.active) return;
    let fields: Fields;
    if (event === "protocol") {
      const method = (data as { method?: unknown }).method;
      if (
        typeof method !== "string" ||
        (!Object.hasOwn(COMMAND_FIELDS, method) &&
          !Object.hasOwn(EVENT_FIELDS, method))
      ) {
        this.rejectedValues++;
        this.dropped++;
        return;
      }
      const selected = Object.hasOwn(EVENT_FIELDS, method)
        ? EVENT_FIELDS[method]
        : [];
      fields = {
        ...protocolEnvelope,
        ...Object.fromEntries(
          selected.map((key) => [key, PROTOCOL_FIELDS[key]])
        ),
      };
    } else if (Object.hasOwn(PUBLIC_FIELDS, event))
      fields = PUBLIC_FIELDS[event];
    else {
      this.rejectedEvents++;
      this.dropped++;
      return;
    }
    const projected = this.project(data, object(fields));
    if (projected === undefined) {
      this.dropped++;
      return;
    }
    const entry = {
      atMs: Date.now(),
      monotonicMs: performance.now(),
      event,
      data: projected,
    };
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    // Reserve 1 KiB for the fixed envelope/counters; compact serialization uses this same encoding.
    if (
      bytes > LIMITS.eventBytes ||
      this.bytes + bytes > LIMITS.totalBytes - 1024 ||
      this.entries.length >= LIMITS.events
    ) {
      this.dropped++;
      return;
    }
    this.entries.push(entry);
    this.bytes += bytes;
  }
  snapshot(event: string, data: object) {
    if (!this.active) return;
    if (this.snapshots >= LIMITS.snapshots) {
      this.dropped++;
      return;
    }
    this.snapshots++;
    this.record(event, data);
  }
  serialize() {
    return JSON.stringify({
      formatVersion: 2,
      dropped: this.dropped,
      oversized: this.oversized,
      unparseable: this.unparseable,
      rejectedEvents: this.rejectedEvents,
      rejectedFields: this.rejectedFields,
      rejectedValues: this.rejectedValues,
      events: this.entries,
    });
  }
  protocol(raw: string) {
    if (!this.active) return;
    if (Buffer.byteLength(raw) > 128 * 1024) {
      this.oversized++;
      return;
    }
    const match = /(SEND ► |◀ RECV )(\{.*\})/s.exec(raw);
    if (!match) return;
    let message: Message;
    try {
      message = JSON.parse(match[2]);
    } catch {
      this.unparseable++;
      return;
    }
    const direction = match[1].startsWith("SEND") ? "send" : "receive";
    const key = `${message.sessionId ?? "root"}:${message.id}`;
    if (Buffer.byteLength(key) > LIMITS.fieldBytes) {
      this.oversized++;
      return;
    }
    const method = message.method ?? this.pending.get(key);
    if (!method) return;
    if (message.id !== undefined) {
      if (direction === "send" && Object.hasOwn(COMMAND_FIELDS, method)) {
        if (!remember(this.pending, key, method, LIMITS.pending)) {
          this.dropped++;
          return;
        }
      } else if (
        direction === "receive" &&
        !message.method &&
        this.pending.has(key)
      )
        this.pending.delete(key);
      else return;
    } else if (!Object.hasOwn(EVENT_FIELDS, method)) return;
    this.record("protocol", {
      direction,
      id: typeof message.id === "number" ? message.id : undefined,
      method,
      sessionId:
        typeof message.sessionId === "string" ? message.sessionId : undefined,
      errorCode:
        typeof message.error?.code === "number"
          ? message.error.code
          : undefined,
      hasError: !!message.error,
      reply: message.id !== undefined && message.method === undefined,
      ...protocolFields(message),
    });
  }
}

/** Observe the existing logger only. Never create/attach a CDP session or issue a browser command. */
export function observeProtocol(debug: Debug, capture: Capture): () => void {
  if (debug.namespaces) {
    capture.record("protocol-unavailable", {
      reason: "existing debug namespaces; left untouched",
    });
    return () => {};
  }
  const log = debug.log;
  const namespaces = debug.namespaces;
  const enable = (value?: string) => {
    const save = debug.save;
    debug.save = () => {};
    try {
      debug.enable(value);
    } finally {
      debug.save = save;
    }
  };
  debug.log = function (...args) {
    if (this.namespace !== "pw:protocol") return log.apply(this, args);
    // Observation must never throw into Playwright's connection dispatch.
    try {
      if (typeof args[0] === "string") capture.protocol(args[0]);
    } catch {
      capture.unparseable++;
    }
  };
  try {
    enable("pw:protocol");
  } catch {
    debug.log = log;
    enable(namespaces);
    capture.record("protocol-unavailable", { reason: "logger enable failed" });
    return () => {};
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    debug.log = log;
    enable(namespaces);
  };
}

type Observation = { mark: (event: string, expectedUrl?: string) => void };

export const test = base.extend<{ newTabCapture: Observation }>({
  newTabCapture: [
    async ({ page, context, browser }, use, testInfo) => {
      const capture = new Capture();
      const requests = new Map<
        Request,
        {
          id: number;
          page?: string;
          url?: string;
          method: string;
          navigation: boolean;
          type: string;
        }
      >();
      const pages = new Map<Page, string>();
      const removers: (() => void)[] = [];
      let requestId = 0;
      let restore = () => {};
      let cpu = process.cpuUsage();
      let loop = performance.eventLoopUtilization();
      const watch = (on: Page) => {
        if (capture.finished || pages.has(on)) return;
        const id = `page-${pages.size}`;
        if (!remember(pages, on, id, LIMITS.pages)) {
          if (capture.active) capture.dropped++;
          return;
        }
        capture.record("context.page", {
          page: id,
          url: safeUrl(on.url()),
          opener: on === page,
        });
        const navigated = (frame: import("@playwright/test").Frame) =>
          capture.record("framenavigated", {
            page: id,
            main: frame === on.mainFrame(),
            url: safeUrl(frame.url()),
          });
        const load = () =>
          capture.record("load", { page: id, url: safeUrl(on.url()) });
        const dom = () =>
          capture.record("domcontentloaded", {
            page: id,
            url: safeUrl(on.url()),
          });
        const close = () => capture.record("close", { page: id });
        const crash = () => capture.record("crash", { page: id });
        on.on("framenavigated", navigated);
        on.on("load", load);
        on.on("domcontentloaded", dom);
        on.on("close", close);
        on.on("crash", crash);
        removers.push(() => {
          on.off("framenavigated", navigated);
          on.off("load", load);
          on.off("domcontentloaded", dom);
          on.off("close", close);
          on.off("crash", crash);
        });
      };
      const requested = (request: Request) => {
        if (capture.finished) return;
        let owner: string | undefined;
        try {
          owner = pages.get(request.frame().page());
        } catch {
          /* worker requests have no page frame */
        }
        const data = {
          id: ++requestId,
          page: owner,
          url: safeUrl(request.url()),
          method: request.method().slice(0, LIMITS.fieldBytes),
          navigation: request.isNavigationRequest(),
          type: request.resourceType().slice(0, LIMITS.fieldBytes),
        };
        if (!remember(requests, request, data, LIMITS.requests)) {
          if (capture.active) capture.dropped++;
          return;
        }
        capture.record("request", data);
      };
      const finished = (request: Request) => {
        capture.record("requestfinished", { id: requests.get(request)?.id });
        requests.delete(request);
      };
      const failed = (request: Request) => {
        capture.record("requestfailed", { id: requests.get(request)?.id });
        requests.delete(request);
      };
      const responded = (response: import("@playwright/test").Response) =>
        capture.record("response", {
          id: requests.get(response.request())?.id,
          status: response.status(),
          url: safeUrl(response.url()),
        });
      const worker = (value: import("@playwright/test").Worker) =>
        capture.record("serviceworker", { url: safeUrl(value.url()) });
      const disconnected = () => capture.record("browser-disconnected");
      context.pages().forEach(watch);
      context.on("page", watch);
      context.on("request", requested);
      context.on("requestfinished", finished);
      context.on("requestfailed", failed);
      context.on("response", responded);
      context.on("serviceworker", worker);
      browser.on("disconnected", disconnected);
      const startData = {
        pid: process.pid,
        workerIndex: testInfo.workerIndex,
        parallelIndex: testInfo.parallelIndex,
        repeatEachIndex: testInfo.repeatEachIndex,
        retry: testInfo.retry,
        workers: testInfo.config.workers,
      };
      try {
        await use({
          mark: (event, expectedUrl) => {
            if (
              event === "before-click" &&
              !capture.active &&
              !capture.finished
            ) {
              capture.start();
              cpu = process.cpuUsage();
              loop = performance.eventLoopUtilization();
              capture.record("start", startData);
              try {
                const require = createRequire(import.meta.url);
                const version = require("playwright-core/package.json").version;
                const { debug } = require("playwright-core/lib/utilsBundle");
                if (
                  version !== "1.63.0" ||
                  typeof debug.enable !== "function" ||
                  typeof debug.save !== "function" ||
                  typeof debug.log !== "function"
                )
                  throw new Error("unsupported adapter");
                restore = observeProtocol(debug, capture);
                capture.record("protocol-window-start", { version });
              } catch {
                capture.record("protocol-unavailable", {
                  reason: "unsupported installed adapter",
                });
              }
            }
            capture.snapshot(event, {
              expectedUrl: safeUrl(expectedUrl),
              openerUrl: safeUrl(page.url()),
              openerClosed: page.isClosed(),
              viewport: page.viewportSize(),
              cpu: process.cpuUsage(cpu),
              eventLoop: performance.eventLoopUtilization(loop),
              pending: [...requests.values()].slice(0, LIMITS.items),
              pages: context
                .pages()
                .slice(0, LIMITS.pages)
                .map((p) => ({ id: pages.get(p), url: safeUrl(p.url()) })),
              serviceWorkers: context
                .serviceWorkers()
                .slice(0, LIMITS.items)
                .map((w) => safeUrl(w.url())),
            });
            if (event === "url-assertions-passed" || event === "window-ended") {
              capture.snapshot("end", {
                status: event,
                pendingProtocolCommands: [...capture.pending]
                  .slice(0, LIMITS.items)
                  .map(([id, method]) => ({ id, method })),
                pendingRequests: [...requests.values()].slice(0, LIMITS.items),
              });
              capture.stop();
              restore();
            }
          },
        });
      } finally {
        restore();
        context.off("page", watch);
        context.off("request", requested);
        context.off("requestfinished", finished);
        context.off("requestfailed", failed);
        context.off("response", responded);
        context.off("serviceworker", worker);
        browser.off("disconnected", disconnected);
        removers.forEach((remove) => remove());
        capture.snapshot("end", {
          status: testInfo.status,
          dropped: capture.dropped,
          oversized: capture.oversized,
          unparseable: capture.unparseable,
          pendingProtocolCommands: [...capture.pending]
            .slice(0, LIMITS.items)
            .map(([id, method]) => ({
              id,
              method,
            })),
          pendingRequests: [...requests.values()].slice(0, LIMITS.items),
          cpu: process.cpuUsage(cpu),
          eventLoop: performance.eventLoopUtilization(loop),
        });
        capture.stop();
        requests.clear();
        pages.clear();
        try {
          const path = testInfo.outputPath("newtab-capture.json");
          writeFileSync(path, capture.serialize());
          await testInfo.attach("newtab-capture", {
            path,
            contentType: "application/json",
          });
        } catch {
          console.warn("newtab capture attachment unavailable");
        }
      }
    },
    { auto: true },
  ],
});
