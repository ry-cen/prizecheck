import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestPersistOnce } from "./persist";

function setup(persisted: boolean) {
  const mem = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  });
  const storage = {
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => true),
  };
  vi.stubGlobal("navigator", { storage });
  return storage;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("requestPersistOnce", () => {
  it("asks once, then never again", async () => {
    const s = setup(false);
    await requestPersistOnce();
    await requestPersistOnce();
    await requestPersistOnce();
    expect(s.persist).toHaveBeenCalledTimes(1);
  });

  it("does not ask when already persisted, and does not ask later", async () => {
    const s = setup(true);
    await requestPersistOnce();
    await requestPersistOnce();
    expect(s.persist).not.toHaveBeenCalled();
  });

  it("does nothing without the API and never throws", async () => {
    setup(false);
    vi.stubGlobal("navigator", {});
    await expect(requestPersistOnce()).resolves.toBeUndefined();
  });
});
