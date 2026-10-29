import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OVERLAY_SCROLLBAR_QUERY } from "./overlayScrollPolicy";

const base = readFileSync(new URL("../base.css", import.meta.url), "utf8");

describe("the overlay scroll bar policy", () => {
  it("is the media query base.css hides the native scroll bars under", () => {
    expect(base).toContain(`@media ${OVERLAY_SCROLLBAR_QUERY} {`);
    expect(base).toContain("scrollbar-width: none");
    expect(base).toContain("::-webkit-scrollbar");
  });

  it("leaves out the window width, so a narrow desktop window has no browser bar either", () => {
    expect(OVERLAY_SCROLLBAR_QUERY).not.toMatch(/width/);
    expect(OVERLAY_SCROLLBAR_QUERY).toContain("(pointer: fine)");
    expect(OVERLAY_SCROLLBAR_QUERY).toContain("(hover: hover)");
  });
});
