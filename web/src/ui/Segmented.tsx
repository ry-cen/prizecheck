import React, { useEffect, useRef, type ReactNode } from "react";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** A count shown after the label and read as part of its name ("Catalog 3"). */
  count?: ReactNode;
};

type Props<T extends string> = {
  /** The tab list's accessible name, for example "Owner controls sections". */
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Unique per page; segment ids are segmentId(idBase, value). */
  idBase: string;
  /** The id of the page's role="tabpanel" element for the selected segment. The page labels that panel
   * with aria-labelledby={segmentId(idBase, value)}. */
  panelId: string;
};

/** The id of a segment, for the panel's aria-labelledby. */
export const segmentId = (idBase: string, value: string) =>
  `${idBase}-tab-${value}`;

/**
 * Segmented sub-tabs (ADR 0012): an ARIA tab list, used for a page's sections (Owner controls, Missing
 * cards). Only the selected tab is in the Tab order; ArrowLeft, ArrowRight, Home and End move focus
 * between tabs, and Enter, Space or a click selects one (manual activation, because selecting can
 * change the address). The row scrolls sideways inside itself when it is wider than the page, never the
 * page.
 *
 * Sizes: segments are drawn 24 px tall on desktop and 30 px on a phone, where each button is a 44 px box
 * around the drawn segment so the whole tap area belongs to the button (a pseudo-element extension would
 * be clipped by the scrolling row).
 *
 * A choice mode for view switches (Spread / Stacked / List, a radio group) is added here when Collection's
 * display settings move onto the kit.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  idBase,
  panelId,
}: Props<T>) {
  const list = useRef<HTMLDivElement>(null);

  // On a phone the row scrolls, so a deep link to a late tab (/owner/rules) shows the selected tab.
  useEffect(() => {
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    list.current
      ?.querySelector('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, []);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const tabs = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    );
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next].focus();
  }

  return (
    <div
      ref={list}
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="box-border flex max-w-full items-center gap-1 overflow-x-auto p-1"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            id={segmentId(idBase, option.value)}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={selected ? panelId : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!selected) onChange(option.value);
            }}
            className="group m-0 box-border inline-flex h-chip shrink-0 cursor-pointer items-center justify-center border-0 bg-transparent p-0 font-sans phone:h-tap phone:min-w-tap"
          >
            <span className="box-border inline-flex h-chip items-center gap-1.5 whitespace-nowrap rounded-control border border-border px-2.5 text-control text-text-muted group-hover:text-text group-aria-selected:border-accent-border group-aria-selected:bg-surface-selected group-aria-selected:text-accent-strong phone:h-control">
              {option.label}
              {option.count !== undefined && (
                <>
                  {" "}
                  <span className="rounded-round bg-surface-raised px-1.5 text-caption tabular-nums text-text-muted">
                    {option.count}
                  </span>
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
