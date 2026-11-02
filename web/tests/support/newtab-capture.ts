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

export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol === "http:" || url.protocol === "https:")
      return url.origin + url.pathname;
    return url.protocol === "about:"
      ? `about:${url.pathname}`
      : `[${url.protocol}]`;
  } catch {
    return "[invalid URL]";
  }
}

/** Deliberately excludes headers, bodies, source, titles, console messages and arbitrary result objects. */
export function protocolFields(message: Message) {
  const p = message.params ?? {};
  const target = p.targetInfo ?? {};
  const frame = p.frame ?? {};
  const response = p.response ?? {};
  const request = p.request ?? {};
  const aux = p.context?.auxData ?? {};
  return {
    childSessionId: p.sessionId,
    targetId: target.targetId ?? p.targetId,
    browserContextId: target.browserContextId,
    openerId: target.openerId,
    targetType: target.type,
    targetUrl: safeUrl(target.url),
    frameId: frame.id ?? p.frameId ?? aux.frameId,
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
    lifecycle: message.method === "Page.lifecycleEvent" ? p.name : undefined,
    encodedDataLength: p.encodedDataLength,
    canceled: p.canceled,
    errorCode: message.error?.code,
    hasError: !!message.error,
    reply: message.id !== undefined && message.method === undefined,
  };
}

const EVENTS =
  /^(Target\.(targetCreated|attachedToTarget|targetInfoChanged|detachedFromTarget|targetDestroyed)|Page\.(frameNavigated|lifecycleEvent|frameStartedLoading|frameStoppedLoading|frameRequestedNavigation)|Network\.(requestWillBeSent|responseReceived|loadingFinished|loadingFailed)|Runtime\.(executionContextCreated|executionContextDestroyed|executionContextsCleared))$/;
const COMMANDS = /^(Target|Page|Runtime|Emulation|Network|Fetch|Log|Browser)\./;

export class Capture {
  entries: object[] = [];
  pending = new Map<string, string>();
  dropped = 0;
  oversized = 0;
  unparseable = 0;
  record(event: string, data: object = {}) {
    if (this.entries.length >= 12000) {
      this.dropped++;
      return;
    }
    this.entries.push({
      atMs: Date.now(),
      monotonicMs: performance.now(),
      event,
      ...data,
    });
  }
  protocol(raw: string) {
    if (raw.length > 128 * 1024) {
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
    const method = message.method ?? this.pending.get(key);
    if (!method) return;
    if (message.id !== undefined) {
      if (direction === "send" && COMMANDS.test(method)) {
        if (this.pending.size >= 12000) {
          this.dropped++;
          return;
        }
        this.pending.set(key, method);
      } else if (direction === "receive" && this.pending.has(key))
        this.pending.delete(key);
      else return;
    } else if (!EVENTS.test(method)) return;
    this.record("protocol", {
      direction,
      id: message.id,
      method,
      sessionId: message.sessionId,
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
      const cpu = process.cpuUsage();
      const loop = performance.eventLoopUtilization();
      const watch = (on: Page) => {
        if (pages.has(on)) return;
        const id = `page-${pages.size}`;
        pages.set(on, id);
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
          method: request.method(),
          navigation: request.isNavigationRequest(),
          type: request.resourceType(),
        };
        requests.set(request, data);
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
      capture.record("start", {
        pid: process.pid,
        workerIndex: testInfo.workerIndex,
        parallelIndex: testInfo.parallelIndex,
        repeatEachIndex: testInfo.repeatEachIndex,
        retry: testInfo.retry,
        workers: testInfo.config.workers,
      });
      try {
        await use({
          mark: (event, expectedUrl) => {
            if (event === "before-click") {
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
            capture.record(event, {
              expectedUrl: safeUrl(expectedUrl),
              openerUrl: safeUrl(page.url()),
              openerClosed: page.isClosed(),
              viewport: page.viewportSize(),
              cpu: process.cpuUsage(cpu),
              eventLoop: performance.eventLoopUtilization(loop),
              pending: [...requests.values()],
              pages: context
                .pages()
                .map((p) => ({ id: pages.get(p), url: safeUrl(p.url()) })),
              serviceWorkers: context
                .serviceWorkers()
                .map((w) => safeUrl(w.url())),
            });
            if (event === "url-assertions-passed") restore();
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
        capture.record("end", {
          status: testInfo.status,
          dropped: capture.dropped,
          oversized: capture.oversized,
          unparseable: capture.unparseable,
          pendingProtocolCommands: [...capture.pending].map(([id, method]) => ({
            id,
            method,
          })),
          pendingRequests: [...requests.values()],
          cpu: process.cpuUsage(cpu),
          eventLoop: performance.eventLoopUtilization(loop),
        });
        try {
          const path = testInfo.outputPath("newtab-capture.json");
          writeFileSync(
            path,
            JSON.stringify(
              {
                formatVersion: 1,
                dropped: capture.dropped,
                oversized: capture.oversized,
                unparseable: capture.unparseable,
                pendingProtocolCommands: [...capture.pending].map(
                  ([id, method]) => ({ id, method })
                ),
                events: capture.entries,
              },
              null,
              2
            )
          );
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
