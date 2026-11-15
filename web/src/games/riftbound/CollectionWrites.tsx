import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Select";
import { Stepper } from "../../ui/Stepper";
import { useToast } from "../../ui/Toast";
import { indexLocations } from "../../workspace/locationTree";
import type { Edition } from "./catalog";
import {
  CollectionError,
  plural,
  type CollectionReader,
  type CollectionWriter,
  type HoldingRow,
  type UndoRecord,
  type WriteResult,
} from "./collection";
import { useRead } from "./read";

export function writeError(error: unknown): string {
  if (error instanceof CollectionError) {
    if (error.code === "UNDO_INCOMPATIBLE")
      return "Cards changed since then, so this can't be undone.";
    if (
      ["UNDO_EXPIRED", "UNDO_NOT_FOUND", "UNDO_NOT_NEWEST"].includes(error.code)
    )
      return "This Undo is no longer available.";
    if (error.code === "STALE_HOLDING")
      return "These cards changed. Reload and retry.";
    if (error.code === "INSUFFICIENT_QUANTITY")
      return "There aren't enough copies in this Location.";
    if (error.code === "SAME_LOCATION") return "Choose a different Location.";
    if (error.code === "IDEMPOTENCY_KEY_REUSED")
      return "This request couldn't be confirmed. Close and try again.";
  }
  return "Your change couldn't be saved. Try again.";
}
/** Toast callbacks outlive their dialog. Give each operation its own cleanup guard, as in read.ts. */
export function useCollectionFeedback(
  writer: CollectionWriter | undefined,
  context: string,
  refresh: (revision: number) => void
) {
  const toast = useToast();
  const lifetime = useRef<{ current: boolean; controller: AbortController }>({
    current: false,
    controller: new AbortController(),
  });
  useEffect(() => {
    const run = { current: true, controller: new AbortController() };
    lifetime.current = run;
    return () => {
      run.current = false;
      run.controller.abort();
    };
  }, [writer, context]);
  return (result: WriteResult, message: string, undo?: UndoRecord) => {
    refresh(result.ownerRevision);
    if (!undo || !writer) {
      toast.show({ message });
      return;
    }
    const undoKey = crypto.randomUUID();
    const dismissKey = crypto.randomUUID();
    let busy = false;
    const operate = async (dismiss: boolean) => {
      if (busy) return;
      busy = true;
      const run = lifetime.current;
      try {
        const options = {
          signal: run.controller.signal,
          idempotencyKey: dismiss ? dismissKey : undoKey,
        };
        const confirmed = await (dismiss
          ? writer.dismissUndo(undo.id, options)
          : writer.undo(undo.id, options));
        if (!run.current) return;
        refresh(confirmed.ownerRevision);
        if (dismiss) toast.dismiss();
        else toast.show({ message: "Undone" });
      } catch (error) {
        if (run.current) toast.show({ message: writeError(error) });
      } finally {
        busy = false;
      }
    };
    toast.show({
      message,
      action: {
        label: "Undo",
        onAction: () => void operate(false),
        keepOpen: true,
      },
      secondaryAction: {
        label: "Dismiss Undo",
        onAction: () => void operate(true),
        keepOpen: true,
      },
    });
  };
}

