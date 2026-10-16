const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function ago(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/**
 * When an inbox update happened (owner's decision, 2026-10-16), from `at` (an ISO time) as of `now`: "just now" under a
 * minute (or a moment ahead, when the clocks disagree), then "5 minutes ago", "3 hours ago" and "2 days ago", counting
 * whole minutes, hours and 24-hour days; from a week on, the day in the collector's locale ("Oct 3"), with the year
 * when it isn't this year ("Oct 3, 2025"). `locale`: the collector's own when left out.
 */
export function inboxTime(at: string, now: number, locale?: string): string {
  const then = new Date(at);
  const elapsed = now - then.getTime();
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return ago(Math.floor(elapsed / MINUTE), "minute");
  if (elapsed < DAY) return ago(Math.floor(elapsed / HOUR), "hour");
  if (elapsed < 7 * DAY) return ago(Math.floor(elapsed / DAY), "day");
  return then.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() === new Date(now).getFullYear()
      ? {}
      : { year: "numeric" }),
  });
}
