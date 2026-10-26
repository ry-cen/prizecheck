import { afterEach, describe, expect, it, vi } from "vitest";
import { threadCount } from "./threads";

afterEach(() => vi.unstubAllGlobals());

function stub(isolated: boolean, cores: number | undefined): void {
  vi.stubGlobal("self", { crossOriginIsolated: isolated });
  vi.stubGlobal("navigator", { hardwareConcurrency: cores });
}

describe("threadCount", () => {
  it("is 1 when the worker is not cross-origin isolated", () => {
    stub(false, 8);
    expect(threadCount()).toBe(1);
  });
  it("is the core count up to 4 when isolated", () => {
    stub(true, 8);
    expect(threadCount()).toBe(4);
    stub(true, 2);
    expect(threadCount()).toBe(2);
    stub(true, 4);
    expect(threadCount()).toBe(4);
  });
  it("falls back to 1 when the core count is unknown", () => {
    stub(true, undefined);
    expect(threadCount()).toBe(1);
  });
});
