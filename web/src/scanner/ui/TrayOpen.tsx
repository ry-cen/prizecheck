import { ChevronDown } from "lucide-react";
import { useRef, type Ref } from "react";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import type { TrayRow } from "../tray/store";
import {
  cardsText,
  CLEAR_TRAY,
  DISMISS,
  LOCATIONS_UNAVAILABLE,
  openLocation,
  confirmLabel,
  EDITIONS_NOTE,
  EMPTY_TRAY,
  KEEP_SCANNING,
  LOCKED_LINE,
  NOT_FINISHED_LINE,
  OFFLINE_LINE,
  PUT_CARDS_IN,
  RETRY,
  SHOW,
  STALE_SAVE_NOTE,
  staleBanner,
  staleFooter,
  TRAY,
} from "./copy";
import { ScrollArea } from "../../ui/ScrollArea";
import type { RowView } from "./rowView";
import { swipeHandlers } from "./TrayPeek";
import { TrayRowItem, type RowActions } from "./TrayRowItem";

export type OpenRow = { row: TrayRow; view: RowView };

export type OpenModel = {
  rows: OpenRow[];
  total: number;
  needs: number;
  frozen: boolean;
  /** The confirm request is in flight now. */
  saving: boolean;
  offline: boolean;
  /** The destination's path, or null while the Locations load. */
  where: string | null;
  canConfirm: boolean;
  staleSave: boolean;
  editionsNote: boolean;
  /** A refusal or failure line from the last edit or save. */
  message: string | null;
  /** The Locations could not be read, so the destination is unknown. */
  destinationsFailed: boolean;
};

