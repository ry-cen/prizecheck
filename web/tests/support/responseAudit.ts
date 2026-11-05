import type { Page, Request, Response } from "@playwright/test";

/** Only the response-body capability is needed; no browser is owned by this audit. */
type ReadableResponse = { text: () => Promise<string> };

/** Null only for a read Chromium discarded during application navigation. Other failures remain test failures. */
export function bodyOf(response: ReadableResponse): Promise<string | null> {
  return response.text().catch((error: Error) => {
    if (/navigated away from/.test(error.message)) return null;
    throw error;
  });
}

type Result = { body: string } | { aborted: string } | { error: unknown };
type Events = {
  started: (request: object) => void;
  response: (request: object, response: ReadableResponse) => void;
  failed: (request: object, reason: string | null) => void;
};

/** Seal request admission at the journey boundary, not response arrival. Every
 * admitted request remains owned through its body or an accounted navigation
 * abort. Fixture cleanup is allowed only after finish; dispose abandons proof. */
export function responseAudit(subscribe: (events: Events) => () => void) {
  const requests = new Map<
    object,
    {
      result: Promise<Result>;
      settle: (result: Result) => void;
      responding: boolean;
    }
  >();
  const aborted: { request: object; reason: string }[] = [];
  let sealed = false;
  let disposed = false;
  let completed: Promise<string[]> | undefined;
  const unsubscribe = subscribe({
    started(request) {
      if (sealed || requests.has(request)) return;
      let settle!: (result: Result) => void;
      const result = new Promise<Result>((resolve) => {
        settle = resolve;
      });
      requests.set(request, { result, settle, responding: false });
    },
    response(request, response) {
      const entry = requests.get(request);
      if (disposed || !entry || entry.responding) return;
      entry.responding = true;
      // Rejection is handled immediately, but still fails the final proof.
      void bodyOf(response).then(
        (body) =>
          entry.settle(
            body === null
              ? { aborted: "application navigation discarded response" }
              : { body }
          ),
        (error) => entry.settle({ error })
      );
    },
    failed(request, reason) {
      const entry = requests.get(request);
      if (disposed || !entry || entry.responding) return;
      entry.settle(
        reason === "net::ERR_ABORTED"
          ? { aborted: reason }
          : {
              error: new Error(
                `Unexpected audited request failure: ${reason ?? "unknown"}`
              ),
            }
      );
    },
  });
  const stop = () => {
    sealed = true;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    sealed = true;
    unsubscribe();
    // Failed journeys must not leak listeners or leave unresolved promises.
    for (const entry of requests.values())
      entry.settle({
        error: new Error("Privacy audit disposed before completion"),
      });
  };
  return {
    stop,
    dispose,
    get abortedRequests() {
      return [...aborted];
    },
    finish(): Promise<string[]> {
      if (completed) return completed;
      if (disposed)
        return Promise.reject(new Error("Privacy audit was abandoned"));
      stop();
      completed = (async () => {
        try {
          const results = await Promise.all(
            [...requests.values()].map((entry) => entry.result)
          );
          const bodies: string[] = [];
          let index = 0;
          for (const request of requests.keys()) {
            const result = results[index++];
            if ("error" in result) throw result.error;
            if ("aborted" in result)
              aborted.push({ request, reason: result.aborted });
            else bodies.push(result.body);
          }
          return bodies;
        } finally {
          dispose();
        }
      })();
      return completed;
    },
  };
}

/** Preserve each story's request scope and optional successful-body identity proof. */
export function auditPage(
  page: Page,
  include: (url: string) => boolean,
  onBody?: (response: Response) => void
) {
  return responseAudit((events) => {
    const started = (request: Request) => {
      if (include(request.url())) events.started(request);
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
