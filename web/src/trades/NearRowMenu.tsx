import { useRef } from "react";
import { Ellipsis } from "lucide-react";
import type { NearbyMatchRow } from "../social_generated";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { focusMenuTrigger } from "./ConversationMenu";
import { rowMenuLabel } from "./nearYouMessages";
import { useTraderBlock } from "./TraderBlock";
import { useTraderReport } from "./TraderReport";

/**
 * The ⋯ menu of a Near you row: Block (Trading #302) and Report (#303). With no item it renders nothing, so no empty
 * menu reaches the page. The Block question and failure, and the Report form, show under the row's buttons. A Block
 * or Report removes the row, so its status goes to `onBlocked` (Near you keeps it) and `onChanged` reloads the list.
 */
export function NearRowMenu(props: {
  row: NearbyMatchRow;
  onChanged: () => void;
  onBlocked: (status: string) => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const block = useTraderBlock(
    {
      traderId: props.row.trader_id,
      name: props.row.display_name,
      handle: null,
    },
    {
      statusElsewhere: true,
      onBlocked: (status) => {
        props.onBlocked(status);
        props.onChanged();
      },
      returnFocus: () => focusMenuTrigger(anchor),
    }
  );
  const report = useTraderReport(
    {
      traderId: props.row.trader_id,
      name: props.row.display_name,
      handle: null,
    },
    {
      source: "discovery",
      statusElsewhere: true,
      onReported: (status) => {
        props.onBlocked(status);
        props.onChanged();
      },
      returnFocus: () => focusMenuTrigger(anchor),
    }
  );
  const items: MenuItem[] = [];
  if (block.item) items.push(block.item);
  if (report.item) items.push(report.item);
  if (items.length === 0) return null;
  return (
    <>
      <div ref={anchor}>
        <Menu
          label={rowMenuLabel(props.row.display_name)}
          triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
          trigger={<Icon icon={Ellipsis} />}
          items={items}
        />
      </div>
      <div className="flex basis-full flex-col gap-2 empty:hidden">
        {block.panel}
        {report.panel}
      </div>
    </>
  );
}
