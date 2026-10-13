import { describe, expect, it } from "vitest";
import { contextIp, ipContext } from "../src/ipContext.js";
import { dailySignupCap, ipKey } from "../src/rateLimits.js";
import { createSignupGate, type GateInput } from "../src/signupGate.js";

// The gate's creation-limit branch (#155) with stand-in dependencies; the limits themselves run against PostgreSQL in
// oauth-limits.test.ts.
const OWNER = "owner@example.test";
const NEWCOMER = { email: "newcomer@example.test", emailVerified: true };

function gate(
  options: { publicSignup?: boolean; ip?: string | null; admit?: boolean } = {}
) {
  const calls: string[] = [];
  const check = createSignupGate({
    publicSignup: options.publicSignup ?? true,
    ownerEmail: OWNER,
    ownerBound: async () => false,
    isOwner: async () => true,
    clientIp: () => (options.ip === undefined ? "203.0.113.7" : options.ip),
    allowSignup: async (ip) => {
      calls.push(ip);
      return options.admit ?? true;
    },
  });
  return { check, calls };
}
const input = (
  action: GateInput["source"]["action"],
  user: GateInput["user"],
  method = "oauth"
): GateInput => ({ user, source: { action, method } });
const TOO_MANY = {
  error: "too_many_sign_ups",
  errorDescription: "too_many_sign_ups",
};

describe("creation limits in the signup gate", () => {
  it("checks a public OAuth creation against the limits with the context IP", async () => {
    const allowed = gate();
    expect(await allowed.check(input("create-user", NEWCOMER))).toBeUndefined();
    expect(allowed.calls).toEqual(["203.0.113.7"]);
    const refused = gate({ admit: false });
    expect(await refused.check(input("create-user", NEWCOMER))).toEqual(
      TOO_MANY
    );
  });

  it("refuses creation when there is no IP context, without consulting the limits", async () => {
    const missing = gate({ ip: null });
    await expect(missing.check(input("create-user", NEWCOMER))).rejects.toThrow(
      "No client IP context"
    );
    expect(missing.calls).toEqual([]);
  });

  it("never throttles returning sign-ins, links or email-code creation", async () => {
    const limited = gate({ admit: false, ip: null });
    const user = { id: "u1", ...NEWCOMER };
    expect(await limited.check(input("sign-in", user))).toBeUndefined();
    expect(await limited.check(input("link-account", user))).toBeUndefined();
    expect(
      await limited.check(input("create-user", NEWCOMER, "email-otp"))
    ).toBeUndefined();
    expect(limited.calls).toEqual([]);
  });

  it("uses up nothing when another rule refuses first, and leaves owner-only creation unlimited", async () => {
    const unverified = gate();
    expect(
      await unverified.check(
        input("create-user", { email: "x@example.test", emailVerified: false })
      )
    ).toEqual({
      error: "email_not_verified",
      errorDescription: "email_not_verified",
    });
    expect(unverified.calls).toEqual([]);
    const ownerOnly = gate({ publicSignup: false, admit: false, ip: null });
    expect(
      await ownerOnly.check(
        input("create-user", { email: OWNER, emailVerified: true })
      )
    ).toBeUndefined();
    expect(await ownerOnly.check(input("create-user", NEWCOMER))).toEqual({
      error: "sign_in_unavailable",
      errorDescription: "sign_in_unavailable",
    });
    expect(ownerOnly.calls).toEqual([]);
  });
});

describe("ipContext", () => {
  it("holds the IP only inside a run, across awaits", async () => {
    expect(contextIp()).toBeNull();
    const seen = await ipContext.run({ ip: "198.51.100.4" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return contextIp();
    });
    expect(seen).toBe("198.51.100.4");
    expect(contextIp()).toBeNull();
  });
});

describe("DAILY_SIGNUP_CAP", () => {
  it("defaults to 100 and accepts a whole number", () => {
    expect(dailySignupCap({})).toBe(100);
    expect(dailySignupCap({ DAILY_SIGNUP_CAP: "" })).toBe(100);
    expect(dailySignupCap({ DAILY_SIGNUP_CAP: " 25 " })).toBe(25);
    expect(dailySignupCap({ DAILY_SIGNUP_CAP: "0" })).toBe(0);
  });
  it("refuses anything else at startup", () => {
    for (const value of ["abc", "-1", "1.5", "1e3", "10 per day"])
      expect(() => dailySignupCap({ DAILY_SIGNUP_CAP: value }), value).toThrow(
        "DAILY_SIGNUP_CAP must be a whole number"
      );
  });
});

describe("ipKey", () => {
  it("is a sha256 hex key, shared by one IPv6 /64", () => {
    expect(ipKey("203.0.113.7")).toMatch(/^[0-9a-f]{64}$/);
    expect(ipKey("2001:db8:1:2::1")).toBe(ipKey("2001:db8:1:2:abcd::9"));
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"));
  });
});
