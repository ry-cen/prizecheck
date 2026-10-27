import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Menu as Handle, Settings } from "lucide-react";
import { getLocationTree, type TreeLocation } from "../location_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { focusableIn } from "../ui/focusable";
import { Icon } from "../ui/Icon";
import { CreateLocationDialog } from "./CreateLocationDialog";
import { MoveStep, targetKey, useLocationRun } from "./locationSteps";
import { forTradeLabel, hidingLabel, stillOfferedLine } from "./locationTree";
import {
  buildManageModel,
  isDeck,
  type ParentTarget,
} from "./manageLocationsModel";

/** Pointer travel, in px, that turns a press on the handle into a drag. Less is a tap. */
const DRAG_THRESHOLD = 6;
/** Distance from the list's top or bottom edge, in px, where a drag scrolls the list. */
const SCROLL_EDGE = 48;
const SCROLL_STEP_MAX = 16;

type Step =
  { kind: "list" } | { kind: "move"; id: string; target?: ParentTarget };

type DragState = { id: string; x: number; y: number; hover: string | null };

type Props = {
  onClose: () => void;
  /** Called after every change the server accepted or refused as stale, so the sidebar reloads. */
  onChanged: () => void;
};

/** The settings gear, after the + in the sidebar's and the drawer's Location tools (ticket 108): a quiet
 * icon button, 30 px on desktop and 44 px on a phone. */
export function ManageLocationsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="quiet"
      icon={Settings}
      label="Manage locations"
      title="Manage locations"
      aria-haspopup="dialog"
      onClick={onClick}
    />
  );
}

const LIST = "m-0 flex list-none flex-col gap-1 p-0";

type DropState = "lifted" | "hover" | "valid" | "invalid" | undefined;

/** A row's drag feedback, by outline and dimming as well as colour. */
const rowDrop = (state: DropState) =>
  state === "hover"
    ? "outline-2 outline-solid outline-accent -outline-offset-2 bg-accent-wash"
    : state === "valid"
      ? "outline-1 outline-dashed outline-accent-outline -outline-offset-1 hover:bg-surface-raised"
      : state === "invalid" || state === "lifted"
        ? "opacity-40"
        : "hover:bg-surface-raised";

/** The Top level zone's drag feedback. */
const topDrop = (state: DropState) =>
  state === "hover"
    ? "border-dashed border-border-strong text-text-muted outline-2 outline-solid outline-accent -outline-offset-2 bg-[linear-gradient(var(--color-accent-wash),var(--color-accent-wash))]"
    : state === "valid"
      ? "border-dashed border-border-strong text-text-muted outline-1 outline-dashed outline-accent-outline -outline-offset-1"
      : state === "invalid"
        ? "border-dotted border-border text-text-subtle"
        : "border-dashed border-border-strong text-text-muted";

/** Manage locations: a modal panel (a full-screen sheet on mobile) listing the whole tree, with
 * handle drag and a Move picker for reparenting, and Add child per row. Each Location's own settings
 * (Rename, Hide from Friends, For trade, Delete) are in its settings dialog, from the gear on its
 * sidebar row (#292). Every change uses the existing Location commands. There is no Location Undo. */
