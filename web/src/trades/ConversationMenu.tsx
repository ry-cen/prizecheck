import type { RefObject } from "react";
import { Ellipsis } from "lucide-react";
import { moreFor } from "../social/blockMessages";
import { Icon } from "../ui/Icon";
import { Menu, type MenuItem } from "../ui/Menu";

const TRIGGER =
  "inline-flex size-control shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-text-muted hover:bg-surface-raised hover:text-text phone:size-tap";

/**
 * The conversation header's ⋯ menu (Trading #302); Report (#303) shows in every state. With no items it
 * renders nothing.
 */
export function ConversationMenu({
  name,
  items,
  anchor,
}: {
  name: string;
  items: MenuItem[];
  anchor: RefObject<HTMLDivElement | null>;
}) {
  if (items.length === 0) return null;
  return (
    <div ref={anchor}>
      <Menu
        label={moreFor(name)}
        trigger={<Icon icon={Ellipsis} />}
        triggerClassName={TRIGGER}
        items={items}
      />
    </div>
  );
}

/** Puts focus back on the menu's ⋯ (after Cancel or a failed command). */
export function focusMenuTrigger(anchor: RefObject<HTMLDivElement | null>) {
  anchor.current
    ?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')
    ?.focus();
}
