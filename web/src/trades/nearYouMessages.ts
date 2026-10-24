import type { SegmentedOption } from "../ui/Segmented";

// Collector-facing text new with Near you and card search (Trading #300). All of it is approved by the owner (in the
// spec's "Approved copy" or at #300's sign-off) or existing.

/** Approved by the owner (#300): the Friends section's heading, and the card search Friends list's. */
export const FRIENDS_HEADING = "Friends";
/** Approved: the Near you section's heading. */
export const NEAR_HEADING = "Near you";
/** Approved by the owner (#300). */
export const NEAR_INTRO =
  "Collectors near you who have cards you want, or want cards you have.";
/** Approved by the owner (#300). */
export const NEAR_EMPTY =
  "Nobody near you has cards you want or wants yours yet.";
/** Approved by the owner (#300). */
export const NEAR_LOADING = "Loading collectors near you…";
/** Approved by the owner (#300). */
export const NEAR_FAILED = "Collectors near you couldn't be loaded.";
/** Approved by the owner (#300): the list's accessible name. */
export const NEAR_LIST_LABEL = "Matches near you";
/** Approved by the owner (#300). */
export const RADIUS_LABEL = "Show collectors within";
/** Approved by the owner (#300): the collector's own search setting, not anyone's distance. */
export const RADIUS_OPTIONS: readonly SegmentedOption<
  "5" | "10" | "25" | "50"
>[] = [
  { value: "5", label: "5 mi" },
  { value: "10", label: "10 mi" },
  { value: "25", label: "25 mi" },
  { value: "50", label: "50 mi" },
];
/** Approved: shown while discovery is off. */
export const NEAR_OFF =
  "Turn on open discovery to find collectors near you who want your cards or have cards you want.";
/** Approved: the button beside NEAR_OFF. */
export const TURN_ON = "Turn on";
/** Approved by the owner (#300): the link after "Enter your zip code to turn on open discovery." */
export const OPEN_SETTINGS = "Open Settings";
/** Approved by the owner (#300): the accessible name; the visible text is "Message". */
export const messageLabel = (name: string) => `Message ${name}`;
/** Approved by the owner (#300): the ⋯ trigger of a Near you row. */
export const rowMenuLabel = (name: string) => `More for ${name}`;

/** Approved by the owner (#300). */
export const CARD_SEARCH_HEADING = "Search for a card";
/** Approved by the owner (#300). */
export const CARD_SEARCH_HELP =
  "Find Friends and collectors near you who have a card for trade.";
/** Approved by the owner (#300). */
export const CARD_SEARCH_LABEL = "Card name";
/** Approved by the owner (#300). */
export const CARD_SEARCH_LOADING = "Searching…";
/** Approved by the owner (#300). */
export const CARDS_FAILED = "Cards couldn't be loaded.";
/** Approved by the owner (#300). */
export const CARD_OPTIONS_LABEL = "Cards";
/** Approved by the owner (#300). */
export const CHANGE_CARD = "Change card";
/** Approved by the owner (#300). */
export const SCOPE_LABEL = "Search in";
/** Approved by the owner (#300). */
export const SCOPE_OPTIONS: readonly SegmentedOption<
  "name" | "set" | "printing"
>[] = [
  { value: "name", label: "Every printing" },
  { value: "set", label: "This set" },
  { value: "printing", label: "This printing" },
];
/** Approved by the owner (#300). */
export const HOLDERS_LOADING = "Looking for this card…";
/** Approved by the owner (#300). */
export const HOLDERS_FAILED = "The search couldn't be loaded.";
/** Approved by the owner (#300). */
export const FRIENDS_NONE = "None of your Friends has this card for trade.";
/** Approved by the owner (#300). */
export const NEAR_NONE = "Nobody near you has this card for trade.";
/** Approved by the owner (#300): no button; the Turn on button is in Near you. */
export const NEAR_SEARCH_OFF =
  "Turn on open discovery to search collectors near you.";
/** Approved by the owner (#300). */
export const FRIEND_HOLDERS_LABEL = "Friends with this card";
/** Approved by the owner (#300). */
export const NEAR_HOLDERS_LABEL = "Collectors near you with this card";
/** Approved by the owner (#300): "1 more card" / "N more cards". */
export const moreCards = (n: number) =>
  n === 1 ? "1 more card" : `${n} more cards`;

/** Approved: the For trade sentence while the collector is visible beyond Friends (Settings › Privacy). */
export const FOR_TRADE_BEYOND_FRIENDS =
  "Friends, and collectors near you or in your conversations, can trade for the cards in these Locations and everything inside them.";
/** Existing (Stage 1): the sentence after it. */
export const FOR_TRADE_CHANGE_HINT =
  "Change this in each Location's settings in Collection.";
/** Approved: a hidden Location that is still offered, while the collector is visible beyond Friends. */
export const hiddenStillOffered = (path: string) =>
  `${path} is hidden from Friends, but its cards are still on your Trade List for Friends and for collectors near you or in your conversations.`;