type Props = {
  writer: CollectionWriter;
  reader: CollectionReader;
  mode: "add" | "move" | "remove";
  edition: Edition;
  row?: HoldingRow;
  onClose: () => void;
  onConfirmed: (
    result: WriteResult,
    message: string,
    undo?: UndoRecord
  ) => void;
  returnFocus: RefObject<HTMLElement | null>;
};
/** Mounted only for the current view/owner; cleanup invalidates even a writer ignoring AbortSignal. */
export function CollectionWriteDialog({
  writer,
  reader,
  mode,
  edition,
  row,
  onClose,
  onConfirmed,
  returnFocus,
}: Props) {
  const [destination, setDestination] = useState(mode === "add" ? "1" : "");
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [version, setVersion] = useState(row?.version ?? 1);
  const submitting = useRef(false);
  const attempt = useRef<string | null>(null);
  const lifetime = useRef<{ current: boolean; controller: AbortController }>({
    current: false,
    controller: new AbortController(),
  });
  useEffect(() => {
    const run = { current: true, controller: new AbortController() };
    lifetime.current = run;
    return () => {
      run.current = false;
      run.controller.abort();
    };
  }, [writer, reader]);
  const tree = useRead(
    JSON.stringify(["riftbound", "write-locations", reader.owner]),
    useCallback((s) => reader.locations(s), [reader])
  );
  const index = indexLocations(tree.value ?? []);
  const stale =
    error instanceof CollectionError && error.code === "STALE_HOLDING";
  const title =
    mode === "add"
      ? "Add to Collection"
      : mode === "move"
        ? "Move 1 copy"
        : "Remove 1 copy from your Collection";
  const confirm =
    mode === "add"
      ? `Add ${plural(quantity, "copy", "copies")}`
      : mode === "move"
        ? "Move 1 copy"
        : "Remove 1 copy";
  async function submit(reload = false) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    const run = lifetime.current;
    try {
      let expectedVersion = version;
      if (reload && row) {
        const holdings = await reader.holdings(
          edition.id,
          run.controller.signal
        );
        if (!run.current) return;
        const current = holdings.find((r) => r.locationId === row.locationId);
        if (!current) throw new CollectionError("STALE_HOLDING");
        expectedVersion = current.version;
        setVersion(expectedVersion);
        attempt.current = null;
      }
      attempt.current ??= crypto.randomUUID();
      const options = {
        signal: run.controller.signal,
        idempotencyKey: attempt.current,
      };
      const items = [
        {
          editionId: edition.id,
          sourceId: row?.locationId ?? "",
          quantity: 1,
          expectedVersion,
        },
      ];
      const result =
        mode === "add"
          ? await writer.add(
              { editionId: edition.id, locationId: destination, quantity },
              options
            )
          : mode === "move"
            ? await writer.move({ items, destinationId: destination }, options)
            : await writer.remove({ items }, options);
      if (!run.current) return;
      onConfirmed(
        result,
        mode === "add"
          ? `Added ${plural(quantity, "copy", "copies")} to ${index.path(destination)}`
          : mode === "move"
            ? `Moved 1 copy to ${index.path(destination)}`
            : "Removed 1 copy from your Collection",
        "undo" in result ? result.undo : undefined
      );
      onClose();
    } catch (failure) {
      if (run.current) setError(failure);
    } finally {
      if (run.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <Dialog open title={title} onClose={onClose} returnFocus={returnFocus}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
      >
        <p className="m-0">{edition.name}</p>
        {mode !== "add" && row && (
          <p className="m-0 text-text-muted">
            From {index.path(row.locationId)}
          </p>
        )}
        {mode !== "remove" &&
          (tree.failed ? (
            <div role="alert">
              Locations couldn't be loaded.{" "}
              <Button onClick={tree.retry}>Retry</Button>
            </div>
          ) : !tree.value ? (
            <p role="status">Loading Locations…</p>
          ) : (
            <Select
              label="Location"
              value={destination}
              disabled={busy || !!attempt.current}
              onChange={(event) => {
                setDestination(event.target.value);
                setError(undefined);
              }}
            >
              <option value="" disabled>
                Choose a Location
              </option>
              {tree.value
                .filter(
                  (n) =>
                    n.kind === "storage_leaf" &&
                    n.id !== row?.locationId &&
                    !tree.value!.some((child) => child.parent_id === n.id)
                )
                .map((n) => (
                  <option key={n.id} value={n.id}>
                    {index.path(n.id)}
                  </option>
                ))}
            </Select>
          ))}
        {mode === "move" && destination && (
          <p className="m-0">To {index.path(destination)}</p>
        )}
        {mode === "add" && (
          <div>
            <Stepper
              label="Quantity"
              min={1}
              max={99}
              value={quantity}
              disabled={busy || !!attempt.current}
              onChange={setQuantity}
            />
          </div>
        )}
        {error !== undefined && <div role="alert">{writeError(error)}</div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          {stale ? (
            <Button disabled={busy} onClick={() => void submit(true)}>
              Reload and retry
            </Button>
          ) : (
            <Button
              type="submit"
              variant={mode === "remove" ? "danger" : "primary"}
              disabled={
                busy || (mode !== "remove" && (!destination || !tree.value))
              }
            >
              {busy ? "Saving…" : confirm}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}
