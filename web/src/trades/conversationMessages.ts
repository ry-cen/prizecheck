import { SocialError } from "../social_generated";
import { newConversationLimit } from "./strangerMessages";

// Conversations' collector-facing copy (Trading #298, Stage 2 spec "Conversations and messages"). Every string is the
// owner's approved wording, kept here so a change touches this file and the specs alone.

export const CONVERSATION_BACK = "All conversations";
export const CONVERSATION_LOADING = "Loading conversation…";
export const CONVERSATION_FAILED = "This conversation couldn't be loaded.";
export const CONVERSATION_MISSING_HEADING = "Conversation not found";
export const CONVERSATION_MISSING = "This conversation can't be found.";
export const RETRY = "Retry";

export const TIMELINE_LABEL = "Messages and Trades";
export const SENDER_YOU = "You";
export const SHOW_EARLIER = "Show earlier";
export const EARLIER_FAILED =
  "Earlier messages couldn't be loaded. Please retry.";

export const COMPOSER_LABEL = "Message";
export const COMPOSER_SEND = "Send";
export const EMPTY_MESSAGE = "Write a message first.";
/** The longest body the request accepts (code points); the composer refuses a longer paste before sending. */
export const MESSAGE_LIMIT = 4000;
export const MESSAGE_TOO_LONG = "Messages can be up to 1,000 characters.";
export const MESSAGE_RATE_LIMITED =
  "You're sending messages quickly. Try again in a few minutes.";
export const MESSAGE_FAILED =
  "Your message couldn't be sent. Check your connection and try again.";
export const NEW_TO_TRADING = "New to trading";
export const UNAVAILABLE_NOTE = "This collector is no longer available";
export const SUSPENDED_NOTE = "Your account can't trade or message right now.";

export const LIST_LABEL = "Conversations";
export const LIST_LOADING = "Loading conversations…";
export const LIST_FAILED = "Your conversations couldn't be loaded.";
export const LIST_EMPTY = "No conversations yet.";
export const LIST_ARCHIVED_EMPTY = "No archived conversations.";
export const PREVIEW_YOU = "You: ";
export const UNREAD = "Unread";
export const ARCHIVE = "Archive";
export const UNARCHIVE = "Unarchive";
export const SHOW_ARCHIVED = "Archived conversations";
export const HIDE_ARCHIVED = "Back to conversations";
export const SHOW_MORE = "Show more conversations";
export const ARCHIVE_FAILED =
  "The conversation couldn't be changed. Check your connection and try again.";

/** "New to trading", "1 completed trade", "N completed trades"; null when the count is unknown (a deleted account). */
export function trackRecord(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  if (n === 0) return NEW_TO_TRADING;
  return n === 1 ? "1 completed trade" : `${n} completed trades`;
}

/** "You blocked <name>." (the whole sentence links to Settings). */
export function youBlocked(name: string): string {
  return `You blocked ${name}.`;
}

/** "1 open Trade", "N open Trades"; "" for none. */
export function openTradesText(n: number): string {
  if (n <= 0) return "";
  return n === 1 ? "1 open Trade" : `${n} open Trades`;
}

/** "1 needs you", "N need you"; "" for none. */
export function needsYouText(n: number): string {
  if (n <= 0) return "";
  return n === 1 ? "1 needs you" : `${n} need you`;
}

/** The link from a Trade or Counter page to its conversation. */
export function conversationLinkText(name: string): string {
  return `Conversation with ${name}`;
}

/** The Archive or Unarchive button's accessible name. */
export function archiveLabel(name: string, archived: boolean): string {
  return archived
    ? `Unarchive conversation with ${name}`
    : `Archive conversation with ${name}`;
}

/** What a refused or failed send says, or "reread" when the conversation changed under the collector and should be read again. */
export function messageError(cause: unknown): string | "reread" {
  const code = cause instanceof SocialError ? cause.code : "";
  switch (code) {
    case "EMPTY_MESSAGE":
      return EMPTY_MESSAGE;
    case "MESSAGE_TOO_LONG":
    // A body past the request's own limit is a validation error with no code.
    case "SOCIAL_REQUEST_FAILED":
      return cause instanceof SocialError && cause.status !== 422
        ? MESSAGE_FAILED
        : MESSAGE_TOO_LONG;
    case "MESSAGE_RATE_LIMITED":
      return MESSAGE_RATE_LIMITED;
    case "ACCOUNT_SUSPENDED":
      return SUSPENDED_NOTE;
    case "COLLECTOR_UNAVAILABLE":
    case "CONVERSATION_NOT_FOUND":
      return "reread";
    case "TOO_MANY_NEW_CONVERSATIONS":
      return newConversationLimit(
        cause instanceof SocialError ? cause.detail : {}
      );
    default:
      return MESSAGE_FAILED;
  }
}
