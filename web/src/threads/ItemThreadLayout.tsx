import type { ReactNode } from "react";
import "./item-thread.css";

/** The live agreement precedes its own chat at narrow widths and sits beside it on wide screens. */
export function ItemThreadLayout({
  label,
  children,
  timeline,
}: {
  label: string;
  children: ReactNode;
  timeline?: ReactNode;
}) {
  return (
    <section aria-label={label} className="item-thread">
      <div className="item-thread-agreement">{children}</div>
      {timeline && <div className="item-thread-timeline">{timeline}</div>}
    </section>
  );
}
