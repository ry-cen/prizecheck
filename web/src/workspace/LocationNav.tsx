import React from "react";
import {
  ChevronDown,
  ChevronRight,
  EyeOff,
  Plus,
  Settings,
} from "lucide-react";
import type { TreeNode } from "../location_generated";
import { Icon } from "../ui/Icon";
import {
  forTradeLabel,
  hidingLabel,
  isFolder,
  type LocationIndex,
} from "./locationTree";

/** The workspace view: All owned or one Storage Leaf (including a Deck) by id. */
export type WorkspaceView = "all" | string;

/** While tiles are dragged (ticket 107): the Storage Leaves a drop can move them to, and the one
 * under the pointer. */
export type DropTargets = { valid: ReadonlySet<string>; over: string | null };

type Props = {
  index: LocationIndex;
  view: WorkspaceView;
  expanded: ReadonlySet<string>;
  onToggle: (folderId: string) => void;
  onChoose: (view: WorkspaceView) => void;
  /** Distinguishes element ids when the tree renders twice (sidebar and drawer). */
  idPrefix: string;
  /** Opens the create form with this parent preselected. Deck rows get no Add child control. */
  onAddChild?: (parentId: string) => void;
  /** Set during a tile drag: valid leaves are highlighted and marked as drop targets. */
  drop?: DropTargets | null;
  /** Opens this Location's settings (#292). The opener is the gear that was pressed. Every row gets the gear. */
  onOpenSettings?: (id: string, opener: HTMLButtonElement) => void;
  /** The phone drawer: 44 px rows, Add child and the settings gear always shown beside each row, and no
   * sticky tree. Without it, the desktop sidebar: the tree stays in view while the gallery scrolls, so a
   * drag can always reach a leaf. Add child and the gear overlay the row end, shown for the open Location
   * or on hover or keyboard focus (always, on a device without hover). */
  touch?: boolean;
  /** The Lent out entry (social network #253): copies lent to Friends, in no Location, and what opens their list.
   * Shown only while some copies are out. */
  lent?: { copies: string; onOpen: () => void } | null;
  /** The Borrowed entry (social network #254): Friends' copies in the collector's Locations, and what opens their
   * list. Shown only while some are here. */
  borrowed?: { copies: string; onOpen: () => void } | null;
};

const LIST = "m-0 flex list-none flex-col gap-1 p-0";
// The row sets its own font rather than inheriting the page's.
const ROW =
  "box-border m-0 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border border-solid py-1 text-left font-sans text-meta leading-(--line-height)";
const TOOL =
  "box-border m-0 inline-flex cursor-pointer items-center justify-center rounded-control border border-solid border-transparent p-0 font-sans text-text-muted hover:text-accent-strong";
// Desktop: the tools overlay the row's end, inset 2 px from the end and 1 px top and bottom, so the open row's
// border shows; hidden during a tile drag so the drop ring shows;
// The open row always shows them and reserves room; other rows reveal them on hover or keyboard focus.
// A device without hover always shows them, with room reserved.
const TOOLS_SIDEBAR =
  "pointer-events-none absolute inset-y-0 right-0.5 flex items-center";
const TOOL_SIDEBAR = `${TOOL} pointer-events-auto size-control opacity-100`;
const TOOL_DRAWER = `${TOOL} size-tap shrink-0 bg-transparent`;

/** A tree row's look: the open Location, a drop target under a tile drag, or a plain row. */
function rowClass({
  touch,
  current,
  folder,
  droppable,
  over,
  tools,
}: {
  touch: boolean;
  current: boolean;
  folder: boolean;
  droppable: boolean;
  over: boolean;
  /** How many tools (Add child, the gear) overlay the row's end on desktop. */
  tools: 0 | 1 | 2;
}) {
  const size = touch ? "min-h-tap" : "min-h-8";
  // Drop targets: a dashed outline on each valid Storage Leaf, a solid ring and a wash on the one under the
  // pointer (shape as well as colour).
  const outline = droppable
    ? over
      ? "outline-2 outline-solid outline-accent -outline-offset-2"
      : "outline-2 outline-dashed outline-accent-outline -outline-offset-2"
    : "";
  const look = current
    ? "border-accent-border bg-surface-selected font-semibold text-accent-strong"
    : `border-transparent font-normal ${folder ? "text-text-muted" : "text-text"} ${droppable && over ? "bg-accent-wash" : "bg-transparent hover:bg-surface-raised group-hover/entry:bg-surface-raised"}`;
  const padding = touch
    ? "pr-2"
    : tools === 0
      ? "pr-2"
      : tools === 1
        ? `pr-9 ${current ? "" : "[@media(hover:hover)]:pr-2"}`
        : `pr-17 ${current ? "" : "[@media(hover:hover)]:pr-2"}`;
  return `${ROW} ${size} ${padding} ${look} ${outline}`;
}

/** Indent by level: 8 px, then 12 px per level. */
const indent = (level: number): React.CSSProperties => ({
  paddingLeft: `calc(var(--space-2) + ${level} * var(--space-3))`,
});

/** The Location tree shared by the desktop sidebar and the mobile drawer.
 * Folders are disclosure buttons; Storage Leaves and Decks open the gallery. */
