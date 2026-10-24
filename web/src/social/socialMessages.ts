import { SocialError } from "../social_generated";
import { ADD_FRIEND_SUSPENDED } from "./suspendedMessages";

/** What a refused Handle lookup says (social network #247). A miss reads the same whatever the reason. */
export function lookupMessage(cause: unknown): string {
  const code = cause instanceof SocialError ? cause.code : "";
  switch (code) {
    case "COLLECTOR_NOT_FOUND":
      return "No collector has that Handle.";
    case "INVALID_HANDLE":
      return "Handles are 3 to 20 letters, digits and underscores.";
    case "TOO_MANY_LOOKUPS": {
      const detail = cause instanceof SocialError ? cause.detail : {};
      const minutes = Number(detail.retry_after_minutes) || 60;
      return `Too many searches. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    }
    default:
      return "Couldn't search. Check your connection and try again.";
  }
}

/** What a Friend command that failed says. */
export function commandMessage(cause: unknown): string {
  const code = cause instanceof SocialError ? cause.code : "";
  if (code === "COLLECTOR_NOT_FOUND")
    return "That collector can't be found anymore.";
  if (code === "ACCOUNT_SUSPENDED") return ADD_FRIEND_SUSPENDED;
  if (code === "TRY_LATER") return "You can send another request later.";
  if (code === "TOO_MANY_CHANGES") {
    const detail = cause instanceof SocialError ? cause.detail : {};
    const minutes = Number(detail.retry_after_minutes) || 60;
    return `Too many changes. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
  }
  return "Couldn't update. Check your connection and try again.";
}
