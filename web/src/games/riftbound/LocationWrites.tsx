import { useEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
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
  create = false
): string {
  const code = error instanceof CollectionError ? error.code : "";
  const messages: Record<string, string> = {
    INVALID_LOCATION_NAME:
      "Enter a name of 1 to 120 characters, without control characters.",
    LOCATION_NAME_CONFLICT: create
      ? "A Location with that name already exists under this parent."
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
    LOCATION_NOT_FOUND:
      "That Location no longer exists. Choose another Location.",
    LOCATION_CYCLE: "Choose a Location outside this Location and its children.",
    DECK_CANNOT_HAVE_CHILDREN: "A Deck can't contain Locations.",
    IDEMPOTENCY_KEY_REUSED:
      "This request couldn't be confirmed. Close and try again.",
  };
  return messages[code] ?? "Unable to save this change. Please retry.";
}
export type LocationAction = {
  mode: "create" | "settings" | "manage";
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
  const branch = new Set(id ? [id] : []);
  let size = -1;
  while (size !== branch.size) {
    size = branch.size;
    for (const n of nodes)
      if (n.parent_id && branch.has(n.parent_id)) branch.add(n.id);
  }
  const height = node
    ? Math.max(
        ...nodes
          .filter((n) => branch.has(n.id))
          .map((n) => n.depth - node.depth + 1)
      )
    : 1;
  const parents = nodes.filter(
    (n) =>
      n.kind !== "deck" &&
      !(n.name === "Unsorted" && n.parent_id === null) &&
      !branch.has(n.id) &&
      n.depth + height <= 12
  );
  const stale =
    error instanceof CollectionError && error.code === "STALE_LOCATION";
  function begin(next: typeof step) {
    attempt.current = null;
    setError(undefined);
    setStep(next);
    setName(node?.name ?? "");
    setParent(node?.parent_id ?? "");
    setConfirmName("");
  }
  async function submit(reload = false) {
    const run = lifetime.current;
    if (!run?.alive || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      let currentNodes = nodes;
      if (reload) {
        currentNodes = await reader.locations(run.controller.signal);
        if (!run.alive) return;
        setNodes(currentNodes);
        attempt.current = null;
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
            ...(stocked && conversion
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
          cause.code !== "STALE_LOCATION" &&
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
      title={create ? "Create location" : "Location settings"}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      {unsorted ? (
        <p>Unsorted can't be renamed, moved or deleted here.</p>
      ) : !create && !node ? (
        <div className="flex flex-col gap-2">
          {nodes
            .filter((n) => !(n.name === "Unsorted" && n.parent_id === null))
            .map((n) => (
              <Button
                key={n.id}
                onClick={() => {
                  setId(n.id);
                  setName(n.name);
                }}
              >
                {index.path(n.id)}
              </Button>
            ))}
        </div>
      ) : !create && step === "list" ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 font-semibold">{node?.name}</p>
          <Button onClick={() => begin("rename")}>Rename</Button>
          <Button onClick={() => begin("move")}>Move</Button>
          <Button onClick={() => begin("delete")}>Delete</Button>
          {!empty && (
            <p className="m-0 text-meta text-text-muted">
              Only an empty Location with no children can be deleted.
            </p>
          )}
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
              }}
            >
              <option value="">Top level</option>
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
              {locationError(error, node?.name ?? name, create)}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {stale ? (
              <Button disabled={busy} onClick={() => void submit(true)}>
                Reload and retry
              </Button>
            ) : (
              <Button
                type="submit"
                variant={step === "delete" ? "danger" : "primary"}
                disabled={
                  busy ||
                  (create && stocked && !conversion) ||
                  (step === "delete" && !empty) ||
                  (step === "move" && stocked)
                }
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
