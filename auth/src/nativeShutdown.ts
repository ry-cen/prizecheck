// One shutdown for SIGTERM and SIGINT while native sign-in is on (and only then; with the switch off the gateway keeps the
// default signal behaviour). The first signal stops HTTP intake, drains what is in flight until a deadline (then drops the
// remaining connections), closes the native pool exactly once and exits. A second signal, of either kind, does nothing.
export type ShutdownServer = {
  close: (done: () => void) => unknown;
  closeIdleConnections: () => void;
  closeAllConnections: () => void;
};

export function createShutdown(options: {
  server: ShutdownServer;
  pool: { end: () => Promise<void> };
  exit: (code: number) => void;
  drainMs?: number;
  poolMs?: number;
}): () => Promise<void> {
  const drainMs = options.drainMs ?? 5_000;
  const poolMs = options.poolMs ?? 3_000;
  let stopping: Promise<void> | undefined;
  return () => {
    stopping ??= (async () => {
      const closed = new Promise<void>((resolve) =>
        options.server.close(() => resolve())
      );
      options.server.closeIdleConnections();
      const timer = setTimeout(
        () => options.server.closeAllConnections(),
        drainMs
      );
      await closed;
      clearTimeout(timer);
      // The pool's own timeouts end abandoned queries; do not wait on them forever.
      let poolTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        options.pool.end().catch(() => {}),
        new Promise<void>((resolve) => {
          poolTimer = setTimeout(resolve, poolMs);
        }),
      ]);
      if (poolTimer) clearTimeout(poolTimer);
      options.exit(0);
    })();
    return stopping;
  };
}
