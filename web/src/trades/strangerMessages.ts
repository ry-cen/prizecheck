// Collector-facing text for messaging strangers (Trading #301). The owner approved every string here.
import type { TradeView } from "../social_generated";

/** The per-card button on a stranger's Trade List. */
export const CARD_MESSAGE = "Message";

/** That button's accessible name: "Message Misty W. about Iono (PAL 185)". */
export function cardMessageLabel(name: string, cardName: string): string {
  return `Message ${name} about ${cardName}`;
}

/** The question the composer starts with; the finish suffix comes from the card name ("Arven (SVI 166, Reverse Holo)"). */
export function cardQuestion(cardName: string): string {
  return `Is your ${cardName} still available?`;
}

/** The tip on an accepted Trade with a collector who is not a Friend. */
export const MEET_IN_PUBLIC =
  "Meet somewhere public, like a local game store, and check the cards before you swap.";

/** The tip shows on an accepted Trade with someone still available who is not a Friend. */
export function meetTipShows(
  trade: Pick<TradeView, "state" | "other">
): boolean {
  return (
    trade.state === "accepted" &&
    trade.other.friend !== true &&
    trade.other.available === true
  );
}

/** What the daily limit on new conversations says, with the wait in whole hours. */
export function newConversationLimit(detail: Record<string, unknown>): string {
  const first = "You've started 10 new conversations in the last 24 hours.";
  const minutes = Number(detail.retry_after_minutes);
  if (!(minutes > 0)) return `${first} Try again later.`;
  const hours = Math.ceil(minutes / 60);
  return `${first} Try again in ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}
