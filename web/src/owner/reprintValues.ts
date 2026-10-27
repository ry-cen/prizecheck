import type {
  CardIdentityEvidence,
  CardIdentityQueueItem,
  GroupLegality,
  ReprintGroupDecisionInput,
  ReprintGroupPrinting,
} from "../metadata_generated";

/** One Card Identity in the Reprints queue (#171): the queue route lists manual Printings in no Reprint
 * Group, and the table lists their Card Identities, so an identity with two such Printings is one row. */
export type IdentityRow = {
  identityId: string;
  name: string;
  printings: CardIdentityQueueItem[];
  /** The oldest of its Printings' opened times. */
  openedAt: string;
};

/** The queue's Printings grouped by Card Identity, in the order each identity first appears. Load more
 * appends a page, so an identity split across two pages becomes one row again. */
export function identityRows(items: CardIdentityQueueItem[]): IdentityRow[] {
  const rows = new Map<string, IdentityRow>();
  for (const item of items) {
    const row = rows.get(item.identity_id);
    if (!row)
      rows.set(item.identity_id, {
        identityId: item.identity_id,
        name: item.identity_name,
        printings: [item],
        openedAt: item.opened_at,
      });
    else {
      row.printings.push(item);
      if (Date.parse(item.opened_at) < Date.parse(row.openedAt))
        row.openedAt = item.opened_at;
    }
  }
  return [...rows.values()];
}

/** "me01 · 125", or "—" when neither is known. */
export const place = (printing: {
  set_id: string | null;
  collector_number: string | null;
}) =>
  [printing.set_id, printing.collector_number].filter(Boolean).join(" · ") ||
  "—";

/** A Printing in a few words: "Rare Candy · me01 · 125". Move to pickers are named after it. */
export const printingLabel = (printing: ReprintGroupPrinting) =>
  `${printing.name ?? "Unnamed Printing"} · ${place(printing)}`;

/** "Group 1", "Group 2", … in the order the groups first appear in the Printings list (set, then number),
 * by group ID. Group IDs are not for reading, and the order stays put while the card is open. */
export function groupNames(
  evidence: CardIdentityEvidence
): Map<string, string> {
  const names = new Map<string, string>();
  for (const printing of evidence.printings)
    if (printing.group_id && !names.has(printing.group_id))
      names.set(printing.group_id, `Group ${names.size + 1}`);
  return names;
}

const FORMAT_NAMES: Record<string, string> = {
  standard: "Standard",
  expanded: "Expanded",
  glc: "GLC",
};
const STATUS_NAMES: Record<GroupLegality["status"], string> = {
  legal: "Legal",
  not_legal: "Not legal",
  unknown: "Unknown",
};

/** A group's legality in words, every Format: "Standard: Legal · Expanded: Legal · GLC: Not legal". */
export const legalityText = (legality: GroupLegality[]) =>
  legality
    .map(
      (entry) =>
        `${FORMAT_NAMES[entry.format] ?? entry.name}: ${STATUS_NAMES[entry.status]}`
    )
    .join(" · ");

/** A Move to choice: "" stays; "group:<id>" joins that group; "new" leaves for a new group of its own;
 * "restore" returns to the group its rules text gives it. */
export type MoveChoice = "" | "new" | "restore" | `group:${string}`;

/** What a Printing's Move to picker offers. Each option is one the server can accept: a TCGdex Printing
 * joins another group only while it derives a group (PRINTING_NOT_GROUPABLE), a new group needs a group
 * with another member to leave (SPLIT_WHOLE_GROUP), and only a reviewed placement can be undone
 * (NO_REVIEWED_GROUP). */
export function moveOptions(
  printing: ReprintGroupPrinting,
  evidence: CardIdentityEvidence,
  names: Map<string, string>
): { value: MoveChoice; label: string }[] {
  const options: { value: MoveChoice; label: string }[] = [
    { value: "", label: "Stay" },
  ];
  if (printing.source === "manual" || printing.derived_group_id)
    for (const [group, name] of names)
      if (group !== printing.group_id)
        options.push({ value: `group:${group}`, label: name });
  const size = evidence.groups.find(
    (group) => group.group_id === printing.group_id
  )?.printing_ids.length;
  if (size && size > 1) options.push({ value: "new", label: "A new group" });
  if (printing.linked_group_id || printing.assigned_group_id)
    options.push({
      value: "restore",
      // A manual Printing never derives a group (#171), so undoing its review leaves it in none.
      label: printing.derived_group_id
        ? "Back to its derived group"
        : "Out of its reviewed group (no group)",
    });
  return options;
}

/** The decision a card states, without the evidence, reason and code; or why it can't be sent yet. */
export type Plan =
  | {
      body: Pick<
        ReprintGroupDecisionInput,
        "decision" | "group_id" | "target_group_id" | "printing_ids"
      >;
      summary: string;
    }
  | { problem: string };

const printings = (count: number) =>
  count === 1 ? "1 Printing" : `${count} Printings`;

/** Move the chosen Printings: the server takes one destination per decision, so every picker that moves
 * must name the same one. An existing group is `join`, a new group is `split` from the one group they
 * share, and the derived group is `restore`. */
