import type { Timeline, TimelineItem } from "../social_generated";

const timestamp = (at: string) =>
  at.replace(
    /(?:\.(\d+))?(?:Z|\+00:00)$/,
    (_: string, fraction?: string) => `.${(fraction ?? "").padEnd(6, "0")}Z`
  );
const identity = (row: TimelineItem) =>
  row.message?.id ?? row.event?.id ?? row.cursor;
const descending = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
/** Match the server's stable (time, kind, id) ordering, including timestamp ties. */
function order(a: TimelineItem, b: TimelineItem) {
  return (
    descending(timestamp(a.at), timestamp(b.at)) ||
    descending(a.kind, b.kind) ||
    descending(identity(a), identity(b))
  );
}
/** New head pages retain already loaded history. If a burst leaves a gap, page from the
 * new head's cursor until it is filled; retaining rows never skips the missing interval. */
export function mergeTimeline(
  current: Timeline | null,
  page: Timeline,
  refresh: boolean
): Timeline {
  if (!current || (refresh && page.items.length === 0)) return page;
  const overlap = page.items.some((row) =>
    current.items.some((old) => old.cursor === row.cursor)
  );
  const rows = new Map(current.items.map((row) => [row.cursor, row]));
  for (const row of page.items) rows.set(row.cursor, row);
  return {
    you_are: page.you_are,
    items: [...rows.values()].sort(order),
    next_before: refresh && overlap ? current.next_before : page.next_before,
  };
}
