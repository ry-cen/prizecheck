/** Only the response-body capability is needed; no browser is owned by this audit. */
type ReadableResponse = { text: () => Promise<string> };

/** Null only for a read Chromium discarded during application navigation. Other failures remain test failures. */
export function bodyOf(response: ReadableResponse): Promise<string | null> {
  return response.text().catch((error: Error) => {
    if (/navigated away from/.test(error.message)) return null;
    throw error;
  });
}

/** A privacy audit owns its listener until the journey ends, then detaches before draining every captured read. */
export function responseAudit(
  subscribe: (capture: (response: ReadableResponse) => void) => () => void
) {
  const reads: Promise<{ body: string | null } | { error: unknown }>[] = [];
  let stopped = false;
  const unsubscribe = subscribe((response) => {
    if (stopped) return;
    // Attach the rejection handler immediately. Drain still throws every error;
    // an early body failure must not become an unhandled teardown rejection.
    reads.push(
      bodyOf(response).then(
        (body) => ({ body }),
        (error) => ({ error })
      )
    );
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
  };
  return {
    stop,
    async finish(): Promise<string[]> {
      stop();
      const results = await Promise.all(reads);
      const bodies: string[] = [];
      for (const result of results) {
        if ("error" in result) throw result.error;
        if (result.body !== null) bodies.push(result.body);
      }
      return bodies;
    },
  };
}
