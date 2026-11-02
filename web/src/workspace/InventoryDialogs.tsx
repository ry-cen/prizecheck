import type { BorrowedMoveItem } from "../collection_generated";
import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, TriangleAlert } from "lucide-react";
import type { TreeNode } from "../location_generated";
import { Button } from "../ui/Button";
import { CONTROL } from "../ui/control";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { plural } from "./galleryModel";
import {
  groupRemovalRows,
  movePreview,
  type RemovalRow,
} from "./inventoryActionsModel";
import { KitLayer } from "./KitLayer";
import { ScrollArea } from "../ui/ScrollArea";
import { isFolder, type LocationIndex } from "./locationTree";
import type { SelectedGroup } from "./selectionModel";

/** Progress (polite) and the inline error of a running or failed action. The empty status line stays in
 * the accessibility tree but takes no space. */
function Feedback({ progress, error }: { progress: string; error: string }) {
  return (
    <>
      <p className="m-0 text-meta text-text-muted empty:sr-only" role="status">
        {progress}
      </p>
      {error && (
        <p
          className="m-0 flex items-start gap-1 text-meta text-danger"
          role="alert"
        >
          <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </>
  );
}

/** The explorer's and the Removal list's scrolling box: the frame (this) around a ScrollArea whose viewport has the padding. */
const LIST_BOX =
  "box-border max-h-[40dvh] min-h-30 flex-auto rounded-panel border border-border";
const LIST = "m-0 flex list-none flex-col gap-1 p-0";
/** An explorer row; the indent comes from its level (inline style). */
const ROW =
  "box-border flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-control border border-transparent bg-transparent py-1 pr-2 text-left font-sans text-meta hover:bg-surface-raised phone:min-h-tap";
const indent = (level: number): React.CSSProperties => ({
  paddingLeft: `calc(var(--space-2) + ${level} * var(--space-3))`,
});

type MoveProps = {
  /** The action's name in the heading and on the confirm button: "Move" (the default), or "Put away" for the deck
   * builder's surplus (#180). */
  verb?: string;
  index: LocationIndex;
  /** The sidebar's open folders; the explorer starts with the same ones open. */
  initialExpanded: ReadonlySet<string>;
  groups: SelectedGroup[];
  borrowed?: BorrowedMoveItem[];
  copies: number;
  busy: boolean;
  progress: string;
  error: string;
  onConfirm: (destinationId: string) => void;
  onCancel: (forced?: boolean) => void;
};

/** Every Storage Leaf and Deck in tree order (natural A–Z, depth first). */
export function leavesOf(index: LocationIndex): TreeNode[] {
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

/** Actions → Move: a searchable folder-style explorer in the kit Dialog (#165), a bottom sheet on a phone.
 * Organizational Locations expand; only Storage Leaves and Decks can be chosen. The full path and the
 * copies that actually move show before confirmation, which is disabled when every selected copy is
 * already at the destination. Escape, the close button, Cancel and the scrim close it, except while the
 * Move runs. */
export function MoveDialog({
  verb = "Move",
  index,
  initialExpanded,
  groups,
  borrowed = [],
  copies,
  busy,
  progress,
  error,
  onConfirm,
  onCancel,
}: MoveProps) {
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
  const preview = destination
    ? movePreview(groups, destination, borrowed)
    : null;
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
      className={`${ROW} text-text aria-pressed:border-accent-border aria-pressed:bg-surface-selected aria-pressed:font-semibold aria-pressed:text-accent-strong`}
      style={indent(level)}
      aria-pressed={destination === node.id}
      title={index.path(node.id)}
      onClick={() => setDestination(node.id)}
    >
      <span className="min-w-0 wrap-anywhere">{label}</span>
      {node.kind === "deck" && (
        <span className="rounded-control border border-border px-1 text-caption font-normal text-text-muted">
          Deck
        </span>
      )}
      {destination === node.id && (
        <Icon icon={Check} size={14} className="ml-auto shrink-0" />
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
          className={`${ROW} text-text-muted`}
          style={indent(level)}
          aria-expanded={open}
          title={index.path(node.id)}
          onClick={() => toggle(node.id)}
        >
          <Icon
            icon={open ? ChevronDown : ChevronRight}
            size={14}
            className="shrink-0 text-text-subtle"
          />
          <span className="min-w-0 wrap-anywhere">{node.name}</span>
        </button>
        {open && (
          <ul aria-label={node.name} className={`${LIST} mt-1`}>
            {index.children(node.id).map((child) => branch(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <KitLayer>
      <Dialog
        open
        onClose={() => {
          if (!busy) onCancel();
        }}
        title={`${verb} ${plural(copies, "copy", "copies")}`}
      >
        <div className="flex flex-col gap-3">
          <input
            type="search"
            className={CONTROL}
            aria-label="Search locations"
            placeholder="Find a location…"
            autoComplete="off"
            data-autofocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ScrollArea className={LIST_BOX} viewportClassName="p-1" bothAxes>
            {needle ? (
              matches.length ? (
                <ul aria-label="Matching locations" className={LIST}>
                  {matches.map((node) => (
                    <li key={node.id}>
                      {leafButton(node, index.path(node.id), 0)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="m-0 p-2 text-meta text-text-muted">
                  No Storage Leaf or Deck matches “{query.trim()}”.
                </p>
              )
            ) : (
              <ul aria-label="Locations" className={LIST}>
                {index.children(null).map((node) => branch(node, 0))}
              </ul>
            )}
          </ScrollArea>
          <div
            className="flex flex-col gap-1 text-meta tabular-nums"
            aria-live="polite"
          >
            {destination && preview ? (
              <>
                <p className="m-0 font-semibold wrap-anywhere">
                  {index.path(destination)}
                </p>
                <p className="m-0">
                  {preview.moving > 0
                    ? `${plural(preview.moving, "copy", "copies")} will move.`
                    : "Every selected copy is already here."}
                  {preview.moving > 0 && preview.alreadyThere > 0
                    ? ` ${plural(preview.alreadyThere, "copy", "copies")} already here will stay.`
                    : ""}
                </p>
              </>
            ) : (
              <p className="m-0">Choose a Storage Leaf or Deck.</p>
            )}
          </div>
          <Feedback progress={progress} error={error} />
          <div className="flex justify-end gap-2">
            <Button
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onCancel();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!canConfirm}
              aria-disabled={(busy && canConfirm) || undefined}
              onClick={() => {
                if (!busy && destination && canConfirm) onConfirm(destination);
              }}
            >
              {canConfirm && preview
                ? `${verb} ${plural(preview.moving, "copy", "copies")}`
                : verb}
            </Button>
          </div>
        </div>
      </Dialog>
    </KitLayer>
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

/** Actions → Inventory Removal: confirms each Card Edition, quantity and source Location, in the kit
 * Dialog (#165). Cancel takes focus first. */
export function RemovalDialog({
  rows,
  copies,
  busy,
  progress,
  error,
  onConfirm,
  onCancel,
}: RemovalProps) {
  const groups = useMemo(() => groupRemovalRows(rows), [rows]);
  return (
    <KitLayer>
      <Dialog
        open
        onClose={() => {
          if (!busy) onCancel();
        }}
        title={`Remove ${plural(copies, "copy", "copies")} from your Collection`}
      >
        <div className="flex flex-col gap-3">
          <p className="m-0 text-meta text-text-muted">
            These copies leave your tracked Collection. You can undo this for
            ten minutes.
          </p>
          <ScrollArea
            className={LIST_BOX}
            viewportClassName="p-1"
            bothAxes
            viewportProps={{
              role: "group",
              "aria-label": "Copies to remove",
              tabIndex: 0,
            }}
          >
            {groups.map((group) => (
              <div key={group.locationId} className="p-2">
                <h3 className="m-0 mb-1 text-meta font-semibold wrap-anywhere">
                  {group.path}
                </h3>
                <ul className={LIST}>
                  {group.rows.map((row) => (
                    <li key={row.key} className="text-meta">
                      <span className="font-semibold tabular-nums">
                        {row.quantity.toLocaleString("en-US")} ×
                      </span>{" "}
                      {row.card}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </ScrollArea>
          <Feedback progress={progress} error={error} />
          <div className="flex justify-end gap-2">
            <Button
              data-autofocus
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onCancel();
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onConfirm();
              }}
            >
              Remove {plural(copies, "copy", "copies")}
            </Button>
          </div>
        </div>
      </Dialog>
    </KitLayer>
  );
}
