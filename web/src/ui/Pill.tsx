import type { ReactNode } from "react";

/** ok: fine; warn: needs attention soon; bad: wrong now; unverified: no recent measurement; neutral: no
 * judgement (a status such as "pending"). */
export type PillTone = "ok" | "warn" | "bad" | "unverified" | "neutral";

const TONES: Record<PillTone, string> = {
  ok: "border-accent-border text-accent-strong",
  warn: "border-warning text-warning",
  bad: "border-danger-border text-danger",
  unverified: "border-dashed border-control-outline text-text-muted",
  neutral: "border-border-strong text-text-muted",
};

/**
 * A status badge (ADR 0012): 24 px tall at every width, because it can't be pressed. The text must say
 * the status on its own ("Stale", "70% warning", "Unverified"); the tone's colour only repeats it.
 * A Pill that opens something is a control with a 44 px phone tap area, not this.
 */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: PillTone;
  children: ReactNode;
}) {
  return (
    <span
      className={`box-border inline-flex h-chip max-w-full items-center whitespace-nowrap rounded-round border px-2 text-caption font-medium leading-none ${TONES[tone]}`}
    >
      {/* One inline run, so the spaces around a mark ("Standard · ✕ Not legal") aren't dropped at flex item edges. */}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}
