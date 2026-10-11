import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DeckError, editDeck } from "../decks_generated";
import {
  deleteLocation,
  editLocation,
  getLocationTree,
  LocationError,
  type EditLocation,
  type TreeLocation,
} from "../location_generated";
import { CreateLocationDialog } from "./CreateLocationDialog";
import {
  buildManageModel,
  cleanLocationName,
  copiesLabel,
  isDeck,
  isStockedLeaf,
  locationErrorMessage,
  plural,
  STALE_CODES,
  STALE_MESSAGE,
  type ParentTarget,
} from "./manageLocationsModel";
import "./ManageLocations.css";

/** Pointer travel, in px, that turns a press on the handle into a drag. Less is a tap. */
const DRAG_THRESHOLD = 6;
/** Distance from the list's top or bottom edge, in px, where a drag scrolls the list. */
const SCROLL_EDGE = 48;
const SCROLL_STEP_MAX = 16;

type Step =
  | { kind: "list" }
  | { kind: "rename"; id: string }
  | { kind: "move"; id: string; target?: ParentTarget }
  | { kind: "delete"; id: string };

type Notice = { tone: "status" | "alert"; text: string };

type DragState = { id: string; x: number; y: number; hover: string | null };

/** "top" stands for Top level wherever a target needs a string key. */
const targetKey = (target: ParentTarget) => target ?? "top";

/** Rename or move: Decks use the Deck command, every other Location the Location edit. */
const editNode = (node: TreeLocation, body: EditLocation) =>
  isDeck(node) ? editDeck(node.id, body) : editLocation(node.id, body);

type Props = {
  onClose: () => void;
  /** Called after every change the server accepted or refused as stale, so the sidebar reloads. */
  onChanged: () => void;
};

/** The settings gear. It sits after the + in the sidebar's and the drawer's .ws-location-tools
 * (ticket 108), which size it: 28 px on desktop, 44 px in the drawer. */
export function ManageLocationsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Manage locations"
      title="Manage locations"
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <span aria-hidden="true">{"⚙︎"}</span>
    </button>
  );
}

/** Manage locations: a modal panel (a full-screen sheet on mobile) listing the whole tree, with
 * handle drag and a Move picker for reparenting, and Rename, Add child and Delete per row.
 * Every change uses the existing Location commands. There is no Location Undo. */
