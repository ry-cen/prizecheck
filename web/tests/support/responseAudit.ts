import type { Page, Response } from "@playwright/test";
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
export const AUDIT_BODY_BUFFER_BYTES = 64 * 1024 * 1024;
type Phase = "open" | "sealed" | "draining" | "finished" | "disposed";
type RequestInfo = { method: string; url: string };
type Result = { body: string } | { aborted: string } | { error: unknown };
type Events = {
  started: (request: object, info: RequestInfo) => void;
  response: (request: object, response: ReadableResponse) => void;
  failed: (request: object, reason: string | null) => void;
  awaitingHeaders: () => object[];
  documentReplaced: (requests: object[]) => void;
  invalidate: (error: Error) => void;
};
type Entry = {
  info: RequestInfo;
  stage: "headers" | "orphaned" | "body" | "settled";
  outcome?: Result;
  transportError?: Error;
};
export const DOCUMENT_REPLACED = "document replaced before any response";
const DISCARDED = "application navigation discarded response";
export function routeShape(info: RequestInfo): string {
  const url = new URL(info.url);
  return `${info.method} ${url.pathname + url.search}`.replace(
    /[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,
    ":id"
  );
}
/** Owned body reads win; finish commits proof and dispose abandons it. */
export function responseAudit(
  subscribe: (events: Events) => () => void,
  onSeal: () => void | Promise<void> = () => {}
) {
  const requests = new Map<object, Entry>();
  const aborted: { request: object; reason: string }[] = [];
  let phase: Phase = "open";
  let invalid: Error | undefined;
  const sealEvidence: Entry = {
    info: { method: "CDP", url: "seal evidence" },
    stage: "settled",
  };
  // External disposal can change phase across await boundaries.
  const isDisposed = () => phase === "disposed";
  let completed: Promise<string[]> | undefined;
  let drained: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const owed = () =>
    [...requests.values(), sealEvidence].filter(
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
    if (phase !== "sealed" && phase !== "draining") return;
    if (timer !== undefined || !owed().length) return;
    timer = setTimeout(() => {
      const unfinished = owed();
      const error = new Error(
        `Privacy audit requests did not finish within ${AUDIT_DRAIN_TIMEOUT_MS}ms:\n` +
          unfinished
            .map(
              ({ info, stage }) =>
                `${info.method} ${info.url} (awaiting ${stage})`
            )
            .join("\n")
      );
      for (const entry of unfinished) settle(entry, { error });
    }, AUDIT_DRAIN_TIMEOUT_MS);
  };
  let unsubscribe = subscribe({
    invalidate(error) {
      if (phase === "finished" || phase === "disposed") return;
      invalid ??= error;
      for (const entry of owed()) settle(entry, { error });
    },
    started(request, info) {
      if (phase === "finished" || phase === "disposed") return;
      if (phase !== "open" && sealEvidence.stage !== "body") return;
      if (requests.has(request)) return;
      requests.set(request, { info: { ...info }, stage: "headers" });
    },
    response(request, response) {
      const entry = requests.get(request);
      if (phase === "disposed" || phase === "finished" || !entry) return;
      if (entry.stage !== "headers" && entry.stage !== "orphaned") return;
      entry.stage = "body";
      armDeadline();
      // Handle rejection now, while retaining it as a failed final proof.
      void bodyOf(response).then(
        (body) => {
          if (entry.transportError)
            settle(entry, { error: entry.transportError });
          else if (body === null) settle(entry, { aborted: DISCARDED });
          else settle(entry, { body });
        },
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
    const sealing = onSeal();
    if (sealing) {
      sealEvidence.stage = "body";
      void sealing.then(
        () => {
          clearDeadline();
          settle(sealEvidence, { body: "" });
          armDeadline();
        },
        (error) => settle(sealEvidence, { error })
      );
    }
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
  const drain = async () => {
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
      const records: typeof aborted = [];
      const addError = (error: unknown) => {
        if (!errors.includes(error)) errors.push(error);
      };
      for (const [request, entry] of requests) {
        if (entry.stage === "orphaned") {
          if (shapes.has(routeShape(entry.info))) {
            records.push({ request, reason: DOCUMENT_REPLACED });
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
        if ("error" in result) addError(result.error);
        else if ("aborted" in result)
          records.push({ request, reason: result.aborted });
        else bodies.push(result.body);
      }
      if (invalid) addError(invalid);
      const evidence = sealEvidence.outcome;
      if (evidence && "error" in evidence) addError(evidence.error);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(
          errors,
          "Privacy audit failed:\n" + errors.map(String).join("\n")
        );
      aborted.push(...records);
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
      completed = drain();
      return completed;
    },
  };
}
export type AuditedHop = { method: string; url: string };
type End = "finished" | "failed" | "cut";
type Hop = AuditedHop & {
  requestId: string;
  loaderId: string;
  received: number;
  answered: boolean;
  ended: Promise<End>;
  end: (reason: End) => void;
};
/** One CDP requestId owns each hop; Playwright responses provide only a floor.
 * Read ended hops through durable storage; delivered bytes are inspected or fail.
 * Only a hop's own absent loader in a complete tree can exclude unanswered data.
 * Session close invalidates evidence; public lifecycle events prove no identity. */
export async function auditPage(
  page: Page,
  include: (url: string) => boolean,
  onBody?: (response: { url(): string }) => void
): Promise<ReturnType<typeof responseAudit>> {
  const cdp = await page.context().newCDPSession(page);
  const hops = new Map<string, Hop>();
  let admissionOpen = true;
  const playwrightResponses = new Map<string, number>(),
    cdpResponses = new Map<string, number>();
  const count = (map: Map<string, number>, url: string) =>
    map.set(url, (map.get(url) ?? 0) + 1);
  const observed = (response: Response) => {
    if (include(response.url())) count(playwrightResponses, response.url());
  };
  let events!: Events;
  const admit = (requestId: string, loaderId: string, info: AuditedHop) => {
    let end!: (reason: End) => void;
    const ended = new Promise<End>((resolve) => {
      end = resolve;
    });
    const hop: Hop = {
      ...info,
      requestId,
      loaderId,
      received: 0,
      answered: false,
      ended,
      end,
    };
    hops.set(requestId, hop);
    events.started(hop, info);
    return hop;
  };
  const read = async (hop: Hop) => {
    const ended = await hop.ended;
    try {
      const { body, base64Encoded } = await cdp.send(
        "Network.getResponseBody",
        { requestId: hop.requestId }
      );
      let text = body;
      if (base64Encoded) text = Buffer.from(body, "base64").toString();
      onBody?.({ url: () => hop.url });
      return text;
    } catch (error) {
      if (hop.received > 0)
        throw new Error(
          `Privacy audit could not read a delivered body: ${hop.method} ${hop.url}: ${String(error)}`
        );
      if (ended === "finished") return "";
      throw new Error(
        `${hop.url} was navigated away from before any byte arrived`
      );
    }
  };
  type Tree = { frame: { loaderId: string }; childFrames?: Tree[] };
  const loaders = (tree: Tree): string[] => [
    tree.frame.loaderId,
    ...(tree.childFrames ?? []).flatMap(loaders),
  ];
  const seal = async () => {
    const { frameTree } = await cdp.send("Page.getFrameTree").finally(() => {
      admissionOpen = false;
    });
    const live = new Set(loaders(frameTree).filter(Boolean));
    const dead = (hop: Hop) =>
      live.size > 0 && !!hop.loaderId && !live.has(hop.loaderId);
    events.documentReplaced((events.awaitingHeaders() as Hop[]).filter(dead));
    for (const hop of hops.values())
      if (hop.answered && dead(hop)) hop.end("cut");
    for (const [url, total] of playwrightResponses)
      if (total > (cdpResponses.get(url) ?? 0))
        events.invalidate(
          new Error(
            `Privacy audit floor: Playwright saw ${total} response(s) the session did not: ${url}`
          )
        );
  };
  const audit = responseAudit((listener) => {
    events = listener;
    cdp.on("Network.requestWillBeSent", (event) => {
      const { requestId, loaderId, request } = event;
      const redirectResponse = event.redirectResponse;
      if (redirectResponse && include(redirectResponse.url))
        count(cdpResponses, redirectResponse.url);
      const prior = hops.get(requestId);
      if (prior) {
        hops.delete(requestId);
        prior.answered = true;
        events.response(prior, {
          text: async () => {
            throw new Error(
              `Response body is unavailable for redirect responses: ${prior.url}`
            );
          },
        });
      }
      if (admissionOpen && include(request.url))
        admit(requestId, loaderId, {
          url: request.url,
          method: request.method,
        });
    });
    cdp.on("Network.responseReceived", ({ requestId, loaderId, response }) => {
      const known = hops.get(requestId);
      if (!include(response.url) || (!admissionOpen && !known)) return;
      count(cdpResponses, response.url);
      const hop =
        known ?? admit(requestId, loaderId, { url: response.url, method: "?" });
      hop.answered = true;
      events.response(hop, { text: () => read(hop) });
    });
    cdp.on("Network.dataReceived", ({ requestId, dataLength }) => {
      const hop = hops.get(requestId);
      if (hop) hop.received += dataLength;
    });
    cdp.on("Network.loadingFinished", ({ requestId }) => {
      hops.get(requestId)?.end("finished");
      hops.delete(requestId);
    });
    cdp.on("Network.loadingFailed", (event) => {
      const { requestId, errorText, blockedReason } = event;
      const hop = hops.get(requestId);
      if (hop) {
        events.failed(hop, errorText || blockedReason || null);
        hop.end("failed");
        hops.delete(requestId);
      }
    });
    const closeEvents = cdp as unknown as {
      on(event: "close", listener: () => void): void;
      off(event: "close", listener: () => void): void;
      removeAllListeners(): void;
    };
    const closedError = new Error(
      "Privacy audit CDP session closed before the proof finished"
    );
    const closed = () => events.invalidate(closedError);
    closeEvents.on("close", closed);
    return () => {
      closeEvents.off("close", closed);
      closeEvents.removeAllListeners();
      page.off("response", observed);
      void cdp.detach().catch(() => {});
    };
  }, seal);
  try {
    await cdp.send("Network.enable", {
      maxTotalBufferSize: AUDIT_BODY_BUFFER_BYTES,
      enableDurableMessages: true,
    });
  } catch (error) {
    audit.dispose();
    throw error;
  }
  page.on("response", observed);
  return audit;
}
