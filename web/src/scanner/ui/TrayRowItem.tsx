import { Button } from "../../ui/Button";
import { ChoiceChips } from "../../ui/Chip";
import { Pill } from "../../ui/Pill";
import { MAX_ROW_COUNT, type TrayRow } from "../tray/store";
import { CardArt } from "./CardArt";
import { CHANGE_CARD, PICK_A_FINISH } from "./copy";
import { CountStepper } from "./CountStepper";
import type { RowView } from "./rowView";

export type RowActions = {
  setEdition(rowId: string, editionId: string): void;
  setCount(rowId: string, count: number): void;
  remove(rowId: string): void;
  change(rowId: string, opener: HTMLElement): void;
};

/** One tray row: the card, its set and number, one-tap finish chips, the copies stepper and Change card. A row that
 * needs a finish shows no chip selected and says so; a row whose Printing is gone shows no chips. */
export function TrayRowItem({
  row,
  view,
  frozen,
  offline,
  actions,
  rowRef,
}: {
  row: TrayRow;
  view: RowView;
  /** A save is pending: the whole tray is read-only. */
  frozen: boolean;
  /** The printings route is unreachable: finishes and Confirm wait for the connection. */
  offline: boolean;
  actions: RowActions;
  rowRef: (element: HTMLElement | null) => void;
}) {
  // A row that needs a finish shows even one remaining finish as a chip to tap.
  const showChips =
    !view.printingGone &&
    (view.options.length > 1 || (row.needs_pick && view.options.length > 0));
  return (
    <li
      ref={rowRef}
      tabIndex={-1}
      aria-label={`${view.name}${view.setLine ? `, ${view.setLine}` : ""}`}
      className={`m-0 flex list-none items-start gap-3 rounded-panel border bg-surface p-3 outline-none focus-visible:outline-2 focus-visible:outline-focus ${row.needs_pick ? "border-warning" : "border-border"}`}
    >
      <CardArt src={view.image} />
      <div className="flex min-w-0 grow flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-body font-semibold text-text">{view.name}</span>
          {row.needs_pick && <Pill tone="warn">{PICK_A_FINISH}</Pill>}
        </div>
        <span className="text-meta text-text-muted">
          {view.setLine}
          {view.onlyFinish && !offline ? ` · ${view.onlyFinish}` : ""}
        </span>
        {view.staleReason && (
          <span className="text-meta text-warning">{view.staleReason}</span>
        )}
        {showChips && (
          <ChoiceChips
            label={`Finish of ${view.name}`}
            options={view.options}
            value={view.selected}
            disabled={frozen || offline}
            onChange={(edition) => actions.setEdition(row.id, edition)}
          />
        )}
        <div>
          <Button
            disabled={frozen || offline}
            onClick={(event) => actions.change(row.id, event.currentTarget)}
          >
            {CHANGE_CARD}
          </Button>
        </div>
      </div>
      <CountStepper
        name={view.name}
        count={row.count}
        max={MAX_ROW_COUNT}
        disabled={frozen}
        onSet={(count) => actions.setCount(row.id, count)}
        onRemove={() => actions.remove(row.id)}
      />
    </li>
  );
}
