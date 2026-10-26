import { describe, expect, it } from "vitest";
import { cameraCause, loadCause } from "./startFailure";

describe("why the scanner cannot start", () => {
  it("names a denied camera and a missing camera", () => {
    expect(cameraCause(new DOMException("x", "NotAllowedError"))).toBe(
      "denied"
    );
    expect(cameraCause(new DOMException("x", "NotFoundError"))).toBe(
      "no-camera"
    );
  });

  it("leaves every other camera failure generic", () => {
    expect(cameraCause(new DOMException("x", "NotReadableError"))).toBe(
      "generic"
    );
    expect(cameraCause(new Error("boom"))).toBe("generic");
    expect(cameraCause(undefined)).toBe("generic");
  });

  it("names an unsupported browser and nothing else of the asset load", () => {
    expect(loadCause("unsupported")).toBe("unsupported");
    expect(loadCause("cannot-start")).toBe("generic");
  });
});
