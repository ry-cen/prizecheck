// What the sign-in page and the Sign-ins page say when sign-in fails: a fixed allowlist keyed by the `error` code
// (OAuth spec "Failure messages"), in the app redesign's final wording (spec "Sign-in, Sign-ins, loading and first
// paint"). Anything not listed is "Didn't complete". No message says whether an account exists, and no free text from
// the address (`error_description`) is ever shown.

export type SignInPage = "sign-in" | "sign-ins";

export type MessageGroup =
  | "cancelled"
  | "not-open"
  | "verify-email"
  | "other-account"
  | "sign-in-again"
  | "too-many"
  | "didnt-complete";

export type SignInMessage = {
  group: MessageGroup;
  /** The bold first line. */
  title: string;
  /** The muted follow-up line. */
  detail: string;
};

const GROUPS: Record<string, MessageGroup> = {
  access_denied: "cancelled",
  sign_in_unavailable: "not-open",
  signup_disabled: "not-open",
  email_not_found: "verify-email",
  email_not_verified: "verify-email",
  account_already_linked_to_different_user: "other-account",
  recent_sign_in_required: "sign-in-again",
  too_many_sign_ups: "too-many",
};

/** Groups that only the Sign-ins page shows; elsewhere they are "Didn't complete". */
const SIGN_INS_ONLY: MessageGroup[] = ["other-account", "sign-in-again"];

/**
 * The message for an `error` code. `providerName` must be a configured provider's display name (from
 * GET /auth/methods), never text taken from the address.
 */
export function signInMessage(
  code: string,
  providerName: string | null,
  page: SignInPage = "sign-in"
): SignInMessage {
  let group: MessageGroup = Object.prototype.hasOwnProperty.call(GROUPS, code)
    ? GROUPS[code]
    : "didnt-complete";
  if (page === "sign-in" && SIGN_INS_ONLY.includes(group))
    group = "didnt-complete";
  switch (group) {
    case "cancelled":
      return {
        group,
        title: "Sign-in was cancelled.",
        detail: "Nothing was changed. Choose a way to sign in below.",
      };
    case "not-open":
      return {
        group,
        title: "PrizeCheck isn't open to new collectors yet.",
        detail:
          "Sign-ups open once testing is done. Until then, anyone can browse public decks.",
      };
    case "verify-email":
      return providerName
        ? {
            group,
            title: `Your ${providerName} account needs a verified email address.`,
            detail: `Verify your email with ${providerName}, then try again, or choose another way to sign in.`,
          }
        : {
            group,
            title: "Your sign-in account needs a verified email address.",
            detail:
              "Verify your email with your provider, then try again, or choose another way to sign in.",
          };
    case "other-account":
      return {
        group,
        title: providerName
          ? `That ${providerName} sign-in is already connected to a different PrizeCheck account.`
          : "That sign-in is already connected to a different PrizeCheck account.",
        detail:
          "Sign in with that account to manage it, or connect a different one here.",
      };
    case "sign-in-again":
      return {
        group,
        title: "For your security, sign in again to change your sign-ins.",
        detail: "You'll come straight back here afterwards.",
      };
    case "too-many":
      return {
        group,
        title: "Too many sign-ins right now.",
        detail: "Try again in a little while.",
      };
    default:
      return {
        group,
        title: "Sign-in didn't complete.",
        detail: "Try again. If it keeps happening, try another way to sign in.",
      };
  }
}

/**
 * `path` without a sign-in failure's parameters, so a failure carried into `next` isn't shown again after the next
 * sign-in. Only a same-origin path is rewritten; anything else is returned as it is, for the gateway's own check
 * (auth/src/nextPath.ts) to refuse.
 */
export function withoutFailure(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  const url = new URL(path, location.origin);
  if (url.origin !== location.origin) return path;
  for (const key of FAILURE_PARAMS) url.searchParams.delete(key);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The failure in the current address, if any: the `error` code and the `provider` id the start route added. */
export function failureInAddress(): {
  code: string;
  provider: string | null;
} | null {
  const query = new URLSearchParams(location.search);
  const code = query.get("error");
  return code ? { code, provider: query.get("provider") } : null;
}

/** The address parameters a sign-in failure arrives in. */
const FAILURE_PARAMS = ["error", "error_description", "provider"];

/** Removes the failure from the address bar, keeping the path and every other parameter. */
export function clearFailureFromAddress(): void {
  const url = new URL(location.href);
  for (const key of FAILURE_PARAMS) url.searchParams.delete(key);
  history.replaceState(
    history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}
