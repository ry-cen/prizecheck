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

export class Capture {
  entries: object[] = [];
  pending = new Map<string, string>();
  dropped = 0;
  oversized = 0;
  unparseable = 0;
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
  private bounded(value: unknown, depth = 0): unknown {
    if (typeof value === "string") {
      const text = /^(https?:|data:|javascript:|about:)/i.test(value)
        ? safeUrl(value)!
        : value;
      if (Buffer.byteLength(text) <= LIMITS.fieldBytes) return text;
      this.oversized++;
      let result = "";
      for (const char of text) {
        if (Buffer.byteLength(result + char) > LIMITS.fieldBytes) break;
        result += char;
      }
      return result;
    }
    if (typeof value === "number")
      return Number.isFinite(value) ? value : undefined;
    if (typeof value === "boolean" || value === null) return value;
    if (depth >= 5) {
      this.oversized++;
      return undefined;
    }
    if (Array.isArray(value)) {
      if (value.length > LIMITS.items) this.oversized++;
      return value
        .slice(0, LIMITS.items)
        .map((v) => this.bounded(v, depth + 1));
    }
    if (typeof value === "object" && value) {
      const entries = Object.entries(value);
      if (entries.length > LIMITS.items) this.oversized++;
      return Object.fromEntries(
        entries.slice(0, LIMITS.items).flatMap(([key, v]) => {
          // Defense in depth for public records as well as protocol projections.
          if (/^(headers?|cookies?|body|postData|source|title)$/i.test(key))
            return [];
          const safe = /url$/i.test(key) ? safeUrl(v) : v;
          return [
            [this.bounded(key, depth + 1), this.bounded(safe, depth + 1)],
          ];
        })
      );
    }
    return undefined;
  }
  record(event: string, data: object = {}) {
    if (!this.active) return;
    const entry = {
      atMs: Date.now(),
      monotonicMs: performance.now(),
      event: this.bounded(event),
      data: this.bounded(data),
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
