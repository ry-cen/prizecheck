import type { Frame, Page, Request, Response } from "@playwright/test";

type ReadableResponse = { text: () => Promise<string> };

/** Null only for a body Chromium explicitly discarded during navigation. */
export function bodyOf(response: ReadableResponse): Promise<string | null> {
  return response.text().catch((error: Error) => {
    if (/navigated away from/.test(error.message)) return null;
    throw error;
  });
}

// Hosted max API latency was 474 ms; the slowest passing journey used 81.3 of 90 s.
export const AUDIT_DRAIN_TIMEOUT_MS = 5_000;
type Phase = "open" | "sealed" | "draining" | "finished" | "disposed";
type RequestInfo = { method: string; url: string };
type Result = { body: string } | { aborted: string } | { error: unknown };
type Events = {
  started: (request: object, info: RequestInfo) => void;
  response: (request: object, response: ReadableResponse) => void;
  failed: (request: object, reason: string | null) => void;
  awaitingHeaders: () => object[];
  documentReplaced: (requests: object[]) => void;
};
type Entry = {
  info: RequestInfo;
  stage: "headers" | "orphaned" | "body" | "settled";
  outcome?: Result;
  transportError?: Error;
};

export const DOCUMENT_REPLACED = "document replaced before any response";

export function routeShape(info: RequestInfo): string {
  const url = new URL(info.url);
  return `${info.method} ${url.pathname + url.search}`.replace(
    /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,
    ":id"
  );
}

/** Inspect every audited body delivered to a document of this viewer. Only a
 * confirmed document replacement can exclude an unanswered request, with an
 * inspected same-route floor. Live requests remain owed; an observed body read
 * owns its outcome over transport events. Sealing closes admission, finished
 * commits proof, and disposal abandons it. All owned reads stay bounded. */
