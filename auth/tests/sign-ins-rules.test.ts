import { describe, expect, it } from "vitest";
import {
  FRESH_AGE_MS,
  isFresh,
  linkedSignIns,
  sameSiteStart,
  unlinkPlan,
  type AccountRow,
} from "../src/signIns.js";

const CONFIGURED = [{ id: "google" }, { id: "discord" }];
const row = (
  id: string,
  providerId: string,
  createdAt: string
): AccountRow => ({
  id,
  providerId,
  createdAt,
});

describe("isFresh", () => {
  it("follows Better Auth's rule: stale from exactly 24 hours after the session was created", () => {
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    expect(FRESH_AGE_MS).toBe(86_400_000);
    expect(isFresh(new Date(now - FRESH_AGE_MS + 1), now)).toBe(true);
    expect(isFresh(new Date(now - FRESH_AGE_MS).toISOString(), now)).toBe(
      false
    );
    expect(isFresh("not a date", now)).toBe(false);
  });
});

describe("sameSiteStart", () => {
  it("allows a click inside PrizeCheck, a typed address, or a client that sends no Sec-Fetch-Site", () => {
    for (const site of [undefined, "same-origin", "none"])
      expect(sameSiteStart({ "sec-fetch-site": site }), String(site)).toBe(
        true
      );
  });
  it("refuses a start from another site", () => {
    for (const site of [
      "cross-site",
      "same-site",
      ["same-origin", "cross-site"],
    ])
      expect(sameSiteStart({ "sec-fetch-site": site }), String(site)).toBe(
        false
      );
  });
});

describe("linkedSignIns", () => {
  it("lists each configured provider once, by its earliest link, in configured order, with nothing else", () => {
    expect(
      linkedSignIns(
        [
          row("a3", "discord", "2026-10-03T00:00:00.000Z"),
          row("a2", "google", "2026-10-02T00:00:00.000Z"),
          row("a1", "google", "2026-10-01T00:00:00.000Z"),
          row("a4", "github", "2026-09-01T00:00:00.000Z"),
          row("a5", "discord", "garbage"),
        ],
        CONFIGURED
      )
    ).toEqual([
      { provider: "google", linkedAt: "2026-10-01T00:00:00.000Z" },
      { provider: "discord", linkedAt: "2026-10-03T00:00:00.000Z" },
    ]);
    expect(linkedSignIns([], CONFIGURED)).toEqual([]);
  });
});

describe("unlinkPlan", () => {
  const google1 = row("g1", "google", "2026-10-01T00:00:00.000Z");
  const google2 = row("g2", "google", "2026-10-02T00:00:00.000Z");
  const discord = row("d1", "discord", "2026-10-03T00:00:00.000Z");
  const github = row("h1", "github", "2026-10-04T00:00:00.000Z");
  it("removes every account of the provider when another configured provider stays", () => {
    expect(
      unlinkPlan([google1, google2, discord], "google", CONFIGURED)
    ).toEqual({
      kind: "unlink",
      accountIds: ["g1", "g2"],
    });
  });
  it("refuses the last configured sign-in, whatever else is stored", () => {
    expect(unlinkPlan([google1, google2], "google", CONFIGURED)).toEqual({
      kind: "last",
    });
    expect(unlinkPlan([google1, github], "google", CONFIGURED)).toEqual({
      kind: "last",
    });
  });
  it("reports a provider that isn't linked", () => {
    expect(unlinkPlan([google1], "discord", CONFIGURED)).toEqual({
      kind: "not-linked",
    });
  });
});
