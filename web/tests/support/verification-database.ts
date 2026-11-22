// TEST ONLY. The browser journeys that sign in through the OAuth fake clear `auth_rate_event` and the fake gateway
// writes identity and session rows into whatever auth database it is given. Pointing that at a developer's own
// loopback database (a bare `DATABASE_URL` in a direct Playwright run) would change it, so the connected Riftbound proof
// uses only the disposable database the selected verification worker provides (VERIFY_BROWSER_STACKS, as applied by
// ./browser-stack). Diagnostics never carry a URL.
import { approvedParts } from "./riftbound-dsn";

type Environment = Record<string, string | undefined>;

export class NotVerificationDatabase extends Error {}

/**
 * `candidate`, only if it is the DATABASE_URL of the verification stack this worker (TEST_PARALLEL_INDEX) runs on.
 * Throws NotVerificationDatabase otherwise, before anything connects.
 */
export function requireVerificationDatabase(
  candidate: string | undefined,
  environment: Environment = process.env
): string {
  const refuse = (why: string) =>
    new NotVerificationDatabase(
      `${why}; run this spec through npm run verify, which supplies a disposable database`
    );
  const stacks = environment.VERIFY_BROWSER_STACKS;
  const index = environment.TEST_PARALLEL_INDEX;
  if (!stacks || index === undefined)
    throw refuse("not running under a verification worker");
  let own: unknown;
  try {
    own = (JSON.parse(stacks) as Record<string, unknown>[])[Number(index)]
      ?.DATABASE_URL;
  } catch {
    throw refuse("the verification stacks are unreadable");
  }
  if (typeof own !== "string" || !own)
    throw refuse("this worker has no verification database");
  // Compared by parts, so the stack's canonical DSN (which adds the default port) matches the worker's raw one.
  let same = false;
  try {
    const a = approvedParts(candidate ?? "");
    const b = approvedParts(own);
    same =
      a.username === b.username &&
      a.password === b.password &&
      a.hostname === b.hostname &&
      a.port === b.port &&
      a.database === b.database;
  } catch {
    same = false;
  }
  if (!same)
    throw refuse(
      "the auth database is not this worker's verification database"
    );
  return candidate as string;
}
