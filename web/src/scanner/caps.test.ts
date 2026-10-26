import { afterEach, describe, expect, it, vi } from "vitest";
import { checkCaps } from "./caps";

class FakeWorker {
  constructor(_url: string, options?: { type?: string }) {
    void options?.type;
  }
  terminate() {}
}
class FakeCanvas {
  getContext(kind: string) {
    return kind === "2d" ? {} : null;
  }
}

function supported() {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("OffscreenCanvas", FakeCanvas);
  vi.stubGlobal("createImageBitmap", () => undefined);
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: () => undefined },
    locks: {},
  });
  vi.stubGlobal("caches", {});
  vi.stubGlobal("DecompressionStream", class {});
  vi.stubGlobal("self", { crossOriginIsolated: true });
}

afterEach(() => vi.unstubAllGlobals());

describe("checkCaps", () => {
  it("accepts a browser with everything", () => {
    supported();
    expect(checkCaps()).toMatchObject({ ok: true, missing: [] });
  });

  const cases: [string, string, () => void][] = [
    ["Worker", "module-Worker", () => vi.stubGlobal("Worker", undefined)],
    [
      "classic-only Worker",
      "module-Worker",
      () =>
        vi.stubGlobal(
          "Worker",
          class {
            terminate() {}
          }
        ),
    ],
    [
      "OffscreenCanvas",
      "OffscreenCanvas",
      () => vi.stubGlobal("OffscreenCanvas", undefined),
    ],
    [
      "OffscreenCanvas 2d",
      "OffscreenCanvas",
      () =>
        vi.stubGlobal(
          "OffscreenCanvas",
          class {
            getContext() {
              return null;
            }
          }
        ),
    ],
    [
      "createImageBitmap",
      "createImageBitmap",
      () => vi.stubGlobal("createImageBitmap", undefined),
    ],
    [
      "getUserMedia",
      "getUserMedia",
      () => vi.stubGlobal("navigator", { locks: {} }),
    ],
    ["crypto.subtle", "crypto.subtle", () => vi.stubGlobal("crypto", {})],
    ["caches", "caches", () => vi.stubGlobal("caches", undefined)],
    [
      "navigator.locks",
      "navigator.locks",
      () =>
        vi.stubGlobal("navigator", {
          mediaDevices: { getUserMedia: () => undefined },
        }),
    ],
    [
      "DecompressionStream",
      "DecompressionStream",
      () => vi.stubGlobal("DecompressionStream", undefined),
    ],
  ];
  for (const [name, flag, breakIt] of cases)
    it(`reports ${name} missing`, () => {
      supported();
      breakIt();
      const caps = checkCaps();
      expect(caps.ok).toBe(false);
      expect(caps.missing).toContain(flag);
    });

  it("reports missing SIMD", () => {
    supported();
    vi.spyOn(WebAssembly, "validate").mockReturnValue(false);
    expect(checkCaps().missing).toContain("wasm-simd");
    vi.restoreAllMocks();
  });

  it("needs isolation only for threads", () => {
    supported();
    vi.stubGlobal("self", { crossOriginIsolated: false });
    expect(checkCaps(1).ok).toBe(true);
    expect(checkCaps(2).missing).toContain("crossOriginIsolated");
  });
});
