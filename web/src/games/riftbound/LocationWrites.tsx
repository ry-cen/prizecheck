import {
  changedLocationFacts,
  locationFacts,
  locationParents,
  reviewedLocationParent,
  validLocationDestination,
  LOCATION_REFRESHING_MESSAGE,
  LOCATION_RELOAD_FAILED_MESSAGE,
  LOCATION_RETRY_RELOAD_FAILED_MESSAGE,
  LOCATION_REVIEW_MESSAGE,
  type LocationFactChange,
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
      "This change couldn't be confirmed. Use Reload and retry to check the list, then try again.",
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
  // What the alert says about a tree-change refusal. Editing clears it; it does not decide whether a read is due.
  // "refreshing" is the automatic read in flight, "needed" a read that worked and is waiting to be reviewed.
  const [reload, setReload] = useState<"" | "refreshing" | "needed" | "failed">(
    ""
  );
  // True once the Locations are known to have changed elsewhere; a reused key alone does not say so.
  const [elsewhere, setElsewhere] = useState(false);
  // Set by any tree-change refusal, failed read or reused key, and only the write that succeeds ends it. Until
  // then every new command is preceded by a fresh read; edits, other choices and later errors never clear it.
  const mustRead = useRef(false);
  const [readDue, setReadDue] = useState(false);
  const requireRead = () => {
    mustRead.current = true;
    setReadDue(true);
  };
  // What changed in the Locations since the collector last saw them; shown in the alert until they edit or confirm.
  const [changes, setChanges] = useState<LocationFactChange[]>([]);
  const alertRef = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  // The one command whose outcome is unknown: its exact input and key are what a retry sends.
  const attempt = useRef<{
    key: string;
    message: string;
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
  const gone = !create && !node;
  useEffect(() => {
    // A pause names what changed, and moves focus there so a repeated Enter cannot confirm it unseen.
    if (changes.length || (gone && (reload !== "" || error !== undefined)))
      alertRef.current?.focus();
  }, [changes, gone, reload, error]);
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
  const formStep = create ? "create" : step === "list" ? undefined : step;
  // Every fact that can pause a retry is on screen, so the collector has seen what a change is measured against.
  const facts = formStep ? locationFacts(formStep, nodes, id, parentId) : [];
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
  /** Show the refreshed tree and what changed in it; true only when nothing shown changed and the input still stands. */
  function reviewTree(updated: LocationNode[]) {
    const next =
      create || step === "move"
        ? reviewedLocationParent(updated, id, create, parentId)
        : parentId;
    const diff = formStep
      ? changedLocationFacts(facts, locationFacts(formStep, updated, id, next))
      : [];
    setNodes(updated);
    setParent(next);
    setChanges(diff);
    return next === parentId && !diff.length && validInput(updated);
  }

  function begin(next: typeof step) {
    // A sent command whose outcome is unknown stays the only thing that can be retried.
    if (attempt.current || lock.current) return;
    setError(undefined);
    setReload("");
    setChanges([]);
    setStep(next);
    setName(node?.name ?? "");
    setParent(next === "move" ? "__choose__" : "");
    setConfirmName("");
  }
  async function submit() {
    const run = lifetime.current;
    if (!run?.alive || lock.current) return;
    // A command with an unknown outcome is retried as it was, before any other check or read.
    if (!attempt.current && !validInput(nodes)) return;
    lock.current = true;
    setBusy(true);
    try {
      if (!attempt.current) {
        let currentNodes = nodes;
        if (mustRead.current) {
          try {
            currentNodes = await reader.locations(run.controller.signal);
          } catch {
            if (run.alive) setReload("failed");
            return;
          }
          if (!run.alive) return;
          // The refreshed Locations are shown first; the next explicit submit is measured against what is then on screen.
          if (!reviewTree(currentNodes)) {
            setElsewhere(true);
            setReload("needed");
            return;
          }
        }
        const current = currentNodes.find((n) => n.id === id);
        const destination = currentNodes.find((n) => n.id === parentId);
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
            message: `Created ${name.trim()}.`,
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
              message: `Deleted ${current.name}.`,
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
              message:
                step === "rename"
                  ? `Renamed ${current.name} to ${name.trim()}.`
                  : `Moved ${current.name}.`,
              send: (signal, idempotencyKey) =>
                writer.editLocation(input, { signal, idempotencyKey }),
            };
          }
        }
      }
      const sent = attempt.current;
      const result = await sent.send(run.controller.signal, sent.key);
      if (!run.alive) return;
      onConfirmed(result, sent.message);
      onClose();
    } catch (cause) {
      if (run.alive) {
        const code = cause instanceof CollectionError ? cause.code : "";
        if (staleLocationCodes.has(code)) {
          // Refused for good: drop the command and owe a read before anything is sent, even if the read below fails.
          attempt.current = null;
          requireRead();
          setElsewhere(true);
          setReload("refreshing");
          try {
            const updated = await reader.locations(run.controller.signal);
            if (!run.alive) return;
            reviewTree(updated);
            setReload("needed");
          } catch {
            if (!run.alive) return;
            setReload("failed");
          }
        } else {
          setReload("");
          setChanges([]);
          // A refusal is final for this command. A reused key is spent too: it is never replayed, and the
          // next command is an explicit choice made after a fresh read.
          if (cause instanceof CollectionError) attempt.current = null;
          if (code === "IDEMPOTENCY_KEY_REUSED") {
            requireRead();
            setElsewhere(false);
          }
        }
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
          {(stale || error !== undefined) && (
            <p
              role="alert"
              tabIndex={-1}
              ref={(el) => {
                alertRef.current = el;
              }}
            >
              That Location no longer exists.
            </p>
          )}
          {nodes
            .filter((n) => !(n.name === "Unsorted" && n.parent_id === null))
            .map((n) => (
              <Button
                key={n.id}
                onClick={() => {
                  if (attempt.current || lock.current) return;
                  setId(n.id);
                  setName(n.name);
                  setStep("list");
                  setError(undefined);
                  setReload("");
                  setChanges([]);
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
          {facts.length > 0 && (
            <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-meta">
              {facts.map((f) => (
                <div key={f.key} className="contents">
                  <dt className="text-text-muted">{f.label}</dt>
                  <dd className="m-0">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {(create || step === "rename") && (
            <TextField
              label={create ? "Name" : "New name"}
              data-autofocus
              value={name}
              disabled={frozen}
              onChange={(e) => {
                setName(e.target.value);
                setError(undefined);
                setChanges([]);
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
                setChanges([]);
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
                onChange={(e) => {
                  setConfirmName(e.target.value);
                  setChanges([]);
                }}
              />
            </>
          )}
          {(stale || error !== undefined) && (
            <div
              role="alert"
              tabIndex={-1}
              ref={(el) => {
                alertRef.current = el;
              }}
              className="flex flex-col gap-1"
            >
              <p className="m-0">
                {stale
                  ? reload === "refreshing"
                    ? LOCATION_REFRESHING_MESSAGE
                    : reload === "failed"
                      ? elsewhere
                        ? LOCATION_RELOAD_FAILED_MESSAGE
                        : LOCATION_RETRY_RELOAD_FAILED_MESSAGE
                      : LOCATION_REVIEW_MESSAGE
                  : locationError(
                      error,
                      node?.name ?? name,
                      create,
                      step === "move",
                      parent ? index.path(parent.id) : "Top level"
                    )}
              </p>
              {stale && changes.length > 0 && (
                <ul className="m-0 pl-4">
                  {changes.map((c) => (
                    <li key={c.key}>
                      {c.note ?? `${c.label}: ${c.after} (was ${c.before})`}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            {readDue && !attempt.current ? (
              <Button type="submit" disabled={busy || !validInput(nodes)}>
                Reload and retry
              </Button>
            ) : (
              <Button
                type="submit"
                variant={step === "delete" ? "danger" : "primary"}
                disabled={busy || (!attempt.current && !validInput(nodes))}
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
