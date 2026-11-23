import {
  locationParents,
  reviewedLocationParent,
  validLocationDestination,
  LOCATION_RELOAD_FAILED_MESSAGE,
  LOCATION_REVIEW_MESSAGE,
} from "./locationDestinations";
import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
import { SettingRow } from "../../ui/SettingRow";
import { TextField } from "../../ui/TextField";
import { indexLocations } from "../../workspace/locationTree";
import {
  CollectionError,
  type CollectionReader,
  type CollectionWriter,
  type LocationNode,
  type WriteResult,
} from "./collection";

export function locationError(
  error: unknown,
  name: string,
  create = false,
  moving = false,
  where = "That parent"
): string {
  const code = error instanceof CollectionError ? error.code : "";
  const messages: Record<string, string> = {
    INVALID_LOCATION_NAME: create
      ? "Enter a name of 1 to 120 characters."
      : "Enter a name of 1 to 120 characters, without control characters.",
    LOCATION_NAME_CONFLICT: create
      ? "A Location with that name already exists under this parent."
      : moving
        ? `${where} already has a Location named ${name}.`
        : "A sibling already has that name.",
    LOCATION_DEPTH_LIMIT: "Locations can be nested at most 12 levels deep.",
    STOCKED_LOCATION_REQUIRES_CONVERSION:
      "Choose where to keep the existing cards.",
    INVALID_LOCATION_CONVERSION:
      "This Location just changed. Review the updated Locations and try again.",
    LOCATION_NOT_EMPTY:
      "Only an empty Location with no children can be deleted.",
    LOCATION_NAME_CONFIRMATION_MISMATCH: `Type ${name} exactly to confirm.`,
    STALE_LOCATION:
      "This Location just changed. Review the updated Locations and try again.",
    LOCATION_NOT_FOUND: create
      ? "That parent Location no longer exists. Choose another parent."
      : "That Location no longer exists. Choose another Location.",
    LOCATION_CYCLE: "Choose a Location outside this Location and its children.",
    DECK_CANNOT_HAVE_CHILDREN: "A Deck cannot contain Locations.",
    IDEMPOTENCY_KEY_REUSED:
      "This request couldn't be confirmed. Close and try again.",
  };
  return messages[code] ?? "Unable to save this change. Please retry.";
}
export const staleLocationCodes = new Set([
  "STALE_LOCATION",
  "STOCKED_LOCATION_REQUIRES_CONVERSION",
  "INVALID_LOCATION_CONVERSION",
  "LOCATION_CYCLE",
  "LOCATION_NOT_FOUND",
]);
export type LocationAction = {
  mode: "create" | "settings" | "manage" | "restricted";
  id?: string;
  parentId?: string | null;
  viewKey: string;
};
export function LocationWriteDialog({
  action,
  nodes: initialNodes,
  reader,
  writer,
  returnFocus,
  onClose,
  onConfirmed,
}: {
  action: LocationAction;
  nodes: LocationNode[];
  reader: CollectionReader;
  writer: CollectionWriter;
  returnFocus: RefObject<HTMLElement | null>;
  onClose: () => void;
  onConfirmed: (result: WriteResult, message: string) => void;
}) {
  const [nodes, setNodes] = useState(initialNodes);
  const [id, setId] = useState(action.id);
  const [step, setStep] = useState<"list" | "rename" | "move" | "delete">(
    "list"
  );
  const node = nodes.find((n) => n.id === id);
  const [name, setName] = useState(node?.name ?? "");
  const [parentId, setParent] = useState(action.parentId ?? "");
  const [conversion, setConversion] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [error, setError] = useState<unknown>();
  // Set by a tree-change refusal: until a fresh tree is read, the refused command must not be sent again.
  const [reload, setReload] = useState<"" | "needed" | "failed">("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const attempt = useRef<{
    key: string;
    send: (signal: AbortSignal, key: string) => Promise<WriteResult>;
  } | null>(null);
  const lifetime = useRef<{
    alive: boolean;
    controller: AbortController;
  } | null>(null);
  useEffect(() => {
    const run = { alive: true, controller: new AbortController() };
    lifetime.current = run;
    return () => {
      run.alive = false;
      run.controller.abort();
    };
  }, [reader, writer]);
  const index = indexLocations(nodes);
  const create = action.mode === "create";
  const unsorted = node?.name === "Unsorted" && node.parent_id === null;
  const parent = nodes.find((n) => n.id === parentId);
  const stocked =
    parent?.kind === "storage_leaf" && (parent.copyCount ?? 0) > 0;
  const empty =
    node &&
    !(node.copyCount ?? 0) &&
    !nodes.some((n) => n.parent_id === node.id);
  const parents = locationParents(nodes, id, create);
  const stale = reload !== "";
  function validInput(currentNodes: LocationNode[]) {
    const current = currentNodes.find((n) => n.id === id);
    if (!create && !current) return false;
    if (create || step === "move")
      return validLocationDestination(
        currentNodes,
        id,
        create,
        parentId,
        conversion
      );
    if (step === "rename") return name.trim() !== current?.name;
    return (
      step === "delete" &&
      confirmName.trim() === current?.name &&
      !(current?.copyCount ?? 0) &&
      !currentNodes.some((n) => n.parent_id === id)
    );
  }
  function reviewTree(updated: LocationNode[]) {
    setNodes(updated);
    attempt.current = null;
    if (create || step === "move") {
      const next = reviewedLocationParent(updated, id, create, parentId);
      setParent(next);
      return next === parentId && validInput(updated);
    }
    return validInput(updated);
  }

  function begin(next: typeof step) {
    attempt.current = null;
    setError(undefined);
    setReload("");
    setStep(next);
    setName(node?.name ?? "");
    setParent(next === "move" ? "__choose__" : "");
    setConfirmName("");
  }
  async function submit(forceReload = false) {
    const mustReload = forceReload || reload !== "";
    const run = lifetime.current;
    if (!run?.alive || lock.current || !validInput(nodes)) return;
    lock.current = true;
    setBusy(true);
    try {
      let currentNodes = nodes;
      if (mustReload) {
        try {
          currentNodes = await reader.locations(run.controller.signal);
        } catch {
          if (run.alive) setReload("failed");
          return;
        }
        if (!run.alive) return;
        setReload("needed");
        if (!reviewTree(currentNodes)) return;
      }
      const current = currentNodes.find((n) => n.id === id);
      const destination = currentNodes.find((n) => n.id === parentId);
      if (!attempt.current) {
        const key = crypto.randomUUID();
        if (create) {
          const input = {
            name,
            parentId: parentId || null,
            ...(parentId ? { parentVersion: destination?.version } : {}),
            ...(currentNodes.some(
              (n) =>
                n.id === parentId &&
                n.kind === "storage_leaf" &&
                (n.copyCount ?? 0) > 0
            ) && conversion
              ? { conversion: "move_holdings_to_child" as const }
              : {}),
          };
          attempt.current = {
            key,
            send: (signal, idempotencyKey) =>
              writer.createLocation(input, { signal, idempotencyKey }),
          };
        } else {
          if (!current) throw new CollectionError("LOCATION_NOT_FOUND");
          if (step === "delete") {
            const input = {
              id: current.id,
              version: current.version,
              confirmName,
            };
            attempt.current = {
              key,
              send: (signal, idempotencyKey) =>
                writer.deleteLocation(input, { signal, idempotencyKey }),
            };
          } else {
            const input = {
              id: current.id,
              version: current.version,
              ...(step === "rename"
                ? { name }
                : {
                    parentId: parentId || null,
                    ...(parentId
                      ? { parentVersion: destination?.version }
                      : {}),
                  }),
            };
            attempt.current = {
              key,
              send: (signal, idempotencyKey) =>
                writer.editLocation(input, { signal, idempotencyKey }),
            };
          }
        }
      }
      const result = await attempt.current.send(
        run.controller.signal,
        attempt.current.key
      );
      if (!run.alive) return;
      onConfirmed(
        result,
        create
          ? `Created ${name.trim()}.`
          : step === "rename"
            ? `Renamed ${node?.name} to ${name.trim()}.`
            : step === "move"
              ? `Moved ${node?.name}.`
              : `Deleted ${node?.name}.`
      );
      onClose();
    } catch (cause) {
      if (run.alive) {
        if (
          cause instanceof CollectionError &&
          staleLocationCodes.has(cause.code)
        ) {
          setReload("needed");
          try {
            const updated = await reader.locations(run.controller.signal);
            if (!run.alive) return;
            reviewTree(updated);
          } catch {
            if (!run.alive) return;
            setReload("failed");
          }
        } else setReload("");
        if (
          cause instanceof CollectionError &&
          !staleLocationCodes.has(cause.code) &&
          cause.code !== "IDEMPOTENCY_KEY_REUSED"
        )
          attempt.current = null;
        setError(cause);
      }
    } finally {
      if (run.alive) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const frozen = busy || !!attempt.current;
  return (
    <Dialog
      open
      title={
        unsorted
          ? "Unsorted"
          : create
            ? "Create location"
            : (node?.name ?? "Manage locations")
      }
      onClose={onClose}
      returnFocus={returnFocus}
    >
      {unsorted ? (
        <p>Unsorted's Locations can't be changed here.</p>
      ) : !create && !node ? (
        <div className="flex flex-col gap-2">
          {error !== undefined && (
            <p role="alert">That Location no longer exists.</p>
          )}
          {nodes
            .filter((n) => !(n.name === "Unsorted" && n.parent_id === null))
            .map((n) => (
              <Button
                key={n.id}
                onClick={() => {
                  setId(n.id);
                  setName(n.name);
                  setStep("list");
                  setError(undefined);
                  setReload("");
                  attempt.current = null;
                }}
              >
                {index.path(n.id)}
              </Button>
            ))}
        </div>
      ) : !create && step === "list" ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-meta text-text-muted tabular-nums">
            {node?.copyCount ?? 0}{" "}
            {(node?.copyCount ?? 0) === 1 ? "copy" : "copies"}
          </p>
          <div>
            <SettingRow name="Rename" note="Change this Location's name.">
              <Button onClick={() => begin("rename")}>Rename</Button>
            </SettingRow>
            <SettingRow
              name="Move"
              note="Put it inside another Location, or at Top level."
            >
              <Button onClick={() => begin("move")}>Move</Button>
            </SettingRow>
            <SettingRow
              name="Delete"
              note={
                empty
                  ? "Remove this empty Location."
                  : "Only an empty Location with no children can be deleted."
              }
            >
              <Button disabled={!empty} onClick={() => begin("delete")}>
                Delete
              </Button>
            </SettingRow>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {(create || step === "rename") && (
            <TextField
              label={create ? "Name" : "New name"}
              data-autofocus
              value={name}
              disabled={frozen}
              onChange={(e) => {
                setName(e.target.value);
                setError(undefined);
                setReload((r) => (r === "needed" ? "" : r));
              }}
            />
          )}
          {(create || step === "move") && (
            <Select
              label="Parent"
              value={parentId}
              disabled={frozen}
              onChange={(e) => {
                setParent(e.target.value);
                setConversion(false);
                setError(undefined);
                setReload((r) => (r === "needed" ? "" : r));
              }}
            >
              <option value="__choose__" disabled>
                Choose a parent
              </option>
              {(create || node?.parent_id !== null) && (
                <option value="">Top level</option>
              )}
              {parents.map((n) => (
                <option key={n.id} value={n.id}>
                  {index.path(n.id)}
                </option>
              ))}
            </Select>
          )}
          {create && stocked && (
            <fieldset className="flex flex-col gap-2 rounded-control border border-border p-3">
              <legend>Choose where to keep the existing cards.</legend>
              <label className="flex min-h-tap items-center gap-2">
                <input
                  type="radio"
                  checked={conversion}
                  disabled={frozen}
                  onChange={() => setConversion(true)}
                />
                Move existing cards into the new child
              </label>
            </fieldset>
          )}
          {!create && step === "move" && stocked && (
            <p>
              Move the existing cards out of that Location before moving a
              Location into it.
            </p>
          )}
          {step === "delete" && (
            <>
              <p>
                {empty
                  ? `Type ${node?.name} exactly to confirm.`
                  : "Only an empty Location with no children can be deleted."}
              </p>
              <TextField
                label="Location name"
                value={confirmName}
                disabled={frozen || !empty}
                onChange={(e) => setConfirmName(e.target.value)}
              />
            </>
          )}
          {error !== undefined && (
            <p role="alert" className="m-0">
              {stale
                ? reload === "failed"
                  ? LOCATION_RELOAD_FAILED_MESSAGE
                  : LOCATION_REVIEW_MESSAGE
                : locationError(
                    error,
                    node?.name ?? name,
                    create,
                    step === "move",
                    parent ? index.path(parent.id) : "Top level"
                  )}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {stale ? (
              <Button
                disabled={busy || !validInput(nodes)}
                onClick={() => void submit(true)}
              >
                Reload and retry
              </Button>
            ) : (
              <Button
                type="submit"
                variant={step === "delete" ? "danger" : "primary"}
                disabled={busy || !validInput(nodes)}
              >
                {busy
                  ? "Saving…"
                  : create
                    ? "Create location"
                    : step === "rename"
                      ? "Save name"
                      : step === "move"
                        ? "Move location"
                        : "Delete location"}
              </Button>
            )}
          </div>
        </form>
      )}
    </Dialog>
  );
}
