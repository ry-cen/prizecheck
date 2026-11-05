import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { Pool } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { signInAsOwner } from "../../tests/support/sign-in";
import { signInOtherCollector } from "../../tests/support/collectors";

vi.mock("../../tests/support/sign-in", () => ({ signInAsOwner: vi.fn() }));
beforeEach(() => {
  vi.stubEnv("VERIFY_BROWSER_STACKS", "unit-fixture-only");
  vi.mocked(signInAsOwner).mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
function fixture() {
  const session = vi.fn(async () => ({
    json: async () => ({ userId: "collector" }),
  }));
  const page = { request: { get: session } } as unknown as Page;
  const close = vi.fn(async () => {});
  const context = {
    newPage: async () => page,
    close,
  } as unknown as BrowserContext;
  const browser = { newContext: async () => context } as unknown as Browser;
  const query = vi.fn(async () => ({ rows: [] }));
  const pool = { query } as unknown as Pool;
  return { browser, pool, page, context, close, session, query };
}
it("awaits audit attachment before sign-in can start any application read", async () => {
  const f = fixture();
  let attached!: () => void;
  const ready = new Promise<void>((resolve) => {
    attached = resolve;
  });
  const beforeSignIn = vi.fn(async () => {
    await ready;
  });
  const collector = signInOtherCollector(f.browser, f.pool, {
    next: "/collection",
    beforeSignIn,
  });
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
  expect(beforeSignIn).toHaveBeenCalledExactlyOnceWith(f.page);
  expect(signInAsOwner).not.toHaveBeenCalled();
  expect(f.session).not.toHaveBeenCalled();
  attached();
  expect(await collector).toEqual({
    context: f.context,
    page: f.page,
    userId: "collector",
  });
  expect(signInAsOwner).toHaveBeenCalledExactlyOnceWith(f.page, "/collection");
  expect(f.close).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenCalledTimes(2);
});
it("an attachment failure closes the new context before any sign-in or read", async () => {
  const f = fixture();
  const failure = new Error("audit attachment failed");
  await expect(
    signInOtherCollector(f.browser, f.pool, {
      beforeSignIn: async () => {
        throw failure;
      },
    })
  ).rejects.toBe(failure);
  expect(signInAsOwner).not.toHaveBeenCalled();
  expect(f.session).not.toHaveBeenCalled();
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.query).toHaveBeenCalledTimes(1);
});
it("callers without instrumentation keep the existing sign-in and owner retirement", async () => {
  const f = fixture();
  expect(await signInOtherCollector(f.browser, f.pool)).toEqual({
    context: f.context,
    page: f.page,
    userId: "collector",
  });
  expect(signInAsOwner).toHaveBeenCalledExactlyOnceWith(f.page, "/collection");
  expect(f.session).toHaveBeenCalledTimes(1);
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.close).not.toHaveBeenCalled();
});
