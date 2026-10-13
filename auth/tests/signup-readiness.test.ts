import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signupEnabled } from "../src/signup.js";

const directory = mkdtempSync(join(tmpdir(), "tcg-readiness-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const COMMIT = "a".repeat(40);
const BOTH = {
  GOOGLE_CLIENT_ID: "g",
  GOOGLE_CLIENT_SECRET: "g",
  DISCORD_CLIENT_ID: "d",
  DISCORD_CLIENT_SECRET: "d",
};
const COMPLETE = {
  schemaVersion: 2,
  releaseCommit: COMMIT,
  authorizedByOwner: true,
  ownerWalkthroughVerified: true,
  recoveryVerified: true,
  privacyVerified: true,
  capacityVerified: true,
  providerSignInVerified: ["google", "discord"],
  evidence: "Dated acceptance proofs in the private evidence store",
};
let files = 0;
function proof(body: Record<string, unknown>): string {
  const path = join(directory, `proof-${files++}.json`);
  writeFileSync(path, JSON.stringify(body));
  return path;
}
function publicEnv(
  body: Record<string, unknown>,
  extra: Record<string, string> = {}
): NodeJS.ProcessEnv {
  return {
    SIGNUP_MODE: "public",
    SIGNUP_READINESS_FILE: proof(body),
    RELEASE_COMMIT: COMMIT,
    MAIL_MODE: "file",
    ...BOTH,
    ...extra,
  };
}

describe("signupEnabled", () => {
  it("stays closed by default and in owner-only mode", () => {
    expect(signupEnabled({})).toBe(false);
    expect(signupEnabled({ SIGNUP_MODE: "owner-only" })).toBe(false);
  });

  it("keeps local-public for explicit development or test on a loopback origin", () => {
    expect(
      signupEnabled({
        SIGNUP_MODE: "local-public",
        NODE_ENV: "test",
        PUBLIC_ORIGIN: "http://127.0.0.1:5173",
      })
    ).toBe(true);
    expect(() =>
      signupEnabled({
        SIGNUP_MODE: "local-public",
        NODE_ENV: "production",
        PUBLIC_ORIGIN: "http://localhost:5173",
      })
    ).toThrow("Local signup requires");
  });

  it("opens public signup on a complete version 2 proof with no mail checks while email sign-in is off", () => {
    expect(signupEnabled(publicEnv(COMPLETE))).toBe(true);
    expect(signupEnabled(publicEnv(COMPLETE, { EMAIL_SIGN_IN: "off" }))).toBe(
      true
    );
  });

  it("rejects a version 1 proof, even a complete one", () => {
    expect(() =>
      signupEnabled(
        publicEnv({
          ...COMPLETE,
          schemaVersion: 1,
          senderVerified: true,
          recipientDeliveryVerified: true,
        })
      )
    ).toThrow("Signup readiness incomplete");
  });

  it("requires every always-on gate, the evidence and the running release commit", () => {
    for (const gate of [
      "authorizedByOwner",
      "ownerWalkthroughVerified",
      "recoveryVerified",
      "privacyVerified",
      "capacityVerified",
    ])
      expect(
        () => signupEnabled(publicEnv({ ...COMPLETE, [gate]: false })),
        gate
      ).toThrow("Signup readiness incomplete");
    expect(() =>
      signupEnabled(publicEnv({ ...COMPLETE, evidence: " " }))
    ).toThrow("Signup readiness incomplete");
    expect(() =>
      signupEnabled(publicEnv({ ...COMPLETE, releaseCommit: "b".repeat(40) }))
    ).toThrow("Signup readiness incomplete");
    expect(() =>
      signupEnabled({ ...publicEnv(COMPLETE), RELEASE_COMMIT: "stale" })
    ).toThrow("Signup readiness required");
  });

  it("requires a verified sign-in for every configured provider", () => {
    expect(() =>
      signupEnabled(
        publicEnv({ ...COMPLETE, providerSignInVerified: ["google"] })
      )
    ).toThrow("Signup readiness incomplete");
    expect(() =>
      signupEnabled(publicEnv({ ...COMPLETE, providerSignInVerified: true }))
    ).toThrow("Signup readiness incomplete");
    const { providerSignInVerified: _, ...missing } = COMPLETE;
    expect(() => signupEnabled(publicEnv(missing))).toThrow(
      "Signup readiness incomplete"
    );
    const googleOnly = {
      ...publicEnv({ ...COMPLETE, providerSignInVerified: ["google"] }),
      DISCORD_CLIENT_ID: "",
      DISCORD_CLIENT_SECRET: "",
    };
    expect(signupEnabled(googleOnly)).toBe(true);
  });

  it("asks for the mail checks and real delivery only when email sign-in is on", () => {
    const mail = {
      ...COMPLETE,
      senderVerified: true,
      recipientDeliveryVerified: true,
    };
    expect(() =>
      signupEnabled(
        publicEnv(COMPLETE, { EMAIL_SIGN_IN: "on", MAIL_MODE: "http" })
      )
    ).toThrow("Signup readiness incomplete");
    expect(() =>
      signupEnabled(publicEnv(mail, { EMAIL_SIGN_IN: "on", MAIL_MODE: "file" }))
    ).toThrow("requires real mail delivery");
    expect(
      signupEnabled(publicEnv(mail, { EMAIL_SIGN_IN: "on", MAIL_MODE: "http" }))
    ).toBe(true);
  });

  it("does not ask for Google brand verification", () => {
    expect(
      signupEnabled(publicEnv({ ...COMPLETE, brandVerified: false }))
    ).toBe(true);
  });
});
