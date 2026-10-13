import { readFileSync } from "node:fs";
import { configuredProviders } from "./providers.js";

// Readiness proof version 2 (docs/signup-readiness.md). Mail checks apply only when email-code sign-in is on;
// every configured provider must have a verified real sign-in on the production origin.
const ALWAYS = [
  "authorizedByOwner",
  "ownerWalkthroughVerified",
  "recoveryVerified",
  "privacyVerified",
  "capacityVerified",
];
const WITH_EMAIL_SIGN_IN = ["senderVerified", "recipientDeliveryVerified"];

/** Opening signup is an operator action bound to independently recorded proof. */
export function signupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.SIGNUP_MODE || "owner-only";
  if (mode === "owner-only") return false;
  if (mode === "local-public") {
    const localOrigin = new URL(env.PUBLIC_ORIGIN || "http://localhost:5173");
    if (
      !["development", "test"].includes(env.NODE_ENV || "") ||
      !["localhost", "127.0.0.1", "[::1]"].includes(localOrigin.hostname)
    ) {
      throw new Error(
        "Local signup requires explicit development/test and loopback origin"
      );
    }
    return true;
  }
  if (mode !== "public") throw new Error("Invalid signup configuration");
  const path = env.SIGNUP_READINESS_FILE;
  const commit = env.RELEASE_COMMIT;
  if (!path || !commit || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Signup readiness required");
  const proof = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  // EMAIL_SIGN_IN is validated at startup (auth/src/emailSignIn.ts); anything but "on" is off here.
  const emailSignIn = (env.EMAIL_SIGN_IN ?? "").trim() === "on";
  const verified = proof.providerSignInVerified;
  const gates = emailSignIn ? [...ALWAYS, ...WITH_EMAIL_SIGN_IN] : ALWAYS;
  if (
    proof.schemaVersion !== 2 ||
    proof.releaseCommit !== commit ||
    !gates.every((gate) => proof[gate] === true) ||
    !Array.isArray(verified) ||
    !configuredProviders(env).every((provider) =>
      verified.includes(provider.id)
    ) ||
    typeof proof.evidence !== "string" ||
    !proof.evidence.trim()
  ) {
    throw new Error("Signup readiness incomplete");
  }
  if (emailSignIn && env.MAIL_MODE !== "http")
    throw new Error(
      "Public signup with email sign-in requires real mail delivery"
    );
  return true;
}