export function responseAudit(subscribe: (events: Events) => () => void) {
  const requests = new Map<object, Entry>();
  const aborted: { request: object; reason: string }[] = [];
  let phase: Phase = "open";
  // Read across await boundaries: external disposal may change the phase even
  // when TypeScript narrows the surrounding continuation to draining.
  const isDisposed = () => phase === "disposed";
  let completed: Promise<string[]> | undefined;
  let drained: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const owed = () =>
    [...requests.values()].filter(
      (entry) => entry.stage === "headers" || entry.stage === "body"
    );
  const clearDeadline = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const checkDrained = () => {
    if (!owed().length) {
      clearDeadline();
      drained?.();
    }
  };
  const settle = (entry: Entry, result: Result) => {
    if (entry.stage === "settled") return;
    entry.stage = "settled";
    entry.outcome = result;
    checkDrained();
  };
  const armDeadline = () => {
    if (
      (phase !== "sealed" && phase !== "draining") ||
      timer !== undefined ||
      !owed().length
    )
      return;
    timer = setTimeout(() => {
      const unfinished = owed();
      const error = new Error(
        `Privacy audit requests did not finish within ${AUDIT_DRAIN_TIMEOUT_MS}ms:\n` +
          unfinished
            .map(
              (entry) =>
                `${entry.info.method} ${entry.info.url} (awaiting ${entry.stage})`
            )
            .join("\n")
      );
      for (const entry of unfinished) settle(entry, { error });
    }, AUDIT_DRAIN_TIMEOUT_MS);
  };
  let unsubscribe = subscribe({
    started(request, info) {
      if (phase !== "open" || requests.has(request)) return;
      requests.set(request, { info: { ...info }, stage: "headers" });
    },
    response(request, response) {
      const entry = requests.get(request);
      if (
        phase === "disposed" ||
        phase === "finished" ||
        !entry ||
        (entry.stage !== "headers" && entry.stage !== "orphaned")
      )
        return;
      entry.stage = "body";
      armDeadline();
      // Handle rejection now, while retaining it as a failed final proof.
      void bodyOf(response).then(
        (body) =>
          settle(
            entry,
            entry.transportError
              ? { error: entry.transportError }
              : body === null
                ? { aborted: "application navigation discarded response" }
                : { body }
          ),
        (error) => settle(entry, { error })
      );
    },
    failed(request, reason) {
      const entry = requests.get(request);
      if (phase === "disposed" || phase === "finished" || !entry) return;
      if (entry.stage === "settled") return;
      const error =
        reason === "net::ERR_ABORTED"
          ? undefined
          : new Error(
              `Unexpected audited request failure: ${reason ?? "unknown"} (${entry.info.method} ${entry.info.url})`
            );
      if (entry.stage === "body") {
        if (error && !entry.transportError) entry.transportError = error;
        return;
      }
      settle(entry, error ? { error } : { aborted: "net::ERR_ABORTED" });
    },
    awaitingHeaders() {
      return [...requests]
        .filter(([, entry]) => entry.stage === "headers")
        .map(([request]) => request);
    },
    documentReplaced(identities) {
      if (phase === "finished" || phase === "disposed") return;
      for (const request of identities) {
        const entry = requests.get(request);
        if (entry?.stage === "headers") entry.stage = "orphaned";
      }
      checkDrained();
    },
  });
  const cleanup = () => {
    clearDeadline();
    unsubscribe();
    unsubscribe = () => {};
  };
  const stop = () => {
    if (phase !== "open") return;
    phase = "sealed";
    armDeadline();
  };
  const dispose = () => {
    if (phase === "finished" || phase === "disposed") {
      cleanup();
      return;
    }
    phase = "disposed";
    cleanup();
    drained?.();
  };
  return {
    stop,
    dispose,
    get phase() {
      return phase;
    },
    get abortedRequests() {
      return [...aborted];
    },
    finish(): Promise<string[]> {
      if (phase === "disposed")
        return Promise.reject(new Error("Privacy audit was abandoned"));
      if (completed) return completed;
      stop();
      phase = "draining";
      completed = (async () => {
        try {
          do {
            await new Promise<void>((resolve) => {
              drained = resolve;
              checkDrained();
            });
          } while (!isDisposed() && owed().length);
          if (isDisposed())
            throw new Error("Privacy audit disposed before completion");
          const shapes = new Set<string>();
          for (const entry of requests.values())
            if (entry.outcome && "body" in entry.outcome)
              shapes.add(routeShape(entry.info));
          const bodies: string[] = [];
          const errors: unknown[] = [];
          const excluded: string[] = [];
          for (const [request, entry] of requests) {
            if (entry.stage === "orphaned") {
              if (shapes.has(routeShape(entry.info))) {
                aborted.push({ request, reason: DOCUMENT_REPLACED });
                excluded.push(`${entry.info.method} ${entry.info.url}`);
              } else
                errors.push(
                  new Error(
                    `Privacy audit excluded a request with no inspected response on its route: ${entry.info.method} ${entry.info.url}`
                  )
                );
              continue;
            }
            const result = entry.outcome!;
            if ("error" in result) {
              if (!errors.includes(result.error)) errors.push(result.error);
            } else if ("aborted" in result)
              aborted.push({ request, reason: result.aborted });
            else bodies.push(result.body);
          }
          if (errors.length === 1) throw errors[0];
          if (errors.length > 1)
            throw new AggregateError(
              errors,
              "Privacy audit failed:\n" +
                errors.map((error) => String(error)).join("\n")
            );
          if (excluded.length)
            console.info(
              `privacy audit excluded ${excluded.length} undelivered request(s): ` +
                excluded.join(", ")
            );
          phase = "finished";
          return bodies;
        } catch (error) {
          if (!isDisposed()) phase = "finished";
          throw error;
        } finally {
          cleanup();
        }
      })();
      return completed;
    },
  };
}

/** Keep each story's request predicate and successful-detail identity proof. */
export function auditPage(
  page: Page,
  include: (url: string) => boolean,
  onBody?: (response: Response) => void
) {
  return responseAudit((events) => {
    const isMainDocument = (request: Request) => {
      if (!request.isNavigationRequest()) return false;
      try {
        return request.frame() === page.mainFrame();
      } catch {
        return false;
      }
    };
    let navigating: string | undefined;
    let cut: object[] | undefined;
    const navigated = (frame: Frame) => {
      if (frame !== page.mainFrame() || frame.url() !== navigating || cut)
        return;
      cut = events.awaitingHeaders();
    };
    const loaded = () => {
      if (!cut) return;
      events.documentReplaced(cut);
      cut = navigating = undefined;
    };
    const started = (request: Request) => {
      if (isMainDocument(request)) {
        navigating = request.url();
        cut = undefined;
      }
      if (include(request.url()))
        events.started(request, {
          method: request.method(),
          url: request.url(),
        });
    };
    const receive = (response: Response) =>
      events.response(response.request(), {
        text: async () => {
          const body = await response.text();
          onBody?.(response);
          return body;
        },
      });
    const failed = (request: Request) =>
      events.failed(request, request.failure()?.errorText ?? null);
    page.on("framenavigated", navigated);
    page.on("domcontentloaded", loaded);
    page.on("request", started);
    page.on("response", receive);
    page.on("requestfailed", failed);
    return () => {
      page.off("framenavigated", navigated);
      page.off("domcontentloaded", loaded);
      page.off("request", started);
      page.off("response", receive);
      page.off("requestfailed", failed);
    };
  });
}