export function ManageLocations({ onClose, onChanged }: Props) {
  const [nodes, setNodes] = useState<TreeLocation[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "error">("loading");
  const [step, setStep] = useState<Step>({ kind: "list" });
  const [drag, setDrag] = useState<DragState | null>(null);
  /** The Add location dialog's preselected parent: undefined while closed, null for Top level. */
  const [addingTo, setAddingTo] = useState<string | null | undefined>(
    undefined
  );
  /** The panel's own content, inside the kit Dialog. */
  const rootRef = useRef<HTMLDivElement>(null);
  /** The Dialog's scrolling content box, which a drag scrolls near its edges. */
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

  // The list shows again once the tree is read again, so it never flashes the old tree and focus returns
  // to the control that started the step in its new place.
  const { busy, error, setError, notice, setNotice, run } = useLocationRun({
    reload,
    settled: () => {
      setStep({ kind: "list" });
      onChanged();
    },
  });

  // When the list shows again, focus the control that started the step (or Close).
  useEffect(() => {
    if (step.kind !== "list" || load !== "ready" || busy) return;
    const key = restoreFocus.current;
    if (!key) return;
    restoreFocus.current = null;
    const root = rootRef.current;
    const dialog = root?.closest("dialog");
    const target =
      root?.querySelector<HTMLElement>(
        `[data-manage-focus="${CSS.escape(key)}"]:not(:disabled)`
      ) ?? (dialog ? focusableIn(dialog)[0] : undefined); // the Dialog's close button
    target?.focus();
  }, [step, load, nodes, busy]);

  function begin(next: Step, focusKey: string | null) {
    restoreFocus.current = focusKey;
    setNotice(null);
    setError("");
    setStep(next);
  }
  function backToList() {
    setError("");
    setStep({ kind: "list" });
  }
  // ---- Handle drag (pointer events, so mouse and touch share one path) ----

  const targetAt = (x: number, y: number): ParentTarget | undefined => {
    const element = document
      .elementFromPoint(x, y)
      ?.closest<HTMLElement>("[data-manage-target]");
    if (!element || !rootRef.current?.contains(element)) return undefined;
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
  // Escape during a drag only drops the drag. Taken on window before the Dialog sees it; its preventDefault
  // keeps the Dialog open.
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pointer.current?.moved) return;
      event.preventDefault();
      endDrag();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // endDrag only touches refs and state setters.
  }, [dragging]);

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
  const dropState = (target: ParentTarget): DropState => {
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
      const children = model.index.children(node.id);
      const hiding = model.index.hiding(node.id);
      const hidden = hidingLabel(hiding);
      const forTrade = model.index.forTrade(node.id);
      const trading = forTradeLabel(forTrade);
      const stillOffered = stillOfferedLine(hiding, forTrade);
      return (
        <li key={node.id}>
          <div
            className={`box-border flex min-h-11 items-center gap-2 rounded-control py-1 pr-2 pl-[calc(var(--space-1)+var(--manage-level)*var(--space-4))] phone:pl-[calc(var(--manage-level)*var(--space-2))] ${rowDrop(dropState(node.id))}`}
            role="group"
            aria-label={path}
            data-manage-target={node.id}
            data-drop={dropState(node.id)}
            style={{ "--manage-level": level } as React.CSSProperties}
          >
            <button
              type="button"
              className="m-0 box-border inline-flex h-10 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-control border border-solid border-transparent bg-transparent p-0 font-sans text-text-muted enabled:hover:bg-surface-selected enabled:hover:text-text disabled:cursor-default disabled:opacity-40 phone:size-tap"
              aria-label={`Move ${path}`}
              title="Drag onto another location to nest it, or tap to choose"
              disabled={busy}
              data-manage-focus={`move:${node.id}`}
              {...handleProps(node)}
            >
              <Icon icon={Handle} />
            </button>
            <span className="flex min-w-0 flex-auto flex-col">
              <span className="truncate" title={path}>
                {node.name}
              </span>
              <small className="text-caption text-text-subtle tabular-nums">
                {model.kindLabel(node)}
                {hidden && ` · ${hidden}`}
                {trading && ` · ${trading}`}
              </small>
              {stillOffered && (
                <small className="text-caption text-text-muted">
                  {stillOffered}
                </small>
              )}
            </span>
            {isDeck(node) ? (
              // Decks can't have children; the spacer keeps the rows aligned.
              <span
                className="invisible box-border inline-flex h-control items-center border border-solid border-transparent px-3 font-sans text-control font-medium whitespace-nowrap phone:h-control-phone phone:px-4"
                aria-hidden="true"
              >
                Add child
              </span>
            ) : (
              <Button
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
              </Button>
            )}
          </div>
          {children.length > 0 && (
            <ul aria-label={node.name} className={`${LIST} mt-1`}>
              {rows(node.id, level + 1)}
            </ul>
          )}
        </li>
      );
    });

  // ---- Steps ----

  const current = step.kind === "list" ? undefined : model.get(step.id);
  // A step whose Location vanished (reloaded tree) falls back to the list.
  const activeStep: Step =
    step.kind !== "list" && !current ? { kind: "list" } : step;

  let body: React.ReactNode;
  if (load === "error" && !nodes.length) {
    body = (
      <div
        className="flex flex-col items-start gap-2 text-meta text-text-muted"
        role="alert"
      >
        <p className="m-0">Locations are temporarily unavailable.</p>
        <Button onClick={() => void reload()}>Retry</Button>
      </div>
    );
  } else if (load === "loading" && !nodes.length) {
    body = (
      <p className="m-0 text-meta text-text-muted" role="status">
        Loading locations…
      </p>
    );
  } else if (activeStep.kind === "move" && current) {
    body = (
      <MoveStep
        node={current}
        model={model}
        busy={busy}
        run={run}
        setError={setError}
        target={activeStep.target}
        onTarget={(target) => setStep({ kind: "move", id: current.id, target })}
        onCancel={backToList}
      />
    );
  } else {
    body = (
      <>
        <p className="m-0 text-meta text-text-muted">
          Drag a location by ☰ onto another location or Top level to move it,
          or tap ☰ to pick from a list. To rename, hide, trade or delete a
          location, use its gear in Locations.
        </p>
        <div
          className={`sticky top-0 z-1 box-border rounded-panel border bg-surface p-3 text-center text-meta ${topDrop(dropState(null))}`}
          data-manage-target="top"
          data-drop={dropState(null)}
        >
          Top level
        </div>
        <ul className={LIST} aria-label="All locations">
          {rows(null, 0)}
        </ul>
        <Button
          className="self-start"
          disabled={busy}
          onClick={() => {
            setNotice(null);
            setAddingTo(null);
          }}
        >
          Add top-level location
        </Button>
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
      {/* The kit Dialog: a centred panel on desktop, the whole screen on a phone. Escape, the close button
          and the scrim close it (Escape during a drag only drops the drag), and focus returns to the gear,
          or to ☰ when it opened from the phone drawer (the drawer gives focus back to ☰ first). */}
      <Dialog
        open
        onClose={onClose}
        title="Manage locations"
        closeLabel="Close manage locations"
        size="wide"
        bodyRef={listRef}
        // Focused rows scroll clear of the pinned Top level zone.
        bodyClassName="scroll-pt-15"
      >
        <div
          ref={rootRef}
          className={`flex flex-col gap-3 ${drag ? "cursor-grabbing select-none" : ""}`}
        >
          <p
            className={`m-0 text-meta empty:-mb-3 ${notice?.tone === "alert" ? "text-danger" : "text-text"}`}
            role={notice?.tone ?? "status"}
          >
            {notice?.text ?? ""}
          </p>
          {body}
          {error && (
            <p className="m-0 text-meta text-danger" role="alert">
              {error}
            </p>
          )}
          {drag && lifted && (
            <div
              className="pointer-events-none fixed z-1 box-border max-w-60 truncate rounded-control border border-accent-border bg-surface-raised px-3 py-1 text-meta text-text"
              style={{ left: drag.x + 14, top: drag.y + 10 }}
              aria-hidden="true"
            >
              {lifted.name}
            </div>
          )}
        </div>
      </Dialog>
      {/* Add child reuses the create dialog (ticket 108, on the kit Dialog since #165). It is rendered beside the
        panel's Dialog, not inside it: React events bubble through the component tree (portals included), so
        inside it the create dialog's Escape key presses would also reach the panel's handlers. */}
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
