import { ProfileError } from "../profile_generated";

/** A date a collector can act on, such as when their Handle can change again: "15 November 2026". */
export function profileDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** What a refused profile change says (social network #246). Every word filter and reserved-name refusal reads the
 * same, so the lists can't be probed. */
export function profileMessage(cause: unknown): string {
  const code = cause instanceof ProfileError ? cause.code : "";
  const detail = cause instanceof ProfileError ? cause.detail : {};
  switch (code) {
    case "INVALID_DISPLAY_NAME":
      return "Enter a name of 1 to 40 characters.";
    case "DISPLAY_NAME_NOT_ALLOWED":
      return "That name isn't allowed. Try another.";
    case "INVALID_HANDLE":
      return "Use 3 to 20 letters, digits and underscores.";
    case "HANDLE_NOT_ALLOWED":
      return "That Handle isn't allowed. Try another.";
    case "HANDLE_TAKEN":
      return "That Handle is taken. Try another.";
    case "HANDLE_CHANGE_TOO_SOON":
      return typeof detail.available_at === "string"
        ? `You can change your Handle again on ${profileDate(detail.available_at)}.`
        : "You changed your Handle recently. Try again later.";
    case "TOO_MANY_HANDLE_TRIES": {
      const minutes = Number(detail.retry_after_minutes) || 60;
      return `Too many tries. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
    }
    default:
      return "Couldn't save. Check your connection and try again.";
  }
}

/** Whether a failed change may be sent again unchanged with the same idempotency key (it may have been saved). */
export function retryable(cause: unknown): boolean {
  return !(cause instanceof ProfileError) || cause.status >= 500;
}
