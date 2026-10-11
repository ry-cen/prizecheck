/**
 * The verification gate starts one application stack per Playwright worker and passes every stack's settings as JSON
 * in VERIFY_BROWSER_STACKS (scripts/verify_resources.py). Playwright sets TEST_PARALLEL_INDEX in a worker before the
 * worker loads playwright.config.ts, and loads the config before any spec, so the specs' module-level reads of
 * TEST_ORIGIN, DATABASE_URL, MAIL_FILE and the rest see this worker's own stack. Outside the gate nothing changes.
 */
export function applyBrowserStack(): void {
  const stacks = process.env.VERIFY_BROWSER_STACKS;
  const index = process.env.TEST_PARALLEL_INDEX;
  if (!stacks || index === undefined) return;
  const stack = (JSON.parse(stacks) as Record<string, string>[])[Number(index)];
  if (!stack)
    throw new Error(
      `No verification stack for Playwright parallel index ${index}`
    );
  Object.assign(process.env, stack);
}
