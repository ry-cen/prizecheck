import { describe, expect, it } from "vitest";
import { largeArtUrl } from "./artRoute";

describe("large artwork selection", () => {
  it("preserves the exact Edition identity and review version", () => {
    expect(largeArtUrl("/api/public/edition-art/edition/small?v=review")).toBe(
      "/api/public/edition-art/edition/large?v=review"
    );
  });
  it("keeps the Printing reference restriction for the large request", () => {
    expect(largeArtUrl("/api/art/printing/small?v=source&reference=1")).toBe(
      "/api/art/printing/large?v=source&reference=1"
    );
  });
});
