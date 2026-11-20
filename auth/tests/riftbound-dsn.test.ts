import { describe, expect, it } from "vitest";
import {
  approvedParts,
  canonicalDsn,
  DsnRejected,
} from "../../web/tests/support/riftbound-dsn";

const base = "postgresql://postgres:s3cret@127.0.0.1:5433/tcg_verify_a";

describe("the Riftbound stack's database address", () => {
  it("rebuilds a loopback DSN for the generated database with no query", () => {
    const dsn = canonicalDsn(base + "?sslmode=disable", "tcg_rb_x");
    expect(dsn).toBe("postgresql://postgres:s3cret@127.0.0.1:5433/tcg_rb_x");
    expect(approvedParts(base).database).toBe("tcg_verify_a");
    expect(canonicalDsn("postgres://u@localhost/d")).toBe(
      "postgresql://u@localhost:5432/d"
    );
  });

  it.each([
    "?host=db.example.test",
    "?hostaddr=10.0.0.5",
    "?dbname=other",
    "?port=5999",
    "?service=prod",
    "?options=-c%20search_path%3Dx",
    "?HOST=db.example.test",
    "?application_name=x",
  ])("rejects a target-changing parameter %s", (query) => {
    expect(() => canonicalDsn(base + query, "tcg_rb_x")).toThrow(DsnRejected);
  });

  it("rejects a non-loopback host, a non-URL and another scheme without echoing the input", () => {
    for (const raw of [
      "postgresql://u:pw@db.example.test/d",
      "host=db dbname=d",
      "mysql://u:pw@127.0.0.1/d",
    ]) {
      const error = (() => {
        try {
          canonicalDsn(raw);
        } catch (e) {
          return e as Error;
        }
      })();
      expect(error).toBeInstanceOf(DsnRejected);
      expect(error!.message).not.toContain("pw");
      expect(error!.message).not.toContain("db.example");
    }
  });
});