export function ManageLocations({ onClose, onChanged }: Props) {
  const [nodes, setNodes] = useState<TreeLocation[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** The Add location dialog's preselected parent: undefined while closed, null for Top level. */
  const [addingTo, setAddingTo] = useState<string | null | undefined>(
    undefined
  );
  const dialogRef = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** data-manage-focus key of the control to focus when the list shows again. */
  const restoreFocus = useRef<string | null>(null);
  const pointer = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    moved: boolean;
    targets: Set<string>;
  } | null>(null);
  const suppressClick = useRef(false);
  const frame = useRef<number | null>(null);

  const model = useMemo(() => buildManageModel(nodes), [nodes]);

  const reload = useCallback(async () => {
    try {
      const result = await getLocationTree();
      setNodes(result.locations);
      setLoad("ready");
    } catch {
      setLoad("error");
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Native modal dialog: the rest of the page is inert while it is open, and Escape closes it.
  // The close event is the single source of truth for closing (see onClose on the element).
  // A passive effect on purpose, as in CreateLocationDialog: when the panel opens from the mobile
  // drawer, the drawer's cleanup focuses its opener (☰) first, so focus returns there on close.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) dialog.showModal();
    // The page behind the open panel doesn't scroll.
    const root = document.documentElement;
    const overflow = root.style.overflow;
    root.style.overflow = "hidden";
    return () => {
      root.style.overflow = overflow;
      if (dialog.open) dialog.close();
      if (opener?.isConnected && opener.getClientRects().length) opener.focus();
    };
  }, []);

  // When the list shows again, focus the control that started the step (or Close).
  useEffect(() => {
    if (step.kind !== "list" || load !== "ready") return;
    const key = restoreFocus.current;
    if (!key) return;
    restoreFocus.current = null;
    const dialog = dialogRef.current;
    const target =
      dialog?.querySelector<HTMLElement>(
        `[data-manage-focus="${CSS.escape(key)}"]:not(:disabled)`
      ) ?? dialog?.querySelector<HTMLElement>("[data-manage-focus=close]");
    target?.focus();
  }, [step, load, nodes]);

  function begin(next: Step, focusKey: string | null) {
    restoreFocus.current = focusKey;
    setNotice(null);
    setError("");
    setText(next.kind === "rename" ? (model.get(next.id)?.name ?? "") : "");
    setStep(next);
  }
  function backToList() {
    setError("");
    setStep({ kind: "list" });
  }
  // Reload first, then show the list, so the list never flashes the old tree and focus returns
  // to the control that started the step in its new place.
  async function finish(message: string) {
    await reload();
    setError("");
    setNotice({ tone: "status", text: message });
    setBusy(false);
    setStep({ kind: "list" });
    onChanged();
  }
  async function stale() {
    await reload();
    setError("");
    setNotice({ tone: "alert", text: STALE_MESSAGE });
    setBusy(false);
    setStep({ kind: "list" });
    onChanged();
  }
  async function run(
    action: "rename" | "move" | "delete",
    request: () => Promise<unknown>,
    message: string,
    context: { name?: string; where?: string } = {}
  ) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request();
      await finish(message);
    } catch (cause) {
      const code =
        cause instanceof LocationError || cause instanceof DeckError
          ? cause.code
          : "";
      if (STALE_CODES.has(code)) await stale();
      else setError(locationErrorMessage(code, { action, ...context }));
    } finally {
      setBusy(false);
    }
  }

  // ---- Handle drag (pointer events, so mouse and touch share one path) ----

  const targetAt = (x: number, y: number): ParentTarget | undefined => {
    const element = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-manage-target]");
    if (!element || !dialogRef.current?.contains(element)) return undefined;
    const value = element.dataset.manageTarget!;
    return value === "top" ? null : value;
  };
  const refreshHover = () => {
    const current = pointer.current;
    if (!current?.moved) return;
    const target = targetAt(current.x, current.y);
    const key = target === undefined ? null : targetKey(target);
    setDrag({
      id: current.id,
      x: current.x,
      y: current.y,
      hover: key && current.targets.has(key) ? key : null,
    });
  };
  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };
  // While dragging, scroll the list when the pointer rests near its top or bottom edge.
  const scrollTick = () => {
    const current = pointer.current;
    const list = listRef.current;
    if (!current?.moved || !list) {
      frame.current = null;
      return;
    }
    const box = list.getBoundingClientRect();
    let delta = 0;
    if (current.y < box.top + SCROLL_EDGE)
      delta = -Math.min(
        SCROLL_STEP_MAX,
        Math.ceil((box.top + SCROLL_EDGE - current.y) / 3)
      );
    else if (current.y > box.bottom - SCROLL_EDGE)
      delta = Math.min(
        SCROLL_STEP_MAX,
        Math.ceil((current.y - (box.bottom - SCROLL_EDGE)) / 3)
      );
    if (delta) {
      const before = list.scrollTop;
      list.scrollTop += delta;
      if (list.scrollTop !== before) refreshHover();
    }
    frame.current = requestAnimationFrame(scrollTick);
  };
  const endDrag = () => {
    pointer.current = null;
    stopFrame();
    setDrag(null);
  };
  useEffect(() => stopFrame, []);

  const handleProps = (node: TreeLocation) => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || busy) return;
      pointer.current = {
        id: node.id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        targets: new Set(model.validParents(node.id).map(targetKey)),
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLButtonElement>) => {
      const current = pointer.current;
      if (!current || event.pointerId !== current.pointerId) return;
      current.x = event.clientX;
      current.y = event.clientY;
      if (!current.moved) {
        if (
          Math.hypot(
            event.clientX - current.startX,
            event.clientY - current.startY
          ) < DRAG_THRESHOLD
        )
          return;
        current.moved = true;
        frame.current = requestAnimationFrame(scrollTick);
      }
      refreshHover();
    },
    onPointerUp: (event: React.PointerEvent<HTMLButtonElement>) => {
      const current = pointer.current;
      if (!current || event.pointerId !== current.pointerId) return;
      const target = current.moved
        ? targetAt(event.clientX, event.clientY)
        : undefined;
      const { moved, targets, id } = current;
      endDrag();
      // A press without a drag is a tap: the click that follows opens the picker.
      if (!moved) return;
      // A mouse drag still fires click on the handle; ignore that one click.
      suppressClick.current = true;
      window.setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (target !== undefined && targets.has(targetKey(target)))
        begin({ kind: "move", id, target }, `move:${id}`);
    },
    onPointerCancel: endDrag,
    onLostPointerCapture: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (pointer.current?.pointerId === event.pointerId) endDrag();
    },
    // Taps (mouse or touch) and Enter or Space all arrive here and open the Move picker.
    onClick: () => {
      if (suppressClick.current) {
        suppressClick.current = false;
        return;
      }
      begin({ kind: "move", id: node.id }, `move:${node.id}`);
    },
  });

  const dragTargets = useMemo(
    () => (drag ? new Set(model.validParents(drag.id).map(targetKey)) : null),
    // The valid set depends only on which Location is lifted and on the tree.
    [drag?.id, model]
  );
  const dropState = (target: ParentTarget) => {
    if (!drag || !dragTargets) return undefined;
    const key = targetKey(target);
    if (target === drag.id) return "lifted";
    if (drag.hover === key) return "hover";
    return dragTargets.has(key) ? "valid" : "invalid";
  };

  // ---- Rows ----

  const rows = (parentId: string | null, level: number): React.ReactNode =>
    model.index.children(parentId).map((child) => {
      const node = model.get(child.id)!;
      const path = model.index.path(node.id);
      const deletable = model.deletable(node);
      const children = model.index.children(node.id);
      return (
        <li key={node.id}>
          <div
            className="ws-manage-row"
            role="group"
            aria-label={path}
            data-manage-target={node.id}
            data-drop={dropState(node.id)}
            style={{ "--ws-manage-level": level } as React.CSSProperties}
          >
            <button
              type="button"
              className="ws-manage-handle"
              aria-label={`Move ${path}`}
              title="Drag onto another location to nest it, or tap to choose"
              disabled={busy}
              data-manage-focus={`move:${node.id}`}
              {...handleProps(node)}
            >
              <span aria-hidden="true">☰</span>
            </button>
            <span className="ws-manage-name">
              <span className="ws-manage-label" title={path}>
                {node.name}
              </span>
              <small>{model.kindLabel(node)}</small>
            </span>
            <span className="ws-manage-actions">
              <button
                type="button"
                aria-label={`Rename ${path}`}
                disabled={busy}
                data-manage-focus={`rename:${node.id}`}
                onClick={() =>
                  begin({ kind: "rename", id: node.id }, `rename:${node.id}`)
                }
              >
                Rename
              </button>
              {isDeck(node) ? (
                // Decks can't have children; the spacer keeps the action columns aligned.
                <span className="ws-manage-spacer" aria-hidden="true">
                  Add child
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Add child location to ${path}`}
                  title={
                    model.canAddChild(node)
                      ? undefined
                      : "Locations can be nested at most 12 levels deep"
                  }
                  disabled={!model.canAddChild(node) || busy}
                  onClick={() => {
                    setNotice(null);
                    setAddingTo(node.id);
                  }}
                >
                  Add child
                </button>
              )}
              <button
                type="button"
                aria-label={`Delete ${path}`}
                title={
                  deletable
                    ? undefined
                    : isDeck(node)
                      ? "Decks can't be deleted here"
                      : "Only an empty location with no children can be deleted"
                }
                disabled={!deletable || busy}
                data-manage-focus={`delete:${node.id}`}
                onClick={() =>
                  begin({ kind: "delete", id: node.id }, `delete:${node.id}`)
                }
              >
                Delete
              </button>
            </span>
          </div>
          {children.length > 0 && (
            <ul aria-label={node.name}>{rows(node.id, level + 1)}</ul>
          )}
        </li>
      );
    });

  // ---- Steps ----

  const current = step.kind === "list" ? undefined : model.get(step.id);
  // A step whose Location vanished (reloaded tree) falls back to the list.
  const activeStep: Step =
    step.kind !== "list" && !current ? { kind: "list" } : step;

  function renameStep(node: TreeLocation) {
    const path = model.index.path(node.id);
    const submit = (event: React.FormEvent) => {
      event.preventDefault();
      const cleaned = cleanLocationName(text);
      if (!cleaned) {
        setError(
          locationErrorMessage("INVALID_LOCATION_NAME", { action: "rename" })
        );
        return;
      }
      if (cleaned === node.name) {
        backToList();
        return;
      }
      if (model.siblingNameTaken(cleaned, node.parent_id, node.id)) {
        setError(
          locationErrorMessage("LOCATION_NAME_CONFLICT", { action: "rename" })
        );
        return;
      }
      void run(
        "rename",
        () =>
          editNode(node, {
            name: cleaned,
            version: node.version,
            idempotency_key: crypto.randomUUID(),
          }),
        `Renamed ${node.name} to ${cleaned}.`
      );
    };
    return (
      <form
        className="ws-manage-step"
        aria-label={`Rename ${path}`}
        onSubmit={submit}
      >
        <p>
          Rename <strong>{path}</strong>
        </p>
        <label className="ws-manage-field">
          New name
          <input
            autoFocus
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="ws-manage-step-actions">
          <button type="submit" className="ws-manage-primary" disabled={busy}>
            Save name
          </button>
          <button type="button" onClick={backToList}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  function moveStep(node: TreeLocation, target: ParentTarget | undefined) {
    const path = model.index.path(node.id);
    const nested = model.subtree(node.id).length - 1;
    const parent = target ? model.get(target) : undefined;
    const where = target ? model.index.path(target) : "Top level";
    const confirm = () => {
      if (target === undefined) return;
      const stocked = parent ? isStockedLeaf(parent) : false;
      void run(
        "move",
        () =>
          editNode(node, {
            parent_id: target,
            parent_version: parent?.version ?? null,
            version: node.version,
            ...(stocked ? { conversion: "create_unsorted_child" } : {}),
            idempotency_key: crypto.randomUUID(),
          }),
        `Moved ${node.name} to ${where}.`,
        { name: node.name, where }
      );
    };
    const parents = model.validParents(node.id);
    return (
      <section className="ws-manage-step" aria-label={`Move ${path}`}>
        <p>
          Move <strong>{path}</strong>
          {nested > 0 &&
            ` and its ${plural(nested, "nested location", "nested locations")}`}
        </p>
        {target === undefined ? (
          <>
            {parents.length ? (
              <ul className="ws-manage-targets" aria-label="New parent">
                {parents.map((option, position) => (
                  <li key={targetKey(option)}>
                    <button
                      type="button"
                      autoFocus={position === 0}
                      onClick={() => {
                        setError("");
                        setStep({ kind: "move", id: node.id, target: option });
                      }}
                    >
                      {option ? model.index.path(option) : "Top level"}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>There is nowhere else this location can go.</p>
            )}
            <div className="ws-manage-step-actions">
              <button type="button" onClick={backToList}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div className="ws-manage-confirm">
            <p>
              New path: <strong>{model.newPath(node.id, target)}</strong>
            </p>
            {parent && isStockedLeaf(parent) && (
              <p className="ws-manage-warning">
                {parent.name} holds {copiesLabel(parent.copy_count)}. They move
                into a new Unsorted child inside it, so every card stays in a
                storage location.
              </p>
            )}
            <div className="ws-manage-step-actions">
              <button
                type="button"
                className="ws-manage-primary"
                autoFocus
                disabled={busy}
                onClick={confirm}
              >
                Move here
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError("");
                  setStep({ kind: "move", id: node.id });
                }}
              >
                Choose another
              </button>
              <button type="button" disabled={busy} onClick={backToList}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  function deleteStep(node: TreeLocation) {
    const path = model.index.path(node.id);
    const submit = (event: React.FormEvent) => {
      event.preventDefault();
      if (text !== node.name) return;
      void run(
        "delete",
        () =>
          deleteLocation(node.id, {
            name: text,
            version: node.version,
            idempotency_key: crypto.randomUUID(),
          }),
        `Deleted ${path}.`,
        { name: node.name }
      );
    };
    return (
      <form
        className="ws-manage-step"
        aria-label={`Delete ${path}`}
        onSubmit={submit}
      >
        <p>
          Delete <strong>{path}</strong>? It is empty and has no child
          locations.
        </p>
        <label className="ws-manage-field">
          Type {node.name} to confirm
          <input
            autoFocus
            autoComplete="off"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <div className="ws-manage-step-actions">
          <button
            type="submit"
            className="ws-manage-danger"
            disabled={busy || text !== node.name}
          >
            Delete location
          </button>
          <button type="button" onClick={backToList}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  let body: React.ReactNode;
  if (load === "error" && !nodes.length) {
    body = (
      <div className="ws-manage-status" role="alert">
        <p>Locations are temporarily unavailable.</p>
        <button type="button" onClick={() => void reload()}>
          Retry
        </button>
      </div>
    );
  } else if (load === "loading" && !nodes.length) {
    body = (
      <p className="ws-manage-status" role="status">
        Loading locations…
      </p>
    );
  } else if (activeStep.kind === "rename" && current) {
    body = renameStep(current);
  } else if (activeStep.kind === "move" && current) {
    body = moveStep(current, activeStep.target);
  } else if (activeStep.kind === "delete" && current) {
    body = deleteStep(current);
  } else {
    body = (
      <>
        <p className="ws-manage-hint">
          Drag a location by its ☰ handle onto another location to nest it, or
          onto Top level. Tap the handle, or press Enter on it, to choose from a
          list instead. Every move asks you to confirm.
        </p>
        <div
          className="ws-manage-top"
          data-manage-target="top"
          data-drop={dropState(null)}
        >
          Top level
        </div>
        <ul className="ws-manage-tree" aria-label="All locations">
          {rows(null, 0)}
        </ul>
        <button
          type="button"
          className="ws-manage-add-root"
          disabled={busy}
          onClick={() => {
            setNotice(null);
            setAddingTo(null);
          }}
        >
          Add top-level location
        </button>
      </>
    );
  }

  const lifted = drag ? model.get(drag.id) : undefined;
  const addedMessage = (name: string) =>
    addingTo
      ? `Added ${name} to ${model.index.path(addingTo)}.`
      : `Added ${name} at the top level.`;
  return (
    <>
      <dialog
        ref={dialogRef}
        className="ws-manage"
        aria-labelledby="ws-manage-title"
        data-dragging={drag ? "" : undefined}
        onCancel={(event) => {
          // Escape during a drag only drops the drag.
          if (pointer.current?.moved) {
            event.preventDefault();
            endDrag();
          }
        }}
        onClose={() => {
          // A close queued before a re-open must not close the reopened dialog.
          if (!dialogRef.current?.open) onClose();
        }}
      >
        <div className="ws-manage-header">
          <h2 id="ws-manage-title">Manage locations</h2>
          <button
            type="button"
            className="ws-manage-close"
            aria-label="Close manage locations"
            data-manage-focus="close"
            onClick={() => dialogRef.current?.close()}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <div className="ws-manage-body" ref={listRef}>
          <p
            className={
              notice?.tone === "alert" ? "ws-manage-error" : "ws-manage-notice"
            }
            role={notice?.tone ?? "status"}
          >
            {notice?.text ?? ""}
          </p>
          {body}
          {error && (
            <p className="ws-manage-error" role="alert">
              {error}
            </p>
          )}
        </div>
        {drag && lifted && (
          <div
            className="ws-manage-drag-label"
            style={{ left: drag.x + 14, top: drag.y + 10 }}
            aria-hidden="true"
          >
            {lifted.name}
          </div>
        )}
      </dialog>
      {/* Add child reuses ticket 108's create dialog. It is a sibling, not a child, of the panel's
        dialog so its cancel and close events never reach the panel's handlers. */}
      {addingTo !== undefined && (
        <CreateLocationDialog
          index={model.index}
          initialParentId={addingTo}
          onCreated={async (location) => {
            const message = addedMessage(location.name);
            await reload();
            setNotice({ tone: "status", text: message });
            setAddingTo(undefined);
            onChanged();
          }}
          onCancel={() => setAddingTo(undefined)}
          onTreeChanged={async () => {
            await reload();
            onChanged();
          }}
        />
      )}
    </>
  );
}
