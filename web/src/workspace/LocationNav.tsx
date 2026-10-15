import React from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import type { TreeNode } from "../location_generated";
import { Icon } from "../ui/Icon";
import { isFolder, type LocationIndex } from "./locationTree";

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
  /** The phone drawer: 44 px rows, Add child always shown beside each row, and no sticky tree. Without
   * it, the desktop sidebar: the tree stays in view while the gallery scrolls, so a drag can always
   * reach a leaf, and Add child overlays the row end, shown on hover or keyboard focus. */
  touch?: boolean;
};

const LIST = "m-0 flex list-none flex-col gap-1 p-0";
// The row sets its own font rather than inheriting the page's.
const ROW =
  "box-border m-0 flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border border-solid py-1 pr-2 text-left font-sans text-meta leading-(--line-height)";
const ADD_CHILD =
  "box-border m-0 inline-flex cursor-pointer items-center justify-center rounded-control border border-solid border-transparent p-0 font-sans text-text-muted hover:text-accent-strong";
// Desktop: over the row's end, inset 2 px so the open row's border and a drop ring stay visible; hidden until
// the row is hovered or holds keyboard focus on a device that can hover; a touch screen always shows it.
const ADD_CHILD_SIDEBAR = `${ADD_CHILD} absolute inset-y-0.5 right-0.5 w-6.5 opacity-100 [@media(hover:hover)]:opacity-0 group-hover/entry:opacity-100 group-has-[:focus-visible]/entry:opacity-100`;
const ADD_CHILD_DRAWER = `${ADD_CHILD} size-tap shrink-0 bg-transparent`;

/** A tree row's look: the open Location, a drop target under a tile drag, or a plain row. */
function rowClass({
  touch,
  current,
  folder,
  droppable,
  over,
}: {
  touch: boolean;
  current: boolean;
  folder: boolean;
  droppable: boolean;
  over: boolean;
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
  return `${ROW} ${size} ${look} ${outline}`;
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
  drop,
  touch = false,
}: Props) {
  const branch = (node: TreeNode, level: number): React.ReactNode => {
    const folder = isFolder(node);
    const open = folder && expanded.has(node.id);
    const listId = `${idPrefix}-children-${node.id}`;
    const active = !folder && view === node.id;
    const droppable = !folder && !!drop?.valid.has(node.id);
    return (
      <li key={node.id}>
        <div className="group/entry relative flex min-w-0 items-center">
          <button
            type="button"
            className={rowClass({
              touch,
              current: active,
              folder,
              droppable,
              over: droppable && drop?.over === node.id,
            })}
            data-drop-target={droppable ? node.id : undefined}
            style={indent(level)}
            title={index.path(node.id)}
            aria-expanded={folder ? open : undefined}
            aria-controls={folder && open ? listId : undefined}
            aria-current={active ? "page" : undefined}
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
          </button>
          {onAddChild && node.kind !== "deck" && (
            <button
              type="button"
              className={
                touch
                  ? ADD_CHILD_DRAWER
                  : `${ADD_CHILD_SIDEBAR} ${active ? "bg-surface-selected" : "bg-surface-raised"}`
              }
              aria-label={`Add child location to ${index.path(node.id)}`}
              title="Add child location"
              onClick={() => onAddChild(node.id)}
            >
              <Icon icon={Plus} size={14} />
            </button>
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
            className={rowClass({
              touch,
              current: view === "all",
              folder: false,
              droppable: false,
              over: false,
            })}
            style={indent(0)}
            aria-current={view === "all" ? "page" : undefined}
            onClick={() => onChoose("all")}
          >
            <span className="inline-flex w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">All owned</span>
          </button>
        </li>
        {index.children(null).map((node) => branch(node, 0))}
      </ul>
    </nav>
  );
}
