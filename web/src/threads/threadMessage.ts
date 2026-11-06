import { SocialError } from "../social_generated";

export const MESSAGE_LENGTH_TEXT = "Messages can be up to 1,000 characters.";
export function threadMessageError(cause: unknown): string {
  if (cause instanceof SocialError) {
    if (cause.code === "MESSAGE_TOO_LONG") return MESSAGE_LENGTH_TEXT;
    if (cause.code === "MESSAGE_RATE_LIMITED")
      return "You're sending messages quickly. Try again in a few minutes.";
    if (
      cause.code === "COLLECTOR_UNAVAILABLE" ||
      cause.code === "THREAD_READ_ONLY"
    )
      return "This collector is no longer available.";
  }
  return "Your message could not be sent.";
}
