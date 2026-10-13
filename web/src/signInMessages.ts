// What the sign-in page (and later the Sign-ins page) says when sign-in fails: a fixed allowlist keyed by the `error`
// code (spec "Failure messages"). Anything not listed is "Didn't complete". No message says whether an account exists,
// and no free text from the address (`error_description`) is ever shown. The layout and final copy belong to the
// app-redesign map; this fixes what each message must say.

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
  text: string;
  /** The next step, when the message has one. */
  next: string | null;
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
        text: "Sign-in was cancelled.",
        next: "Choose a way to sign in below.",
      };
    case "not-open":
      return {
        group,
        text: "PrizeCheck isn't open for new sign-ins yet.",
        next: null,
      };
    case "verify-email":
      return providerName
        ? {
            group,
            text: `Your ${providerName} account needs a verified email address.`,
            next: `Verify it with ${providerName}, or use another sign-in.`,
          }
        : {
            group,
            text: "Your sign-in account needs a verified email address.",
            next: "Verify it with your provider, or use another sign-in.",
          };
    case "other-account":
      return {
        group,
        text: providerName
          ? `That ${providerName} sign-in is already connected to a different PrizeCheck account.`
          : "That sign-in is already connected to a different PrizeCheck account.",
        next: null,
      };
    case "sign-in-again":
      return {
        group,
        text: "For your security, sign in again to change your sign-ins.",
        next: null,
      };
    case "too-many":
      return {
        group,
        text: "Too many sign-ins right now. Try again later.",
        next: null,
      };
    default:
      return { group, text: "Sign-in didn't complete.", next: "Try again." };
  }
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

/** Removes the failure from the address bar, keeping the path and every other parameter. */
export function clearFailureFromAddress(): void {
  const url = new URL(location.href);
  for (const key of ["error", "error_description", "provider"])
    url.searchParams.delete(key);
  history.replaceState(
    history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}
