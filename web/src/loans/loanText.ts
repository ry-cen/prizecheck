import {
  SocialError,
  type InboxUpdate,
  type LoanView,
} from "../social_generated";
import { variantLabel } from "../ui/variantLabel";

/** The Loans tab (social network #252): /loans, and one Loan at /loans/<id>. */
export const LOANS_PATH = "/loans";

export function loanPath(id: string): string {
  return `${LOANS_PATH}/${encodeURIComponent(id)}`;
}

/** "1 card", "3 cards". */
export function cardCount(n: number): string {
  return n === 1 ? "1 card" : `${n} cards`;
}

/** Whether the lender promised anything yet: a Loan they accepted, before or after it closed. */
function promisedAny(loan: LoanView): boolean {
  return loan.lines.some((line) => line.promised !== "0");
}

/** The copies a Loan is about: what was promised once the lender accepted, before that what was asked. */
export function loanCopies(loan: LoanView): number {
  const promised = promisedAny(loan);
  return loan.lines.reduce(
    (total, line) => total + Number(promised ? line.promised : line.requested),
    0
  );
}

/** The lines a Loan is about: the promised ones once accepted (a line left out drops away), else every line. */
export function loanLines(loan: LoanView): LoanView["lines"] {
  return promisedAny(loan)
    ? loan.lines.filter((line) => line.promised !== "0")
    : loan.lines;
}

/**
 * The plain-language headline from the reader's side (Loans verdict, variant E): "Ash K. wants to borrow 3 cards",
 * "You asked Misty W. for 3 cards", "You're lending Ash K. 2 cards". It names no Location, Deck or reason: a cancel
 * reads "Ash K. cancelled this Loan" whatever lay behind it.
 */
export function loanHeadline(loan: LoanView): string {
  const other = loan.other.display_name;
  const cards = cardCount(loanCopies(loan));
  const lender = loan.role === "lender";
  const by = loan.closed_by;
  switch (loan.state) {
    case "requested":
      return lender
        ? `${other} wants to borrow ${cards}`
        : `You asked ${other} for ${cards}`;
    case "offered":
      return lender
        ? `You offered ${other} ${cards}`
        : `${other} offered to lend you ${cards}`;
    case "accepted":
      if (loan.they_confirmed_handover && !loan.you_confirmed_handover)
        return lender
          ? `${other} says they have your ${cards}`
          : `${other} says they handed you ${cards}`;
      return lender
        ? `You're lending ${other} ${cards}`
        : `${other} is lending you ${cards}`;
    case "handed_over": {
      // Written-off copies the borrower still has to answer for (#257).
      const awaiting = Number(loan.awaiting_choice ?? "0");
      if (!lender && awaiting > 0)
        return `${other} wrote off ${cardCount(awaiting)} you have`;
      // A return the other side confirmed and the reader hasn't (#255).
      const pending = loan.pending_return;
      if (pending && pending.they_confirmed && !pending.you_confirmed) {
        const back = cardCount(
          pending.lines.reduce((sum, line) => sum + Number(line.copies), 0)
        );
        return lender
          ? `${other} says they gave back ${back}`
          : `${other} says they got ${back} back`;
      }
      const copies = loanLines(loan).reduce(
        (sum, line) => sum + lineOut(line),
        0
      );
      // Everything written off while the borrower still answers for it (#257).
      if (copies === 0)
        return lender
          ? `${other} has no cards of yours`
          : `You have no cards of ${other}'s`;
      const out = cardCount(copies);
      return lender
        ? `${other} has ${out} of yours`
        : `You have ${out} of ${other}'s`;
    }
    case "closed":
      if (loan.closed_reason === "declined")
        return by === "you"
          ? `You declined ${other}'s request for ${cards}`
          : `${other} declined your request for ${cards}`;
      // A Lend Offer's lender withdraws it, as a Borrow Request's borrower does (owner's decision, 2026-10-16).
      if (loan.closed_reason === "withdrawn" && loan.kind === "lend_offer")
        return by === "you"
          ? `You withdrew your offer to ${other}`
          : `${other} withdrew their offer to lend you ${cards}`;
      if (loan.closed_reason === "withdrawn")
        return by === "you"
          ? `You withdrew your request to ${other}`
          : `${other} withdrew their request for ${cards}`;
      if (loan.closed_reason === "cancelled")
        return by === "you"
          ? "You cancelled this Loan"
          : `${other} cancelled this Loan`;
      return lender
        ? `Your Loan to ${other} ended`
        : `Your Loan from ${other} ended`;
  }
}

/**
 * A line's copies still out (#255): promised, less those written off (#257) and those back in complete returns. With no
 * return pending, both sides have this many out.
 */
export function lineOut(line: {
  promised: string;
  written_off: string;
  returned?: string;
}): number {
  return Math.max(
    0,
    Number(line.promised) -
      Number(line.written_off) -
      Number(line.returned ?? "0")
  );
}

