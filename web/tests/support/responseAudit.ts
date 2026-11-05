import type { Page, Request, Response } from "@playwright/test";

type ReadableResponse = { text: () => Promise<string> };

/** Null only for a body Chromium explicitly discarded during navigation. */
export function bodyOf(response: ReadableResponse): Promise<string | null> {
  return response.text().catch((error: Error) => {
    if (/navigated away from/.test(error.message)) return null;
    throw error;
  });
}

export const AUDIT_DRAIN_TIMEOUT_MS = 5_000;
type Phase = "open" | "sealed" | "draining" | "finished" | "disposed";
type RequestInfo = { method: string; url: string };
type Result = { body: string } | { aborted: string } | { error: unknown };
type Events = {
  started: (request: object, info: RequestInfo) => void;
  response: (request: object, response: ReadableResponse) => void;
  failed: (request: object, reason: string | null) => void;
};
type Entry = {
  info: RequestInfo;
  stage: "headers" | "body" | "settled";
  result: Promise<Result>;
  resolve: (result: Result) => void;
};

/** open admits identities; sealed fixes membership and starts the bounded drain;
 * draining owes every body/explicit abort/error. finished commits an immutable
 * result and cleans up. disposed abandons every unfinished proof, even settled
 * inputs. Missing terminal events fail with method/URL, never imply an abort. */
export function responseAudit(subscribe: (events: Events) => () => void) {
  const requests = new Map<object, Entry>();
  const aborted: { request: object; reason: string }[] = [];
  let phase: Phase = "open";
  // Read across await boundaries: external disposal may change the phase even
  // when TypeScript narrows the surrounding continuation to draining.
  const isDisposed = () => phase === "disposed";
  let completed: Promise<string[]> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = () =>
    [...requests.values()].filter((entry) => entry.stage !== "settled");
  const clearDeadline = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const settle = (entry: Entry, result: Result) => {
    if (entry.stage === "settled") return;
    entry.stage = "settled";
    entry.resolve(result);
    if (!pending().length) clearDeadline();
  };
  let unsubscribe = subscribe({
    started(request, info) {
      if (phase !== "open" || requests.has(request)) return;
      let resolve!: (result: Result) => void;
      const result = new Promise<Result>((yes) => {
        resolve = yes;
      });
      requests.set(request, {
        info: { ...info },
        stage: "headers",
        result,
        resolve,
      });
    },
    response(request, response) {
      const entry = requests.get(request);
      if (
        phase === "disposed" ||
        phase === "finished" ||
        !entry ||
        entry.stage !== "headers"
      )
        return;
      entry.stage = "body";
      // Handle rejection now, while retaining it as a failed final proof.
      void bodyOf(response).then(
        (body) =>
          settle(
            entry,
            body === null
              ? { aborted: "application navigation discarded response" }
              : { body }
          ),
        (error) => settle(entry, { error })
      );
    },
    failed(request, reason) {
      const entry = requests.get(request);
      if (phase === "disposed" || phase === "finished" || !entry) return;
      // A real terminal event applies before or after headers. It never replaces
      // an earlier terminal outcome, and no missing event is guessed from a URL.
      settle(
        entry,
        reason === "net::ERR_ABORTED"
          ? { aborted: reason }
          : {
              error: new Error(
                `Unexpected audited request failure: ${reason ?? "unknown"} (${entry.info.method} ${entry.info.url})`
              ),
            }
      );
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
    if (!pending().length) return;
    timer = setTimeout(() => {
      const unfinished = pending();
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
  const dispose = () => {
    if (phase === "finished" || phase === "disposed") {
      cleanup();
      return;
    }
    phase = "disposed";
    cleanup();
    for (const entry of requests.values())
      settle(entry, {
        error: new Error("Privacy audit disposed before completion"),
      });
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
          const results = await Promise.all(
            [...requests.values()].map((entry) => entry.result)
          );
          // Promise settlement is not proof commitment. Disposal can happen in
          // this gap, including with zero inputs or already-completed bodies.
          if (isDisposed())
            throw new Error("Privacy audit disposed before completion");
          const bodies: string[] = [];
          const errors: unknown[] = [];
          let index = 0;
          for (const request of requests.keys()) {
            const result = results[index++];
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
    const started = (request: Request) => {
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
    page.on("request", started);
    page.on("response", receive);
    page.on("requestfailed", failed);
    return () => {
      page.off("request", started);
      page.off("response", receive);
      page.off("requestfailed", failed);
    };
  });
}
