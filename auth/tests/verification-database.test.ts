import { describe, expect, it } from "vitest";
import { canonicalDsn } from "../../web/tests/support/riftbound-dsn";
import {
  NotVerificationDatabase,
  requireVerificationDatabase,
} from "../../web/tests/support/verification-database";

const own = "postgresql://postgres:s3cret@127.0.0.1:5433/tcg_verify_a";
const env = (over: Record<string, string | undefined> = {}) => ({
  VERIFY_BROWSER_STACKS: JSON.stringify([
    {
      DATABASE_URL: "postgresql://postgres:s3cret@127.0.0.1:5433/tcg_verify_z",
    },
    { DATABASE_URL: own },
  ]),
  TEST_PARALLEL_INDEX: "1",
  ...over,
});

describe("the connected proof's auth database", () => {
  it("accepts the selected worker's own database, raw or canonical", () => {
    expect(requireVerificationDatabase(own, env())).toBe(own);
    const canonical = canonicalDsn(own);
    expect(requireVerificationDatabase(canonical, env())).toBe(canonical);
  });

  it("rejects a standalone loopback DSN with no verification worker", () => {
    const developer = "postgresql://dev:pw@127.0.0.1:5432/prizecheck";
    expect(() => requireVerificationDatabase(developer, {})).toThrow(
      NotVerificationDatabase
    );
    expect(() =>
      requireVerificationDatabase(own, { TEST_PARALLEL_INDEX: "0" })
    ).toThrow(NotVerificationDatabase);
    expect(() =>
      requireVerificationDatabase(own, {
        VERIFY_BROWSER_STACKS: env().VERIFY_BROWSER_STACKS,
      })
    ).toThrow(NotVerificationDatabase);
  });

  it("rejects another loopback database even under a worker, and another worker's", () => {
    for (const other of [
      "postgresql://dev:pw@127.0.0.1:5432/prizecheck",
      "postgresql://postgres:s3cret@127.0.0.1:5433/tcg_verify_z",
      "postgresql://postgres:s3cret@127.0.0.1:5434/tcg_verify_a",
      undefined,
      "",
    ])
      expect(() => requireVerificationDatabase(other, env())).toThrow(
        NotVerificationDatabase
      );
  });

  it("rejects unreadable stacks and a missing index entry, naming no URL", () => {
    for (const bad of [
      env({ VERIFY_BROWSER_STACKS: "not json" }),
      env({ TEST_PARALLEL_INDEX: "7" }),
    ]) {
      let message = "";
      try {
        requireVerificationDatabase(own, bad);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("s3cret");
      expect(message).not.toContain("127.0.0.1");
    }
  });
});
