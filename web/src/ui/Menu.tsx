import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, type LucideIcon } from "lucide-react";
import { ScrollArea } from "./ScrollArea";
import { Icon } from "./Icon";
import { fixedContainingBlock, placeMenu } from "./menuPlacement";
export { placeMenu } from "./menuPlacement";

export type MenuItem = {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  /** Set on every item of a single-choice menu (the Target Format): the item is a menuitemradio, checked when true,
   * and a check mark shows the chosen one. */
  checked?: boolean;
};

type Props = {
  /** The trigger button's accessible name, for example "Account". */
  label: string;
  /** What the trigger shows (an avatar letter, an icon). */
  trigger: ReactNode;
  triggerClassName: string;
  /** Non-interactive content above the items, outside the menu role (the signed-in email). */
  header?: ReactNode;
  items: MenuItem[];
  /** Which edge of the trigger the list lines up with: "end" (its right edge, the default, for menus at the right of
   * a header) or "start" (its left edge, for a control at the left of a row). */
  align?: "start" | "end";
  /** Whether the list opens below the trigger (the default) or above it, for a trigger in a bar fixed to the bottom of
   * the screen (Collection Import's selection bar). */
  side?: "below" | "above";
};

/**
 * A menu button (the avatar menu, Export and the ⋯ menus). The trigger opens a list of menu items below
 * it, aligned to its right edge. Enter, Space, ArrowDown and ArrowUp on the trigger open it; ArrowUp
 * starts at the last item. Inside, ArrowDown, ArrowUp, Home and End move between items, Escape closes
 * and returns focus to the trigger, Tab closes, and a press outside closes. Choosing an item closes the
 * menu, returns focus to the trigger and then runs the item. In a single-choice menu (items with `checked`) the
 * items are menuitemradio, and opening it by click, Enter, Space or ArrowDown starts on the checked item.
 * The in-DOM fixed panel flips and shifts within the visual viewport and follows scrolling triggers.
 * Escape prevents default so document handlers leave it alone. Translation containing blocks are corrected;
 * scaled and rotated ancestors are unsupported. Items are 30 px tall on desktop and 44 px on a phone.
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  header,
  items,
  align = "end",
  side = "below",
}: Props) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<"first" | "last">("first");
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const scrollViewport = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const triggerId = useId();
  const menuId = useId();
  const menuItems = () =>
    Array.from(
      list.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]'
      ) ?? []
    );

  useLayoutEffect(() => {
    if (!open) return;
    let frame = 0;
    const position = () => {
      const node = panel.current;
      const trigger = button.current;
      if (!node || !trigger) return;
      const viewport = window.visualViewport;
      const boundary = {
        left: viewport?.offsetLeft ?? 0,
        top: viewport?.offsetTop ?? 0,
        right:
          (viewport?.offsetLeft ?? 0) +
          (viewport?.width ?? document.documentElement.clientWidth),
        bottom:
          (viewport?.offsetTop ?? 0) +
          (viewport?.height ?? document.documentElement.clientHeight),
      };
      let contained = false;
      for (
        let ancestor = node.parentElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const style = getComputedStyle(ancestor);
        contained ||= fixedContainingBlock(style);
        if (
          (contained &&
            [style.overflowX, style.overflowY].some(
              (value) => value !== "visible"
            )) ||
          /paint|strict|content/.test(style.contain)
        ) {
          const rect = ancestor.getBoundingClientRect();
          boundary.left = Math.max(boundary.left, rect.left);
          boundary.top = Math.max(boundary.top, rect.top);
          boundary.right = Math.min(boundary.right, rect.right);
          boundary.bottom = Math.min(boundary.bottom, rect.bottom);
        }
      }
      const rect = trigger.getBoundingClientRect();
      if (
        rect.bottom <= boundary.top ||
        rect.top >= boundary.bottom ||
        rect.right <= boundary.left ||
        rect.left >= boundary.right
      ) {
        setOpen(false);
        trigger.focus({ preventScroll: true });
        return;
      }
      // Natural-size measurement temporarily expands the scrolling viewport. Preserve its position,
      // since layout can clamp scrollTop to zero while the height cap is removed.
      const savedScrollTop = scrollViewport.current?.scrollTop ?? 0;
      const width = Math.max(0, boundary.right - boundary.left - 16);
      node.style.maxWidth = `${width}px`;
      node.style.minWidth = `min(14rem, ${width}px)`;
      node.style.left = "0px";
      node.style.top = "0px";
      node.style.maxHeight = "none";
      if (scrollViewport.current)
        scrollViewport.current.style.maxHeight = "none";
      const natural = node.getBoundingClientRect();
      const placement = placeMenu({
        trigger: rect,
        panel: natural,
        boundary,
        align,
        side,
      });
      node.style.left = `${placement.left}px`;
      node.style.top = `${placement.top}px`;
      node.style.maxHeight = `${placement.maxHeight}px`;
      if (scrollViewport.current && list.current)
        scrollViewport.current.style.maxHeight = `${Math.max(0, placement.maxHeight - (natural.height - list.current.getBoundingClientRect().height))}px`;
      // Correct translation introduced by a fixed containing block (including Tailwind's individual translate).
      const actual = node.getBoundingClientRect();
      node.style.left = `${placement.left + placement.left - actual.left}px`;
      node.style.top = `${placement.top + placement.top - actual.top}px`;
      const scrolling = scrollViewport.current;
      if (scrolling) {
        scrolling.scrollTop = savedScrollTop;
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && list.current?.contains(focused)) {
          const visible = scrolling.getBoundingClientRect();
          const item = focused.getBoundingClientRect();
          // Resize may cap a formerly unscrolled list. Reveal focus locally without moving the page.
          if (item.bottom > visible.bottom)
            scrolling.scrollTop += item.bottom - visible.bottom;
          else if (item.top < visible.top)
            scrolling.scrollTop -= visible.top - item.top;
        }
      }
      node.style.visibility = "visible";
    };
    const schedule = (event: Event) => {
      // Menu scrolling moves items, not the anchor. Remeasuring here would also disturb keyboard focus scrolling.
      if (event.target instanceof Node && panel.current?.contains(event.target))
        return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(position);
    };
    position();
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [open, align, side, header, items]);

  useEffect(() => {
    if (!open) return;
    const all = menuItems();
    const checked = all.find(
      (item) => item.getAttribute("aria-checked") === "true"
    );
    (start === "last" ? all[all.length - 1] : (checked ?? all[0]))?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, start]);

  function onMenuKeyDown(event: React.KeyboardEvent<HTMLUListElement>) {
    const all = menuItems();
    if (!all.length) return;
    const index = all.indexOf(document.activeElement as HTMLElement);
    let next: number;
    if (event.key === "ArrowDown") next = (index + 1) % all.length;
    else if (event.key === "ArrowUp")
      next = (index - 1 + all.length) % all.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = all.length - 1;
    else if (event.key === "Escape") {
      // Taken here, so document-level Escape handlers (Collection's selection) leave it alone.
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    } else {
      if (event.key === "Tab") setOpen(false);
      return;
    }
    event.preventDefault();
    all[next]?.focus();
  }

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        id={triggerId}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={triggerClassName}
        onClick={() => {
          setStart("first");
          setOpen((previous) => !previous);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setStart(event.key === "ArrowUp" ? "last" : "first");
          setOpen(true);
        }}
      >
        {trigger}
      </button>
      {open && (
        <div
          data-menu-panel=""
          ref={panel}
          style={{ visibility: "hidden" }}
          className="fixed z-(--layer-panel) rounded-panel border border-border-strong bg-surface-raised py-1 text-control text-text"
        >
          {header}
          <ScrollArea viewportRef={scrollViewport}>
            <ul
              ref={list}
              id={menuId}
              role="menu"
              aria-labelledby={triggerId}
              className="m-0 list-none p-0"
              onKeyDown={onMenuKeyDown}
            >
              {items.map((item) => (
                <li key={item.label} role="none">
                  <button
                    type="button"
                    role={
                      item.checked === undefined ? "menuitem" : "menuitemradio"
                    }
                    aria-checked={item.checked}
                    tabIndex={-1}
                    className="box-border flex h-control w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-3 text-left font-sans text-control text-text hover:bg-surface-selected focus-visible:bg-surface-selected phone:h-control-phone"
                    onClick={() => {
                      setOpen(false);
                      button.current?.focus();
                      item.onSelect();
                    }}
                  >
                    {item.checked !== undefined && (
                      <span className="inline-flex w-4 shrink-0 text-accent-strong">
                        {item.checked && <Icon icon={Check} />}
                      </span>
                    )}
                    {item.icon && <Icon icon={item.icon} />}
                    {item.label}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
