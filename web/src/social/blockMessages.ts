/**
 * Block's collector-facing copy (Trading #302). Stage 1's approved wording unless marked DRAFT; DRAFT strings wait for
 * the owner's sign-off.
 */

export const BLOCK = "Block";
export const CANCEL = "Cancel";
export const UNBLOCK = "Unblock";

/** The ⋯ trigger's label on a collector's header or row. */
export const moreFor = (name: string) => `More for ${name}`;

/** The question before a Block; what it cancels follows it when there is something. */
export const blockQuestion = (name: string) =>
  `Block ${name}? They won't be told.`;

export const blockedStatus = (name: string) =>
  `Blocked ${name}. They aren't told.`;

export const unblockLabel = (name: string) => `Unblock ${name}`;
export const unblockedStatus = (name: string) => `Unblocked ${name}.`;

export const BLOCKED_HEADING = "Blocked collectors";
export const BLOCKED_LOADING = "Loading…";
export const BLOCKED_FAILED =
  "Your Blocked collectors are temporarily unavailable. Please retry.";

/** Approved by the owner (#302). */
export const BLOCKED_EMPTY =
  "You haven't blocked anyone. To block someone, choose Block in their ⋯ menu in Friends, in a conversation or in Near you.";

/** Approved by the owner (#302). */
export const BLOCKED_NOTE =
  "You won't see each other in Near you or card search, and neither of you can send the other messages or Trade Proposals. They can't find you by your Handle, use your Invite Link or send you Friend Requests.";
