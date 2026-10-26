import { describe, expect, it } from "vitest";
import { leaveToast, takeLandingToast } from "./landing";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("the landing toast", () => {
  it("is read once", () => {
    const s = storage();
    leaveToast("Added 3 cards to Unsorted", s);
    expect(takeLandingToast(s)).toBe("Added 3 cards to Unsorted");
    expect(takeLandingToast(s)).toBeNull();
  });

  it("is dropped after about a minute, and when it is not ours", () => {
    const s = storage();
    leaveToast("Added 3 cards to Unsorted", s, 1_000);
    expect(takeLandingToast(s, 1_000 + 61_000)).toBeNull();
    expect(takeLandingToast(s, 1_000)).toBeNull(); // read once even when dropped
    leaveToast("Added 3 cards to Unsorted", s, 1_000);
    expect(takeLandingToast(s, 1_000 + 30_000)).toBe(
      "Added 3 cards to Unsorted"
    );
    s.setItem("prizecheck:scanner:landing", "plain text");
    expect(takeLandingToast(s)).toBeNull();
  });

  it("is nothing when nothing was left or storage is unavailable", () => {
    expect(takeLandingToast(storage())).toBeNull();
    expect(takeLandingToast(null)).toBeNull();
  });
});