/** The tray open: 85% of the height, over the paused camera. Everything a collector needs to review and add. */
export function TrayOpen({
  model,
  actions,
  keepRef,
  onKeep,
  onDestination,
  onClear,
  onConfirm,
  onOpenDestination,
  onDismissStaleSave,
  rowRef,
}: {
  model: OpenModel;
  actions: RowActions;
  keepRef: Ref<HTMLButtonElement>;
  onKeep: () => void;
  onDestination: () => void;
  onClear: () => void;
  onConfirm: () => void;
  onOpenDestination: () => void;
  onDismissStaleSave: () => void;
  rowRef: (rowId: string, element: HTMLElement | null) => void;
}) {
  const next = useRef(0);
  const needing = model.rows.filter((r) => r.row.needs_pick);
  const showNext = () => {
    if (needing.length === 0) return;
    const target = needing[next.current % needing.length];
    next.current += 1;
    document
      .getElementById(`tray-row-${target.row.id}`)
      ?.scrollIntoView({ block: "center" });
    document.getElementById(`tray-row-${target.row.id}`)?.focus();
  };
  const n = model.needs;
  const lines: { text: string; warn?: boolean }[] = [];
  if (model.frozen) lines.push({ text: LOCKED_LINE });
  if (model.frozen && !model.saving)
    lines.push({ text: NOT_FINISHED_LINE, warn: true });
  if (!model.frozen && model.offline) lines.push({ text: OFFLINE_LINE });
  if (!model.frozen && n > 0) lines.push({ text: staleFooter(n), warn: true });
  if (!model.frozen && model.destinationsFailed)
    lines.push({ text: LOCATIONS_UNAVAILABLE });
  if (model.message) lines.push({ text: model.message, warn: true });
  const label = model.saving
    ? `Adding ${cardsText(model.total)}…`
    : model.frozen
      ? RETRY
      : model.total > 0
        ? confirmLabel(model.total, model.where ?? "…")
        : model.where
          ? `Add cards to ${model.where}`
          : "Add cards";
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={TRAY}
      className="absolute inset-x-0 bottom-0 z-10 box-border flex h-[85dvh] flex-col rounded-t-dialog border-x border-t border-border-strong bg-surface"
    >
      <div
        {...swipeHandlers(undefined, onKeep)}
        className="flex touch-none flex-col items-center gap-1 px-4 pb-2 pt-1"
      >
        <span
          aria-hidden="true"
          className="h-1 w-10 rounded-round bg-border-strong"
        />
        <div className="flex w-full items-center gap-3">
          <h2 className="m-0 text-body font-semibold text-text">{TRAY}</h2>
          <span className="grow text-body tabular-nums text-text-muted">
            {model.total > 0 ? cardsText(model.total) : "Empty"}
          </span>
          <Button ref={keepRef} variant="quiet" onClick={onKeep}>
            {KEEP_SCANNING}
          </Button>
        </div>
      </div>
      <div className="px-4 pb-2">
        <button
          type="button"
          aria-haspopup="dialog"
          disabled={model.frozen || model.where === null}
          onClick={onDestination}
          className="box-border flex min-h-control w-full cursor-pointer items-center justify-between gap-3 rounded-control border border-control-outline bg-bg px-3 text-left font-sans text-control text-text disabled:cursor-default disabled:opacity-45 phone:min-h-tap"
        >
          <span className="text-text-muted">{PUT_CARDS_IN}</span>
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate">{model.where ?? "…"}</span>
            <Icon icon={ChevronDown} />
          </span>
        </button>
      </div>
      <ScrollArea
        className="grow"
        viewportClassName="flex flex-col gap-3 px-4 pb-3"
      >
        {model.staleSave && (
          <div className="flex flex-wrap items-center gap-2 rounded-panel border border-warning p-3 text-control text-text">
            <span className="grow basis-48">{STALE_SAVE_NOTE}</span>
            <Button variant="quiet" onClick={onOpenDestination}>
              {openLocation(model.where ?? "Collection")}
            </Button>
            <Button variant="quiet" onClick={onDismissStaleSave}>
              {DISMISS}
            </Button>
          </div>
        )}
        {model.editionsNote && n > 0 && (
          <p className="m-0 rounded-panel border border-warning p-3 text-control text-text">
            {EDITIONS_NOTE}
          </p>
        )}
        {n > 0 && !model.frozen && (
          <div className="flex flex-wrap items-center gap-2 rounded-panel border border-warning p-3 text-control text-text">
            <span className="grow basis-48">{staleBanner(n)}</span>
            <Button onClick={showNext}>{SHOW}</Button>
          </div>
        )}
        {model.rows.length === 0 ? (
          <p className="m-0 text-body text-text-muted">{EMPTY_TRAY}</p>
        ) : (
          <ul
            aria-label="Cards in the tray"
            className="m-0 flex list-none flex-col gap-2 p-0"
          >
            {model.rows.map(({ row, view }) => (
              <TrayRowItem
                key={row.id}
                row={row}
                view={view}
                frozen={model.frozen}
                offline={model.offline}
                actions={actions}
                rowRef={(element) => {
                  if (element) element.id = `tray-row-${row.id}`;
                  rowRef(row.id, element);
                }}
              />
            ))}
          </ul>
        )}
        {model.rows.length > 0 && (
          <div>
            <Button variant="quiet" disabled={model.frozen} onClick={onClear}>
              {CLEAR_TRAY}
            </Button>
          </div>
        )}
      </ScrollArea>
      <footer className="flex flex-col gap-2 border-t border-border bg-surface px-4 py-3">
        {lines.map((line) => (
          <p
            key={line.text}
            role="status"
            className={`m-0 text-meta ${line.warn ? "text-warning" : "text-text-muted"}`}
          >
            {line.text}
          </p>
        ))}
        <Button
          variant="primary"
          className="w-full"
          disabled={!model.saving && !model.frozen && !model.canConfirm}
          aria-disabled={model.saving || undefined}
          aria-busy={model.saving || undefined}
          onClick={model.saving ? undefined : onConfirm}
        >
          {label}
        </Button>
      </footer>
    </section>
  );
}
