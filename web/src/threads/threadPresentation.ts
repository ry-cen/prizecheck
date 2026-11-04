import type { PulseCount } from "../social_generated";
export function itemTabName(
  label: string,
  count: PulseCount
): string | undefined {
  return count.needs_you
    ? `${label}, ${count.needs_you} need you: ${count.waiting ?? 0} waiting on you, ${count.unread ?? 0} with new messages`
    : undefined;
}
export const WAITING_LABELS: Record<string, string> = {
  answer: "Accept or counter",
  fix_picks: "Update picks",
  confirm_swap: "Confirm swap",
  choose_written_off: "Keep or remove",
  confirm_return: "Confirm return",
  hand_over: "Hand over",
  confirm_handover: "Confirm you have them",
  answer_more_time: "Answer more time request",
};
