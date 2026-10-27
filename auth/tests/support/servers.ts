// Starting and stopping the servers and databases auth tests make for themselves. Every wait here runs to a deadline,
// not an attempt count, so a loaded host stretches the probes rather than shrinking the budget, and a probe that hangs
// times out on its own. scripts/check_guardrails.py rejects counted loops that sleep in auth/tests.
import { spawn, type ChildProcess } from "node:child_process";
import type { Pool } from "pg";

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The last stderr of each server child, so a crash or a lost port race names its cause instead of a bare timeout.
const stderrTails = new WeakMap<ChildProcess, string>();

/** Spawns a server child in the test's working directory and keeps the tail of its stderr for waitForServer. */
export function launch(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): ChildProcess {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  stderrTails.set(child, "");
  child.stderr!.on("data", (chunk: Buffer) =>
    stderrTails.set(child, (stderrTails.get(child)! + chunk).slice(-2_000))
  );
  return child;
}

// Probes `url` until `accept` takes an answer and returns it. Every miss (a refused connection, a timed-out probe or
// an answer `accept` rejects) waits 100 ms before the next probe, up to a 30 s deadline rather than an attempt count,
// so a cold start on a loaded host still fits. A child that exits first fails at once with its stderr.
export async function waitForServer(
  children: ChildProcess[],
  url: string,
  accept: (response: Response) => boolean,
  init: RequestInit = {}
): Promise<Response | undefined> {
  const deadline = performance.now() + 30_000;
  for (;;) {
    const exited = children.find(
      (child) => child.exitCode !== null || child.signalCode !== null
    );
    if (exited)
      throw new Error(
        `${exited.spawnargs.join(" ")} exited (${exited.exitCode ?? exited.signalCode}) before ${url} answered:\n${stderrTails.get(exited) ?? "(stderr not kept: start the child with launch())"}`
      );
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(5_000),
      });
      if (accept(response)) return response;
      await response.body?.cancel();
    } catch {
      /* not listening yet, or the probe timed out */
    }
    if (performance.now() > deadline) return undefined;
    await sleep(100);
  }
}

/** Waits until `done()` holds, polling every 50 ms up to a 10 s deadline rather than an attempt count, and returns
 * whether it did. For effects that land after the response, such as the API's background operational count. */
export async function waitUntil(done: () => boolean): Promise<boolean> {
  const deadline = performance.now() + 10_000;
  while (!done()) {
    if (performance.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

/** waitForServer for a server that must come up: fails naming `url` when it never answers as `accept` wants (by
 * default with a 2xx status), and discards the answer. */
export async function serverReady(
  children: ChildProcess[],
  url: string,
  accept: (response: Response) => boolean = (response) => response.ok
): Promise<void> {
  const response = await waitForServer(children, url, accept);
  if (!response) throw new Error(`${url} did not answer within 30 s`);
  await response.body?.cancel();
}

/** Drops a database a test created for itself. pool.end() resolves before the server sees every socket close, and a
 * forced drop would terminate a closing client and surface 57P01 as an unhandled error, so this first waits up to 5 s
 * for the database's sessions to go, then drops it WITH (FORCE). */
export async function dropDatabase(admin: Pool, database: string) {
  const deadline = performance.now() + 5_000;
  for (;;) {
    const { rows } = await admin.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1",
      [database]
    );
    if (rows[0].count === 0 || performance.now() > deadline) break;
    await sleep(100);
  }
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}
