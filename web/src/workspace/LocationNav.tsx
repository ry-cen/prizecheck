import React from "react";
import type { TreeNode } from "../location_generated";
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
};

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
}: Props) {
  const branch = (node: TreeNode, level: number): React.ReactNode => {
    const folder = isFolder(node);
    const open = folder && expanded.has(node.id);
    const listId = `${idPrefix}-children-${node.id}`;
    const active = !folder && view === node.id;
    const droppable = !folder && !!drop?.valid.has(node.id);
    return (
      <li key={node.id}>
        <div className="ws-tree-entry">
          <button
            type="button"
            className={`ws-tree-row ${folder ? "ws-tree-folder" : "ws-tree-leaf"}${droppable ? " ws-drop-valid" : ""}${droppable && drop?.over === node.id ? " ws-drop-over" : ""}`}
            data-ws-drop={droppable ? node.id : undefined}
            style={{ "--ws-tree-level": level } as React.CSSProperties}
            title={index.path(node.id)}
            aria-expanded={folder ? open : undefined}
            aria-controls={folder && open ? listId : undefined}
            aria-current={active ? "page" : undefined}
            onClick={() => (folder ? onToggle(node.id) : onChoose(node.id))}
          >
            <span className="ws-tree-chevron" aria-hidden="true">
              {folder ? (open ? "⌄" : "›") : ""}
            </span>
            <span className="ws-tree-name">{node.name}</span>
          </button>
          {onAddChild && node.kind !== "deck" && (
            <button
              type="button"
              className="ws-add-child"
              aria-label={`Add child location to ${index.path(node.id)}`}
              title="Add child location"
              onClick={() => onAddChild(node.id)}
            >
              <span aria-hidden="true">+</span>
            </button>
          )}
        </div>
        {open && (
          <ul id={listId} aria-label={node.name}>
            {index.children(node.id).map((child) => branch(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };
  return (
    <nav aria-label="Locations" className="ws-tree">
      <ul>
        <li>
          <button
            type="button"
            className="ws-tree-row ws-tree-leaf"
            style={{ "--ws-tree-level": 0 } as React.CSSProperties}
            aria-current={view === "all" ? "page" : undefined}
            onClick={() => onChoose("all")}
          >
            <span className="ws-tree-chevron" aria-hidden="true" />
            <span className="ws-tree-name">All owned</span>
          </button>
        </li>
        {index.children(null).map((node) => branch(node, 0))}
      </ul>
    </nav>
  );
}
