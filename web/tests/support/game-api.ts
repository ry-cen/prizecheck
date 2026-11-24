import type { Page, Request } from "@playwright/test";

/**
 * Counts every request to a game-scoped API path in both URL forms, `/api/pokemon/<path>` and the retained
 * `/api/<path>`, so a count or "never asked" assertion also catches a client that still calls the old URL.
 * Stubs stay on the new path alone; this only observes, it never answers. A `*` in `path` stands for one segment.
 */
export function watchGameApi(page: Page, path: string) {
  const watch = {
    /** The `edition_ids` of each request body, in request order (new and old URL alike). */
    batches: [] as string[][],
    /** The JSON body of each request, in request order (null when there is none). */
    bodies: [] as unknown[],
    /** The pathname of each request, in request order. */
    paths: [] as string[],
    /** Requests sent but not yet finished or failed, in either URL form. */
    inFlight: 0,
    /** The most requests in flight at once since the watch began or the last `clear()`. */
    peak: 0,
    /**
     * Forgets what was seen so far, keeping the same arrays. Requests already in flight stay counted until they
     * settle (so none is decremented twice or below zero); the peak restarts from the current in-flight count.
     */
    clear() {
      watch.batches.length = 0;
      watch.bodies.length = 0;
      watch.paths.length = 0;
      watch.peak = watch.inFlight;
    },
  };
  // Keyed per Request, so a request that both finishes and is reported failed is only released once.
  const open = new Set<Request>();
  const escaped = path
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]+");
  const forms = new RegExp(`^/api/(pokemon/)?${escaped}$`);
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!forms.test(pathname)) return;
    const body = request.postDataJSON() as { edition_ids?: string[] } | null;
    watch.paths.push(pathname);
    watch.bodies.push(body);
    watch.batches.push(body?.edition_ids ?? []);
    open.add(request);
    watch.inFlight = open.size;
    watch.peak = Math.max(watch.peak, watch.inFlight);
  });
  const settle = (request: Request) => {
    if (open.delete(request)) watch.inFlight = open.size;
  };
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  return watch;
}
