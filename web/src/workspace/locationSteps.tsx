import React, { useState } from "react";
import { DeckError, editDeck } from "../decks_generated";
import {
  deleteLocation,
  editLocation,
  LocationError,
  type EditLocation,
  type TreeLocation,
} from "../location_generated";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import {
  cleanLocationName,
  copiesLabel,
  isDeck,
  isStockedLeaf,
  locationErrorMessage,
  plural,
  STALE_CODES,
  STALE_MESSAGE,
  type ManageModel,
  type ParentTarget,
} from "./manageLocationsModel";

/** The Rename, Move and Delete steps of one Location, and the run that sends a change. Shared by a
 * Location's settings dialog (#292) and Manage locations' Move step. */

export type Notice = { tone: "status" | "alert"; text: string };

export type LocationAction =
  "rename" | "move" | "delete" | "hide" | "for_trade";

export type RunLocationChange = (
  action: LocationAction,
  request: () => Promise<unknown>,
  message: string,
  context?: { name?: string; where?: string }
) => Promise<void>;

/** "top" stands for Top level wherever a target needs a string key. */
export const targetKey = (target: ParentTarget) => target ?? "top";

/** Rename or move: Decks use the Deck command, every other Location the Location edit. */
export const editNode = (node: TreeLocation, body: EditLocation) =>
  isDeck(node) ? editDeck(node.id, body) : editLocation(node.id, body);

const LIST = "m-0 flex list-none flex-col gap-1 p-0";
const STEP = "m-0 flex flex-col gap-3";
const STEP_ACTIONS = "flex flex-wrap gap-2";
/** Each step button fills its own line on a phone. */
const STEP_BUTTON = "phone:flex-[1_1_100%]";
const TARGET =
  "box-border m-0 flex min-h-control w-full cursor-pointer items-center rounded-control border border-solid border-border bg-surface px-3 text-left font-sans text-control text-text hover:border-control-outline hover:bg-surface-raised phone:min-h-tap";

/** Sends one change and tells the caller how it ended. The tree is read again before `settled` runs, so
 * the caller always sees the new tree; a stale answer reads it again too and shows the stale message. */
export function useLocationRun(options: {
  /** Resolves once the tree is read again. */
  reload: () => Promise<unknown>;
  settled: (outcome: "done" | "stale", action: LocationAction) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const run: RunLocationChange = async (
    action,
    request,
    message,
    context = {}
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await request();
      await options.reload();
      setError("");
      setNotice({ tone: "status", text: message });
      setBusy(false);
      options.settled("done", action);
    } catch (cause) {
      const code =
        cause instanceof LocationError || cause instanceof DeckError
          ? cause.code
          : "";
      if (STALE_CODES.has(code)) {
        await options.reload();
        setError("");
        setNotice({ tone: "alert", text: STALE_MESSAGE });
        setBusy(false);
        options.settled("stale", action);
      } else setError(locationErrorMessage(code, { action, ...context }));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, notice, setNotice, run };
}

export type StepProps = {
  node: TreeLocation;
  model: ManageModel;
  busy: boolean;
  run: RunLocationChange;
  setError: (text: string) => void;
  onCancel: () => void;
};

export function RenameStep({
  node,
  model,
  busy,
  run,
  setError,
  onCancel,
}: StepProps) {
  const [text, setText] = useState(node.name);
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
      onCancel();
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
    <form className={STEP} aria-label={`Rename ${path}`} onSubmit={submit}>
      <p className="m-0">
        Rename <strong className="wrap-anywhere">{path}</strong>
      </p>
      <TextField
        label="New name"
        autoFocus
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className={STEP_ACTIONS}>
        <Button
          type="submit"
          variant="primary"
          className={STEP_BUTTON}
          disabled={busy}
        >
          Save name
        </Button>
        <Button className={STEP_BUTTON} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function MoveStep({
  node,
  model,
  busy,
  run,
  setError,
  onCancel,
  target,
  onTarget,
}: StepProps & {
  target: ParentTarget | undefined;
  onTarget: (target: ParentTarget | undefined) => void;
}) {
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
    <section className={STEP} aria-label={`Move ${path}`}>
      <p className="m-0">
        Move <strong className="wrap-anywhere">{path}</strong>
        {nested > 0 &&
          ` and its ${plural(nested, "nested location", "nested locations")}`}
      </p>
      {target === undefined ? (
        <>
          {parents.length ? (
            <ul className={LIST} aria-label="New parent">
              {parents.map((option, position) => (
                <li key={targetKey(option)}>
                  <button
                    type="button"
                    className={TARGET}
                    autoFocus={position === 0}
                    onClick={() => {
                      setError("");
                      onTarget(option);
                    }}
                  >
                    {option ? model.index.path(option) : "Top level"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0">There is nowhere else this location can go.</p>
          )}
          <div className={STEP_ACTIONS}>
            <Button className={STEP_BUTTON} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="m-0">
            New path:{" "}
            <strong className="wrap-anywhere">
              {model.newPath(node.id, target)}
            </strong>
          </p>
          {parent && isStockedLeaf(parent) && (
            <p className="m-0 rounded-panel border border-accent-border bg-accent-wash p-3 text-warning">
              {parent.name} holds {copiesLabel(parent.copy_count)}. They move
              into a new Unsorted child inside it, so every card stays in a
              storage location.
            </p>
          )}
          <div className={STEP_ACTIONS}>
            <Button
              variant="primary"
              className={STEP_BUTTON}
              autoFocus
              disabled={busy}
              onClick={confirm}
            >
              Move here
            </Button>
            <Button
              className={STEP_BUTTON}
              disabled={busy}
              onClick={() => {
                setError("");
                onTarget(undefined);
              }}
            >
              Choose another
            </Button>
            <Button className={STEP_BUTTON} disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

export function DeleteStep({ node, model, busy, run, onCancel }: StepProps) {
  const [text, setText] = useState("");
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
    <form className={STEP} aria-label={`Delete ${path}`} onSubmit={submit}>
      <p className="m-0">
        Delete <strong className="wrap-anywhere">{path}</strong>? It is empty
        and has no child locations.
      </p>
      <TextField
        label={`Type ${node.name} to confirm`}
        autoFocus
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className={STEP_ACTIONS}>
        <Button
          type="submit"
          variant="danger"
          className={STEP_BUTTON}
          disabled={busy || text !== node.name}
        >
          Delete location
        </Button>
        <Button className={STEP_BUTTON} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