export function LocationNav({
  index,
  view,
  expanded,
  onToggle,
  onChoose,
  idPrefix,
  onAddChild,
  onOpenSettings,
  drop,
  touch = false,
  lent,
  borrowed,
}: Props) {
  // Lent out (#253) and Borrowed (#254): an entry that opens a list, with its copy count, while the count isn't 0.
  const listEntry = (
    label: string,
    entry: { copies: string; onOpen: () => void } | null | undefined
  ) =>
    entry &&
    entry.copies !== "0" && (
      <li>
        <button
          type="button"
          className={rowClass({
            touch,
            current: false,
            folder: false,
            droppable: false,
            over: false,
            tools: 0,
          })}
          style={indent(0)}
          aria-haspopup="dialog"
          onClick={entry.onOpen}
        >
          <span className="inline-flex w-3 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <span className="shrink-0 text-text-muted tabular-nums">
            {entry.copies}
          </span>
        </button>
      </li>
    );
  const branch = (node: TreeNode, level: number): React.ReactNode => {
    const folder = isFolder(node);
    const open = folder && expanded.has(node.id);
    const listId = `${idPrefix}-children-${node.id}`;
    const active = !folder && view === node.id;
    const droppable = !folder && !!drop?.valid.has(node.id);
    // A hidden Location keeps its name as the button's name; the eye-off mark says why, read as its description.
    const hidden = hidingLabel(index.hiding(node.id));
    const hiddenId = hidden ? `${idPrefix}-hidden-${node.id}` : undefined;
    // A For trade Location (Trading #282) is marked the same way; both marks can show on one row.
    const forTrade = forTradeLabel(index.forTrade(node.id));
    const forTradeId = forTrade
      ? `${idPrefix}-for-trade-${node.id}`
      : undefined;
    const describedBy =
      [hiddenId, forTradeId].filter(Boolean).join(" ") || undefined;
    const path = index.path(node.id);
    const addChild = !!onAddChild && node.kind !== "deck";
    const tools = (addChild ? 1 : 0) + (onOpenSettings ? 1 : 0);
    // Add child (+), then the settings gear at the row's right end.
    const addChildButton = (className: string) =>
      addChild && (
        <button
          type="button"
          className={className}
          aria-label={`Add child location to ${path}`}
          title="Add child location"
          onClick={() => onAddChild?.(node.id)}
        >
          <Icon icon={Plus} size={14} />
        </button>
      );
    const gearButton = (className: string) =>
      onOpenSettings && (
        <button
          type="button"
          className={className}
          id={`${idPrefix}-settings-${node.id}`}
          aria-label={`Settings for ${path}`}
          title="Settings"
          aria-haspopup="dialog"
          onClick={(event) => onOpenSettings(node.id, event.currentTarget)}
        >
          <Icon icon={Settings} size={14} />
        </button>
      );
    const toolClass = `${TOOL_SIDEBAR} ${active ? "bg-surface-selected" : "bg-surface-raised [@media(hover:hover)]:opacity-0 group-hover/entry:opacity-100 group-has-[:focus-visible]/entry:opacity-100"}`;
    return (
      <li key={node.id}>
        <div className="group/entry relative flex min-w-0 items-center">
          <button
            type="button"
            id={`${idPrefix}-row-${node.id}`}
            className={rowClass({
              touch,
              current: active,
              folder,
              droppable,
              over: droppable && drop?.over === node.id,
              tools: tools as 0 | 1 | 2,
            })}
            data-drop-target={droppable ? node.id : undefined}
            style={indent(level)}
            title={path}
            aria-expanded={folder ? open : undefined}
            aria-controls={folder && open ? listId : undefined}
            aria-current={active ? "page" : undefined}
            aria-describedby={describedBy}
            onClick={() => (folder ? onToggle(node.id) : onChoose(node.id))}
          >
            <span
              className="inline-flex w-3 shrink-0 justify-center text-text-subtle"
              aria-hidden="true"
            >
              {folder && (
                <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
              )}
            </span>
            <span className="min-w-0 truncate">{node.name}</span>
            {hidden && (
              <span
                className="inline-flex shrink-0 text-text-subtle"
                title={hidden}
                data-testid="hidden-mark"
              >
                <Icon icon={EyeOff} size={12} />
              </span>
            )}
            {forTrade && (
              <span
                className="shrink-0 whitespace-nowrap text-meta text-text-subtle"
                title={forTrade}
                aria-hidden="true"
                data-testid="for-trade-mark"
              >
                For trade
              </span>
            )}
          </button>
          {hiddenId && (
            <span id={hiddenId} hidden>
              {hidden}
            </span>
          )}
          {forTradeId && (
            <span id={forTradeId} hidden>
              {forTrade}
            </span>
          )}
          {touch ? (
            <>
              {addChildButton(TOOL_DRAWER)}
              {gearButton(TOOL_DRAWER)}
            </>
          ) : (
            tools > 0 && (
              <span className={`${TOOLS_SIDEBAR}${drop ? " invisible" : ""}`}>
                {addChildButton(toolClass)}
                {gearButton(toolClass)}
              </span>
            )
          )}
        </div>
        {open && (
          <ul id={listId} aria-label={node.name} className={`${LIST} mt-1`}>
            {index.children(node.id).map((child) => branch(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };
  return (
    <nav
      aria-label="Locations"
      className={
        touch
          ? undefined
          : "sticky top-[calc(var(--space-4)+var(--layout-sticky-top))]"
      }
    >
      <ul className={LIST}>
        <li>
          <button
            type="button"
            id={`${idPrefix}-all`}
            className={rowClass({
              touch,
              current: view === "all",
              folder: false,
              droppable: false,
              over: false,
              tools: 0,
            })}
            style={indent(0)}
            aria-current={view === "all" ? "page" : undefined}
            onClick={() => onChoose("all")}
          >
            <span className="inline-flex w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">All owned</span>
          </button>
        </li>
        {listEntry("Lent out", lent)}
        {listEntry("Borrowed", borrowed)}
        {index.children(null).map((node) => branch(node, 0))}
      </ul>
    </nav>
  );
}
