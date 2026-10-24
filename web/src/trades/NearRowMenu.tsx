import { Ellipsis } from "lucide-react";
import type { NearbyMatchRow } from "../social_generated";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";
import { rowMenuLabel } from "./nearYouMessages";

/**
 * The ⋯ menu of a Near you row. Block and Report arrive with Trading #302 and #303; with no item it renders nothing,
 * so no empty menu reaches the page.
 */
export function NearRowMenu(props: {
  row: NearbyMatchRow;
  onChanged: () => void;
}) {
  const items: MenuItem[] = [];
  // #302 appends Block here and #303 Report; onChanged reloads Near you after one of them.
  if (items.length === 0) return null;
  return (
    <Menu
      label={rowMenuLabel(props.row.display_name)}
      triggerClassName="inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap"
      trigger={<Icon icon={Ellipsis} />}
      items={items}
    />
  );
}
