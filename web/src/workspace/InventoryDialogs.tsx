import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import type { TreeNode } from "../location_generated";
import { plural } from "./galleryModel";
import {
  groupRemovalRows,
  movePreview,
  type RemovalRow,
} from "./inventoryActionsModel";
import { isFolder, type LocationIndex } from "./locationTree";
import type { SelectedGroup } from "./selectionModel";
import "./InventoryActions.css";

type ShellProps = {
  titleId: string;
  className: string;
  busy: boolean;
  /** `forced` is true when the browser closed the dialog itself. */
  onCancel: (forced?: boolean) => void;
  children: React.ReactNode;
};

/** A native modal dialog: a centred panel on desktop, a bottom sheet on mobile. The page behind is
 * inert. Escape, Cancel and a backdrop press close it, except while an action is running.
 * The element marked data-autofocus takes focus when it opens; the caller restores focus on close. */
function ActionDialog({
  titleId,
  className,
  busy,
  onCancel,
  children,
}: ShellProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const live = useRef({ busy, onCancel });
  live.current = { busy, onCancel };
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`ws-action-dialog ${className}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: React state decides when the dialog closes.
        event.preventDefault();
        if (!live.current.busy) live.current.onCancel();
      }}
      onClose={() => {
        // The browser can force a close (a repeated Escape); keep React state in step.
        if (!ref.current?.open) live.current.onCancel(true);
      }}
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a press and release both on the backdrop closes.
        const backdrop =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (backdrop && !live.current.busy) live.current.onCancel();
      }}
    >
      {children}
    </dialog>
  );
}

/** Progress (polite) and the inline error of a running or failed action. */
function Feedback({ progress, error }: { progress: string; error: string }) {
  return (
    <>
      <p className="ws-action-progress" role="status">
        {progress}
      </p>
      {error && (
        <p className="ws-action-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

type MoveProps = {
  index: LocationIndex;
  /** The sidebar's open folders; the explorer starts with the same ones open. */
  initialExpanded: ReadonlySet<string>;
  groups: SelectedGroup[];
  copies: number;
  busy: boolean;
  progress: string;
  error: string;
  onConfirm: (destinationId: string) => void;
  onCancel: (forced?: boolean) => void;
};

/** Every Storage Leaf and Deck in tree order (natural A–Z, depth first). */
function leavesOf(index: LocationIndex): TreeNode[] {
  const result: TreeNode[] = [];
  const visit = (parentId: string | null) => {
    for (const node of index.children(parentId)) {
      if (isFolder(node)) visit(node.id);
      else result.push(node);
    }
  };
  visit(null);
  return result;
}

/** Actions → Move: a searchable folder-style explorer. Organizational Locations expand; only Storage
 * Leaves and Decks can be chosen. The full path and the copies that actually move show before
 * confirmation, which is disabled when every selected copy is already at the destination. */
export function MoveDialog({
  index,
  initialExpanded,
  groups,
  copies,
  busy,
  progress,
  error,
  onConfirm,
  onCancel,
}: MoveProps) {
  const titleId = useId();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(initialExpanded)
  );
  const [destination, setDestination] = useState<string | null>(null);

  // A destination that left the tree or became a folder can't be chosen any more.
  useEffect(() => {
    if (!destination) return;
    const node = index.byId.get(destination);
    if (!node || isFolder(node)) setDestination(null);
  }, [index, destination]);

  const leaves = useMemo(() => leavesOf(index), [index]);
  const needle = query.trim().toLocaleLowerCase();
  const matches = needle
    ? leaves.filter((node) =>
        index.path(node.id).toLocaleLowerCase().includes(needle)
      )
    : [];
  const preview = destination ? movePreview(groups, destination) : null;
  const canConfirm = !!destination && !!preview && preview.moving > 0;

  function toggle(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const leafButton = (node: TreeNode, label: string, level: number) => (
    <button
      type="button"
      className="ws-explorer-row ws-explorer-leaf"
      style={{ "--ws-tree-level": level } as React.CSSProperties}
      aria-pressed={destination === node.id}
      title={index.path(node.id)}
      onClick={() => setDestination(node.id)}
    >
      <span className="ws-explorer-name">{label}</span>
      {node.kind === "deck" && <span className="ws-explorer-kind">Deck</span>}
      {destination === node.id && (
        <span className="ws-explorer-check" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );

  const branch = (node: TreeNode, level: number): React.ReactNode => {
    if (!isFolder(node))
      return <li key={node.id}>{leafButton(node, node.name, level)}</li>;
    const open = expanded.has(node.id);
    return (
      <li key={node.id}>
        <button
          type="button"
          className="ws-explorer-row ws-explorer-folder"
          style={{ "--ws-tree-level": level } as React.CSSProperties}
          aria-expanded={open}
          title={index.path(node.id)}
          onClick={() => toggle(node.id)}
        >
          <span className="ws-explorer-chevron" aria-hidden="true">
            {open ? "⌄" : "›"}
          </span>
          <span className="ws-explorer-name">{node.name}</span>
        </button>
        {open && (
          <ul aria-label={node.name}>
            {index.children(node.id).map((child) => branch(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <ActionDialog
      titleId={titleId}
      className="ws-move-dialog"
      busy={busy}
      onCancel={onCancel}
    >
      <div className="ws-action-body">
        <h2 id={titleId}>Move {plural(copies, "copy", "copies")}</h2>
        <input
          type="search"
          className="ws-explorer-search"
          aria-label="Search locations"
          placeholder="Find a location…"
          autoComplete="off"
          data-autofocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="ws-explorer">
          {needle ? (
            matches.length ? (
              <ul aria-label="Matching locations">
                {matches.map((node) => (
                  <li key={node.id}>
                    {leafButton(node, index.path(node.id), 0)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="ws-explorer-empty">
                No Storage Leaf or Deck matches “{query.trim()}”.
              </p>
            )
          ) : (
            <ul aria-label="Locations">
              {index.children(null).map((node) => branch(node, 0))}
            </ul>
          )}
        </div>
        <div className="ws-move-summary" aria-live="polite">
          {destination && preview ? (
            <>
              <p className="ws-move-path">{index.path(destination)}</p>
              <p>
                {preview.moving > 0
                  ? `${plural(preview.moving, "copy", "copies")} will move.`
                  : "Every selected copy is already here."}
                {preview.moving > 0 && preview.alreadyThere > 0
                  ? ` ${plural(preview.alreadyThere, "copy", "copies")} already here will stay.`
                  : ""}
              </p>
            </>
          ) : (
            <p>Choose a Storage Leaf or Deck.</p>
          )}
        </div>
        <Feedback progress={progress} error={error} />
        <div className="ws-action-buttons">
          <button
            type="button"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ws-action-primary"
            disabled={!canConfirm}
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy && destination && canConfirm) onConfirm(destination);
            }}
          >
            {canConfirm && preview
              ? `Move ${plural(preview.moving, "copy", "copies")}`
              : "Move"}
          </button>
        </div>
      </div>
    </ActionDialog>
  );
}

type RemovalProps = {
  rows: RemovalRow[];
  copies: number;
  busy: boolean;
  progress: string;
  error: string;
  onConfirm: () => void;
  onCancel: (forced?: boolean) => void;
};

/** Actions → Inventory Removal: confirms each Card Edition, quantity and source Location. */
export function RemovalDialog({
  rows,
  copies,
  busy,
  progress,
  error,
  onConfirm,
  onCancel,
}: RemovalProps) {
  const titleId = useId();
  const groups = useMemo(() => groupRemovalRows(rows), [rows]);
  return (
    <ActionDialog
      titleId={titleId}
      className="ws-removal-dialog"
      busy={busy}
      onCancel={onCancel}
    >
      <div className="ws-action-body">
        <h2 id={titleId}>
          Remove {plural(copies, "copy", "copies")} from your Collection
        </h2>
        <p className="ws-removal-note">
          These copies leave your tracked Collection. You can undo this for ten
          minutes.
        </p>
        <div
          className="ws-removal-list"
          role="group"
          aria-label="Copies to remove"
          tabIndex={0}
        >
          {groups.map((group) => (
            <div key={group.locationId} className="ws-removal-group">
              <h3>{group.path}</h3>
              <ul>
                {group.rows.map((row) => (
                  <li key={row.key}>
                    <span className="ws-removal-quantity">
                      {row.quantity.toLocaleString("en-US")} ×
                    </span>{" "}
                    {row.card}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <Feedback progress={progress} error={error} />
        <div className="ws-action-buttons">
          <button
            type="button"
            data-autofocus
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onCancel();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ws-action-danger"
            aria-disabled={busy || undefined}
            onClick={() => {
              if (!busy) onConfirm();
            }}
          >
            Remove {plural(copies, "copy", "copies")}
          </button>
        </div>
      </div>
    </ActionDialog>
  );
}
