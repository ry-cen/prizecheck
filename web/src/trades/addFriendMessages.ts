import { SocialError } from "../social_generated";
import { commandMessage } from "../social/socialMessages";
import { SEND_UNAVAILABLE } from "./traderMessages";

// Collector-facing text for Add as Friend (Trading #304). The ones marked "Approved" were signed off by the owner.

/** Approved by the owner (#304): the button that offers a Friend Request from a Trade both sides confirmed. */
export const ADD_FRIEND = "Add as Friend";

/** Approved by the owner (#304): the line shown while the collector's request is waiting. */
export const addFriendSentNote = (name: string) =>
  `You've sent ${name} a Friend Request.`;

/** The status after Add as Friend is tapped. */
export const addFriendSentStatus = (name: string) =>
  `Friend Request sent to ${name}.`;

/** The Withdraw button's text. */
export const WITHDRAW_ADD_FRIEND = "Withdraw";

/** The Withdraw button's accessible name. */
export const withdrawAddFriendLabel = (name: string) =>
  `Withdraw request to ${name}`;

/** The status after Withdraw. */
export const ADD_FRIEND_WITHDRAWN = "Friend Request withdrawn.";

/** The line shown when the other collector has asked first. */
export const addFriendReceivedNote = (name: string) =>
  `${name} has sent you a Friend Request.`;

/** Approved by the owner (#304): the button that accepts the other's request (a bare "Accept" under a Trade could read as accepting a Trade). */
export const ACCEPT_ADD_FRIEND = "Accept Friend Request";

/** The status after an accept, or when both asked at once. */
export const friendsNow = (name: string) => `You and ${name} are now Friends.`;

/** Approved by the owner (#304): a suspended account tried to send a Friend Request. */
export const ADD_FRIEND_SUSPENDED =
  "Your account can't send Friend Requests right now.";

/** What a refused Add as Friend or its Withdraw says. */
export function addFriendError(cause: unknown): string {
  const code = cause instanceof SocialError ? cause.code : "";
  if (code === "COLLECTOR_UNAVAILABLE") return SEND_UNAVAILABLE;
  if (code === "ACCOUNT_SUSPENDED") return ADD_FRIEND_SUSPENDED;
  return commandMessage(cause);
}
