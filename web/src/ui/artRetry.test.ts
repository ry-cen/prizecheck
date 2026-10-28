import { describe, expect, it } from "vitest";
import {
  ART_RETRY_DELAYS_MS,
  artFailed,
  artRetried,
  artView,
  type ArtRetryState,
} from "./artRetry";

const fresh = (url: string | null): ArtRetryState => ({
  url,
  failed: 0,
  retried: 0,
});

describe("artView", () => {
  it("without an immediate retry, each failure waits and then shows the picture again until the delays are spent", () => {
    const url = "/api/art/a/small";
    let state = fresh(url);
    expect(artView(state, url, 0)).toEqual({
      phase: "showing",
      attempt: 0,
      delay: null,
    });
    state = artFailed(state, url);
    expect(artView(state, url, 0)).toEqual({
      phase: "waiting",
      attempt: 1,
      delay: ART_RETRY_DELAYS_MS[0],
    });
    state = artRetried(state, url);
    expect(artView(state, url, 0).phase).toBe("showing");
    state = artRetried(artFailed(state, url), url);
    expect(artView(artFailed(fresh(url), url), url, 0).delay).toBe(1500);
    expect(artView(state, url, 0)).toEqual({
      phase: "showing",
      attempt: 2,
      delay: null,
    });
    expect(artView(artFailed(state, url), url, 0)).toEqual({
      phase: "spent",
      attempt: 3,
      delay: null,
    });
  });

  it("with one immediate retry, the first failure shows again at once and the delays follow", () => {
    const url = "/api/art/a/small";
    let state = artFailed(fresh(url), url);
    expect(artView(state, url, 1)).toEqual({
      phase: "showing",
      attempt: 1,
      delay: null,
    });
    state = artFailed(state, url);
    expect(artView(state, url, 1)).toEqual({
      phase: "waiting",
      attempt: 2,
      delay: 1500,
    });
    state = artFailed(artRetried(state, url), url);
    expect(artView(state, url, 1)).toEqual({
      phase: "waiting",
      attempt: 3,
      delay: 5000,
    });
    state = artFailed(artRetried(state, url), url);
    expect(artView(state, url, 1).phase).toBe("spent");
  });

  it("alternates the tries so a page can ask for the large file on the odd ones", () => {
    const url = "/api/art/a/small";
    let state = fresh(url);
    const attempts = [artView(state, url, 1).attempt];
    for (let n = 0; n < 3; n += 1) {
      state = artRetried(artFailed(state, url), url);
      attempts.push(artView(state, url, 1).attempt);
    }
    expect(attempts.map((attempt) => attempt % 2)).toEqual([0, 1, 0, 1]);
  });

  it("starts over for a new address, and an address with no picture is spent", () => {
    const state = artFailed(artFailed(fresh("/a"), "/a"), "/a");
    expect(artView(state, "/b", 0)).toEqual({
      phase: "showing",
      attempt: 0,
      delay: null,
    });
    expect(artFailed(state, "/b")).toEqual({
      url: "/b",
      failed: 1,
      retried: 0,
    });
    expect(artView(fresh(null), null, 0).phase).toBe("spent");
  });
});
