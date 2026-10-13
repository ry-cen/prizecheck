// The single decision point for creating a user, linking an account and signing in, for every method (Better Auth's
// user.validateUserInfo). It never branches on the provider id. Better Auth turns a thrown error into a refusal
// (`validation_failed`), so the gate fails closed.

export type GateAction = "create-user" | "link-account" | "sign-in";

export type GateInput = {
  user: { id?: unknown; email?: unknown; emailVerified?: unknown };
  source: { action: GateAction; method: string };
};

export type GateResult = void | { error: string; errorDescription?: string };

export type GateDependencies = {
  /** signupEnabled() at startup: true for `public` and `local-public`. */
  publicSignup: boolean;
  /** OWNER_EMAIL, trimmed and lower-cased. */
  ownerEmail: string;
  /** Whether owner_binding names an existing account. */
  ownerBound: () => Promise<boolean>;
  /**
   * Whether this existing user counts as the owner: the bound user once owner_binding names an existing account,
   * otherwise the user whose stored, verified email is OWNER_EMAIL.
   */
  isOwner: (userId: string) => Promise<boolean>;
  /** The trusted client IP of the callback being handled (auth/src/ipContext.ts), or null outside a context. */
  clientIp: () => string | null;
  /** Checks one OAuth account creation from `ip` against the creation limits, recording it when permitted. */
  allowSignup: (ip: string) => Promise<boolean>;
};

const refuse = (error: string): GateResult => ({
  error,
  errorDescription: error,
});

export function createSignupGate(deps: GateDependencies) {
  return async ({ user, source }: GateInput): Promise<GateResult> => {
    const email =
      typeof user.email === "string" ? user.email.trim().toLowerCase() : "";
    const oauth = source.method === "oauth";
    // Verified email, every mode, OAuth only: the provider must vouch for the address before anything is written.
    if (
      oauth &&
      (source.action === "create-user" || source.action === "link-account")
    ) {
      if (!email) return refuse("email_not_found");
      if (user.emailVerified !== true) return refuse("email_not_verified");
    }
    if (deps.publicSignup) {
      // Creation limits (#155), on OAuth account creation only: email-code creation has its own send limits, and
      // returning sign-ins and links are never throttled. Checked last, so a refusal for another reason uses up nothing.
      if (oauth && source.action === "create-user") {
        const ip = deps.clientIp();
        // No IP context: the gateway didn't vouch for this caller. Throwing refuses (Better Auth: validation_failed).
        if (!ip) throw new Error("No client IP context");
        if (!(await deps.allowSignup(ip))) return refuse("too_many_sign_ups");
      }
      return;
    }
    // owner-only: every refusal is the same code, whether or not an account exists.
    if (source.action === "create-user") {
      if (email === deps.ownerEmail && !(await deps.ownerBound())) return;
      return refuse("sign_in_unavailable");
    }
    if (typeof user.id !== "string" || !user.id)
      return refuse("sign_in_unavailable");
    return (await deps.isOwner(user.id))
      ? undefined
      : refuse("sign_in_unavailable");
  };
}
