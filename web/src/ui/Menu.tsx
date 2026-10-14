import React, {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, type LucideIcon } from "lucide-react";
import { Icon } from "./Icon";

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
};

/**
 * A menu button (the avatar menu, Export and the ⋯ menus). The trigger opens a list of menu items below
 * it, aligned to its right edge. Enter, Space, ArrowDown and ArrowUp on the trigger open it; ArrowUp
 * starts at the last item. Inside, ArrowDown, ArrowUp, Home and End move between items, Escape closes
 * and returns focus to the trigger, Tab closes, and a press outside closes. Choosing an item closes the
 * menu, returns focus to the trigger and then runs the item. In a single-choice menu (items with `checked`) the
 * items are menuitemradio, and opening it by click, Enter, Space or ArrowDown starts on the checked item.
 * Items are 30 px tall on desktop and 44 px on a phone.
 */
export function Menu({
  label,
  trigger,
  triggerClassName,
  header,
  items,
  align = "end",
}: Props) {
  const [open, setOpen] = useState(false);
  const [start, setStart] = useState<"first" | "last">("first");
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const triggerId = useId();
  const menuId = useId();
  const menuItems = () =>
    Array.from(
      list.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"]'
      ) ?? []
    );

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
          className={`absolute top-full z-(--layer-panel) mt-1 min-w-56 rounded-panel border border-border-strong bg-surface-raised py-1 text-control text-text ${
            align === "start" ? "left-0" : "right-0"
          }`}
        >
          {header}
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
        </div>
      )}
    </div>
  );
}
