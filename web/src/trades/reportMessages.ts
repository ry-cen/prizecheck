/**
 * Report's collector-facing copy (Trading #303), all approved by the owner.
 */
import type { ReportCollector } from "../social_generated";
import { endSentence } from "../social/sentenceEnd";
import { commandMessage } from "../social/socialMessages";

export const REPORT = "Report";

/** The reasons, in the order the form lists them. */
export const REASONS: readonly {
  value: ReportCollector["reason"];
  label: string;
}[] = [
  { value: "scam_or_no_show", label: "Scam or no-show" },
  { value: "harassment", label: "Harassment" },
  { value: "inappropriate_content", label: "Inappropriate content" },
  { value: "other", label: "Other" },
];

/** Approved by the owner (#303). */
export const reportQuestion = (name: string) => `Report ${name}?`;

/** Approved by the owner (#303). */
export const REPORT_HELP =
  "Reporting also blocks them, and they won't be told. Your conversation and Trades with them are kept for review.";

/** Approved by the owner (#303). */
export const REASON_LEGEND = "What happened?";

/** Approved by the owner (#303). */
export const NOTE_LABEL = "Add a note (optional)";

/** Approved by the owner (#303). */
export const reportedStatus = (name: string) =>
  `Reported ${endSentence(name)} They're blocked and aren't told.`;

/** Approved by the owner (#303). */
export const NOTE_TOO_LONG = "Keep your note to 1,000 characters or fewer.";

/** What a failed Report says: the note's length, else Stage 1's wording for the failure. */
export function reportMessage(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    (cause as { code?: unknown }).code === "MESSAGE_TOO_LONG"
  )
    return NOTE_TOO_LONG;
  return commandMessage(cause);
}
