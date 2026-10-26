import { describe, expect, it } from "vitest";
import {
  gateHint,
  newGateTracker,
  outcomeHint,
  trackGate,
  type GateTracker,
} from "./hints";

describe("gate hints", () => {
  it("names the four camera problems in plain words", () => {
    expect(gateHint("dark")).toBe("More light");
    expect(gateHint("bright")).toBe("Less light");
    expect(gateHint("clipped")).toBe("Tilt to avoid glare");
    expect(gateHint("soft", true)).toBe("Hold steady");
  });

  it("does not show Hold steady while sharpness is off", () => {
    expect(gateHint("soft", false)).toBeNull();
  });
});

describe("outcome hints", () => {
  it("uses the spec's wording", () => {
    expect(outcomeHint("unresolved")).toBe(
      "Couldn't add this card. Tap the shutter to search."
    );
    expect(outcomeHint("offline")).toBe(
      "Can't reach PrizeCheck. Check your connection and scan again."
    );
    expect(outcomeHint("edition_limit")).toBe(
      "That's the most copies of one card in a tray"
    );
  });
});

describe("gate tracking", () => {
  const feed = (steps: [boolean, "dark" | undefined][]): GateTracker =>
    steps.reduce(
      (t, [ok, reason]) => trackGate(t, ok, reason),
      newGateTracker()
    );

  it("waits for two frames in a row before showing a hint", () => {
    expect(feed([[false, "dark"]]).shown).toBeNull();
    expect(
      feed([
        [false, "dark"],
        [false, "dark"],
      ]).shown
    ).toBe("dark");
  });

  it("clears after two good frames, and a single good frame does not flicker it away", () => {
    const dark: [boolean, "dark"][] = [
      [false, "dark"],
      [false, "dark"],
    ];
    expect(feed([...dark, [true, undefined]]).shown).toBe("dark");
    expect(
      feed([...dark, [true, undefined], [true, undefined]]).shown
    ).toBeNull();
  });
});