export function movePlan(
  evidence: CardIdentityEvidence,
  moves: Record<string, MoveChoice>,
  names: Map<string, string>
): Plan {
  const picked = evidence.printings.filter(
    (printing) => moves[printing.printing_id]
  );
  if (!picked.length)
    return { problem: "Choose where at least one Printing moves." };
  const choices = new Set(
    picked.map((printing) => moves[printing.printing_id])
  );
  if (choices.size > 1)
    return {
      problem:
        "One decision moves Printings to one place. Give every moving Printing the same Move to, or decide them one at a time.",
    };
  const choice = [...choices][0];
  const ids = picked.map((printing) => printing.printing_id);
  if (choice.startsWith("group:")) {
    const target = choice.slice("group:".length);
    return {
      body: { decision: "join", target_group_id: target, printing_ids: ids },
      summary: `Moves ${printings(ids.length)} into ${names.get(target)}.`,
    };
  }
  if (choice === "new") {
    const from = new Set(picked.map((printing) => printing.group_id));
    const [group] = [...from];
    if (from.size !== 1 || !group)
      return {
        problem:
          "Printings that leave for a new group must all come from the same group.",
      };
    const held = evidence.groups.find((entry) => entry.group_id === group);
    if (held && ids.length === held.printing_ids.length)
      return {
        problem:
          "A new group needs a Printing to stay behind. Leave at least one Printing in the group, or merge it into another group instead.",
      };
    return {
      body: { decision: "split", group_id: group, printing_ids: ids },
      summary: `Moves ${printings(ids.length)} out of ${names.get(group)} into a new group.`,
    };
  }
  const derives = picked.some((printing) => printing.derived_group_id);
  return {
    body: { decision: "restore", printing_ids: ids },
    summary: derives
      ? `Returns ${printings(ids.length)} to the group its rules text gives it.`
      : `Returns ${printings(ids.length)} to no group; ${ids.length === 1 ? "it" : "they"} will wait in this queue again.`,
  };
}

/** Merge one whole group into another (`merge`): unlike moving each member, it links the merged group's
 * wording to the target, so a reprint with either wording imported later joins it too. */
export function mergePlan(
  from: string,
  into: string,
  names: Map<string, string>
): Plan {
  if (!from || !into)
    return { problem: "Choose the group to merge and the group it joins." };
  if (from === into) return { problem: "Choose two different groups." };
  return {
    body: { decision: "merge", group_id: from, target_group_id: into },
    summary: `Merges ${names.get(from)} into ${names.get(into)}; later reprints with either wording join it too.`,
  };
}

/** Whether the Card Identity still belongs in the queue (the server's rule): not merged away, with a
 * manual Printing in no group. */
export const stillQueued = (evidence: CardIdentityEvidence) =>
  evidence.merged_into === null &&
  evidence.printings.some(
    (printing) => printing.source === "manual" && printing.group_id === null
  );

/** Whether any Printing has a reviewed group record, which blocks merging the identity away. */
export const hasReviewedGroups = (evidence: CardIdentityEvidence) =>
  evidence.printings.some(
    (printing) => printing.linked_group_id || printing.assigned_group_id
  );

const messages: Record<string, string> = {
  IDENTITY_EVIDENCE_CHANGED:
    "The Printings or groups changed since this card opened. Close it and review it again.",
  CATALOG_BUSY:
    "The catalog is busy with another change. Try again in a moment.",
  NO_CHANGE: "That decision would move no Printing.",
  ALREADY_IN_GROUP: "A chosen Printing is already in that group.",
  SPLIT_WHOLE_GROUP:
    "A new group needs at least one Printing to stay behind in the old one.",
  PRINTING_NOT_IN_GROUP: "A chosen Printing is no longer in that group.",
  PRINTING_NOT_GROUPABLE:
    "A chosen Printing has no rules text of its own to group by, so it can't join a group.",
  NO_REVIEWED_GROUP: "A chosen Printing has no reviewed group to undo.",
  GROUP_NOT_FOUND:
    "A chosen group no longer exists. Close this card and review it again.",
  PRINTING_NOT_IN_IDENTITY:
    "A chosen Printing no longer belongs to this Card Identity. Close this card and review it again.",
  REPRINT_GROUP_OVERRIDES:
    "This Card Identity has reviewed groups. Return its Printings to their derived groups first, then merge it.",
  IDENTITY_MERGED: "One of these Card Identities has already been merged.",
  SAME_IDENTITY: "Choose another Card Identity to merge into.",
  IDENTITY_NOT_FOUND: "That Card Identity no longer exists.",
  REASON_REQUIRED: "A reason is required.",
};

/** What went wrong with a decision, in words. A 422 without a known code is a field the server refused. */
export function decisionError(failure: unknown): string {
  const code = failure instanceof Error ? failure.message : "";
  if (messages[code]) return messages[code];
  return (failure as { status?: number })?.status === 422
    ? "Check the review evidence URL and the reason, then try again."
    : "The request failed. Please retry.";
}