/** The card names under a row's headline: "Iono, Boss's Orders and 2 more". */
export function loanCardNames(loan: LoanView): string {
  const names = [...new Set(loanLines(loan).map((line) => line.name))];
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

const DATE = new Intl.DateTimeFormat("en", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "Jan 31, 2099" for a return-by date ("2099-01-31"), read as a calendar day wherever the reader is. */
export function dayText(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return DATE.format(new Date(year, month - 1, date));
}

/** The calendar day after `day` ("2099-01-31" gives "2099-02-01"). */
export function dayAfter(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const next = new Date(year, month - 1, date + 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

/** Today as the date input's value (local calendar day). */
export function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * The line under a row's card names: "Waiting for Misty W. to answer", "Waiting for Ash K. to confirm", or the
 * return-by date. Null when there is nothing to say.
 */
export function loanStatus(loan: LoanView): string | null {
  const waiting = waitingText(loan);
  if (waiting) return waiting;
  // More time the borrower asked for, which the lender answers (#256).
  if (loan.role === "lender" && loan.extension_to)
    return `${loan.other.display_name} asked for more time`;
  if (loan.overdue_since) return `Overdue since ${dayText(loan.overdue_since)}`;
  if (loan.state !== "closed" && loan.return_by)
    return `Due back ${dayText(loan.return_by)}`;
  return null;
}

/**
 * "Waiting for Misty W. to answer", or "… to confirm" a handover or a return (#255) the reader confirmed, while the
 * other side is next; else null.
 */
export function waitingText(loan: LoanView): string | null {
  const other = loan.other.display_name;
  if (loan.state === "requested" && loan.role === "borrower")
    return `Waiting for ${other} to answer`;
  // A Lend Offer the borrower hasn't answered (#258).
  if (loan.state === "offered" && loan.role === "lender")
    return `Waiting for ${other} to answer`;
  if (
    loan.state === "accepted" &&
    loan.you_confirmed_handover &&
    !loan.they_confirmed_handover
  )
    return `Waiting for ${other} to confirm`;
  const pending = loan.pending_return;
  if (
    loan.state !== "closed" &&
    pending &&
    pending.you_confirmed &&
    !pending.they_confirmed &&
    loan.other.collector_id !== null
  )
    return `Waiting for ${other} to confirm`;
  return null;
}

/**
 * The step a Loan waits on the reader for, as the inbox's line names it after the other collector (#259): "Kim · Hand
 * over". Null when it waits on nothing.
 */
export function waitingLabel(loan: LoanView): string | null {
  switch (loan.waiting) {
    case "answer":
      return "Answer";
    case "fix_picks":
      return "Update picks";
    case "choose":
      return "Keep or remove";
    case "confirm_return":
      return "Confirm return";
    case "finish_return":
      return "Finish return";
    case "hand_over":
      return "Hand over";
    case "receive":
      return "Confirm you have them";
    case "return":
      return loan.role === "lender" ? "Record a return" : "Give cards back";
    case "more_time":
      return "Asked for more time";
    default:
      return null;
  }
}

/**
 * An update under the inbox's Earlier (#259), from the reader's side: "Kim accepted your request", "Kim cancelled this
 * Loan", "Kim withdrew their offer". It never says why: a Loan cancelled by an unfriend or a Block reads like any other
 * cancel.
 */
export function updateText(update: InboxUpdate): string {
  const other = update.other_name;
  const what = update.loan_kind === "lend_offer" ? "offer" : "request";
  switch (update.kind) {
    case "accepted":
      return `${other} accepted your ${what}`;
    case "partly_accepted":
      return `${other} accepted part of your ${what}`;
    case "declined":
      return `${other} declined your ${what}`;
    case "cancelled":
      return `${other} cancelled this Loan`;
    case "withdrawn":
      return `${other} withdrew their ${what}`;
    case "return_by_changed":
      return `${other} changed the return-by date`;
    case "overdue":
      return update.role === "lender"
        ? `Your Loan to ${other} is overdue`
        : `Your Loan from ${other} is overdue`;
    case "nudge_answer":
      if (update.loan_kind === "lend_offer")
        return update.role === "lender"
          ? `${other} hasn't answered your offer yet`
          : `${other}'s offer is still waiting for your answer`;
      return update.role === "lender"
        ? `${other}'s request is still waiting for your answer`
        : `${other} hasn't answered your request yet`;
    case "nudge_handover":
      return `Your Loan with ${other} hasn't been handed over yet`;
  }
}

/**
 * How many of the collector's Loans with this collector Remove Friend or Block would cancel (#260): the Borrow
 * Requests, Lend Offers and accepted Loans, either way round, that nobody has confirmed a handover for. The same rule
 * as the API's `end_loans_between`, over the Loans tab's read, which lists every open Loan.
 */
export function loansEnding(loans: LoanView[], collectorId: string): number {
  return loans.filter(
    (loan) =>
      loan.other.collector_id === collectorId &&
      (loan.state === "requested" ||
        loan.state === "offered" ||
        loan.state === "accepted") &&
      !loan.you_confirmed_handover &&
      !loan.they_confirmed_handover
  ).length;
}

/** "This cancels 2 open Loans that haven't been handed over.", for Remove Friend's and Block's question; "" for 0. */
export function endingText(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "This cancels 1 open Loan that hasn't been handed over."
    : `This cancels ${count} open Loans that haven't been handed over.`;
}

/** "PAL 185 · Reverse Holo": a Loan line's or draft line's Edition, as the Want List writes it. */
export function lineEdition(line: {
  set_code: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
}): string {
  return `${line.set_code} ${line.collector_number} · ${variantLabel(line.descriptor)}`;
}

function minutes(cause: SocialError): string {
  const n = Number(cause.detail.retry_after_minutes) || 60;
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}

/** Whether a failed step's outcome is unknown (no answer, or a server error): retry it with the same key. */
export function outcomeUnknown(cause: unknown): boolean {
  return !(cause instanceof SocialError) || cause.status >= 500;
}

/**
 * What a Loan step that failed says. `card` names a line's card by its Edition id, for the refusals that say which.
 */
export function loanStepMessage(
  cause: unknown,
  other: string,
  card: (editionId: string) => string
): string {
  if (outcomeUnknown(cause))
    return "The Loan may not have been updated. Check your connection and try again.";
  const error = cause as SocialError;
  switch (error.code) {
    case "LOAN_CHANGED":
    case "STEP_NOT_ALLOWED":
      return "This Loan has changed. Check it and try again.";
    case "LOAN_NOT_FOUND":
      return "This Loan can't be found.";
    case "NOT_FRIENDS":
      return `${other} isn't one of your Friends anymore.`;
    case "NOT_ENOUGH_COPIES": {
      const available = String(error.detail.available ?? "0");
      return `You have only ${available} of ${card(String(error.detail.edition_id ?? ""))} to lend now.`;
    }
    case "NOTHING_PROMISED":
      return "Lend at least one card, or decline the request.";
    case "PICKS_OUT_OF_DATE":
      return "A pick is out of date. Use the suggested picks first.";
    case "PICKS_UP_TO_DATE":
      return "Your picks are already up to date.";
    case "MORE_THAN_OUT": {
      const out = String(error.detail.out ?? "0");
      return `Only ${out} of ${card(String(error.detail.edition_id ?? ""))} ${out === "1" ? "is" : "are"} out now.`;
    }
    case "NOTHING_RETURNED":
      return "Return at least one card.";
    case "NOTHING_WRITTEN_OFF":
      return "Write off at least one card.";
    case "CHOICE_CHANGED":
      return "This Loan has changed. Check it and try again.";
    case "UNSORTED_UNAVAILABLE":
      return "Your top-level Unsorted can't hold cards. Make it a Storage Leaf in Collection, then try again.";
    case "MORE_THAN_OFFERED":
      return "Take at most the copies offered.";
    case "DECK_NOT_FOUND":
      return "That Deck is gone. Choose another, or Unsorted.";
    case "INVALID_RETURN_BY":
      return "Choose a return-by date from today on.";
    case "RETURN_BY_EARLIER":
      return "Once the cards are handed over, the return-by date can only move later.";
    case "EXTENSION_NOT_LATER":
      return "Choose a date after the current return-by date.";
    case "TOO_MANY_CHANGES":
      return `Too many changes. Try again in ${minutes(error)}.`;
    default:
      return "The Loan couldn't be updated. Check it and try again.";
  }
}

/** What a Borrow Request that couldn't be sent says. `card` names a line's card by its Edition id. */
export function sendMessage(
  cause: unknown,
  friend: string,
  card: (editionId: string) => string
): string {
  if (outcomeUnknown(cause))
    return "The request may not have been sent. Check your connection and try again.";
  const error = cause as SocialError;
  switch (error.code) {
    case "NOT_LENDABLE": {
      const available = String(error.detail.available ?? "0");
      const name = card(String(error.detail.edition_id ?? ""));
      return available === "0"
        ? `${friend} can't lend ${name} now.`
        : `${friend} can lend ${available} of ${name} now.`;
    }
    case "NOT_FRIENDS":
      return `${friend} isn't one of your Friends anymore.`;
    case "DECK_NOT_FOUND":
      return "That Deck is gone. Choose another, or none.";
    case "INVALID_RETURN_BY":
      return "Choose a return-by date from today on.";
    case "LOAN_CHANGED":
      return `${friend} already answered your earlier request. Send this one as a new request?`;
    case "TOO_MANY_CHANGES":
      return `Too many changes. Try again in ${minutes(error)}.`;
    default:
      return "The request couldn't be sent. Check it and try again.";
  }
}
