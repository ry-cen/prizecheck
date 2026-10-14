import type { ReportView } from "../generated";
import type { PillTone } from "../ui/Pill";

/** The card a report names, as today's page wrote it ("Pikachu · Jungle #99"). */
export function reportLabel(report: ReportView): string {
  return report.kind === "printing"
    ? `${report.english_name || "Unnamed Printing"} · ${report.set_name || report.set_id || "Unknown set"} #${report.collector_number || "?"}`
    : `Edition of Printing ${report.printing_id || "?"}`;
}

export function reportKind(report: ReportView): string {
  return report.kind === "printing" ? "Missing Printing" : "Missing Edition";
}

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  pending: { label: "Pending", tone: "neutral" },
  needs_info: { label: "Needs information", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  rejected: { label: "Rejected", tone: "bad" },
};

/** A report's status in words, with the Pill tone that repeats it. */
export function reportStatus(status: string): {
  label: string;
  tone: PillTone;
} {
  return STATUS[status] ?? { label: status.replace("_", " "), tone: "neutral" };
}

/** A date in the collector's own locale, for example "Oct 13, 2026". */
export function reportDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
