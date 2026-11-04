import { useRef } from "react";
import { Ellipsis } from "lucide-react";
import { Menu } from "../ui/Menu";
import { Icon } from "../ui/Icon";
import { useTraderBlock, type BlockTarget } from "../trades/TraderBlock";
import { useTraderReport } from "../trades/TraderReport";

/** The item chat keeps the existing Block and Report safeguards, independently of offer actions. */
export function ThreadMenu({
  target,
  canMessage,
  canReport,
  offerId,
  onChanged,
}: {
  target: BlockTarget;
  canMessage: boolean;
  canReport: boolean;
  offerId?: string;
  onChanged: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const returnFocus = () =>
    anchor.current?.querySelector<HTMLButtonElement>("button")?.focus();
  const block = useTraderBlock(canMessage ? target : null, {
    onBlocked: onChanged,
    returnFocus,
  });
  const report = useTraderReport(
    canReport ? { ...target, tradeId: offerId } : null,
    {
      source: offerId ? "trade" : "conversation",
      onReported: onChanged,
      returnFocus,
    }
  );
  const items = [
    ...(block.item ? [block.item] : []),
    ...(report.item ? [report.item] : []),
  ];
  return (
    <>
      {items.length > 0 && (
        <div ref={anchor}>
          <Menu
            label={`More for ${target.name}`}
            trigger={<Icon icon={Ellipsis} />}
            triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
            items={items}
          />
        </div>
      )}
      {block.panel}
      {report.panel}
    </>
  );
}
