import React, { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import {
  createLocation,
  LocationError,
  type TreeNode,
} from "../location_generated";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { BUTTON, BUTTON_ROW, FIELD, PRIMARY_BUTTON } from "./controlClasses";
import { KitLayer } from "./KitLayer";
import type { LocationIndex } from "./locationTree";

type Conversion = "move_holdings_to_child" | "create_unsorted_child";

type Props = {
  index: LocationIndex;
  /** The preselected parent: a Location id, or null for Top level. */
  initialParentId: string | null;
  /** Called with the created Location. The form stays busy until it settles. */
  onCreated: (location: TreeNode) => void | Promise<void>;
  onCancel: () => void;
  /** Reloads the Location tree after a stale or missing parent. */
  onTreeChanged: () => void | Promise<void>;
};

const NAME_MESSAGE = "Enter a name of 1 to 120 characters.";
const MESSAGES: Record<string, string> = {
  INVALID_LOCATION_NAME: NAME_MESSAGE,
  LOCATION_NAME_CONFLICT:
    "A Location with that name already exists under this parent.",
  LOCATION_DEPTH_LIMIT: "Locations can be nested at most 12 levels deep.",
  DECK_CANNOT_HAVE_CHILDREN: "A Deck cannot contain Locations.",
  STALE_LOCATION:
    "This Location changed. The tree has been refreshed; review it and try again.",
  LOCATION_NOT_FOUND:
    "That parent Location no longer exists. The tree has been refreshed; choose another parent.",
};
const UNSORTED_COLLISION =
  "The separate Unsorted child needs a unique name. Use another name for the new Location, or move the cards into it.";
const CHOOSE_MESSAGE = "Choose where to keep the existing cards.";
const FALLBACK_MESSAGE = "Unable to create the Location. Please retry.";

/** Every possible parent in tree order (natural A–Z, depth first). Decks can't have children. */
function parentOptions(index: LocationIndex): TreeNode[] {
  const result: TreeNode[] = [];
  const visit = (parentId: string | null) => {
    for (const node of index.children(parentId)) {
      if (node.kind === "deck") continue;
      result.push(node);
      visit(node.id);
    }
  };
  visit(null);
  return result;
}

/** The Name-and-parent create form in the kit Dialog (#165), a bottom sheet on a phone. The Name field
 * takes focus, and focus returns to the opener on close (to ☰ when it opened from the phone drawer,
 * whose own close puts focus there first). A stocked Storage Leaf parent is only known from the server's
 * STOCKED_LOCATION_REQUIRES_CONVERSION answer; the form then offers the two atomic conversion choices.
 * Cancel at any point creates nothing; Escape, the close button and the scrim are Cancel, except while
 * the form is busy. */
export function CreateLocationDialog({
  index,
  initialParentId,
  onCreated,
  onCancel,
  onTreeChanged,
}: Props) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState<string | null>(initialParentId);
  // The parent the server reported as stocked; its choices show while it stays selected.
  const [stockedParentId, setStockedParentId] = useState<string | null>(null);
  const [conversion, setConversion] = useState<Conversion | null>(null);
  const [error, setError] = useState("");
  const [nameInvalid, setNameInvalid] = useState(false);
  const [busy, setBusy] = useState(false);

  // A parent that disappeared after a refresh falls back to Top level.
  useEffect(() => {
    if (parentId && !index.byId.has(parentId)) setParentId(null);
  }, [index, parentId]);

  const options = parentOptions(index);
  const parent = parentId ? index.byId.get(parentId) : undefined;
  const stocked = stockedParentId !== null && stockedParentId === parentId;
  const trimmed = name.trim();

  function fail(message: string, onName: boolean) {
    setError(message);
    setNameInvalid(onName);
    if (onName) nameRef.current?.focus();
  }
  function resetConversion() {
    setStockedParentId(null);
    setConversion(null);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!trimmed) return fail(NAME_MESSAGE, true);
    if (stocked && !conversion) return fail(CHOOSE_MESSAGE, false);
    if (
      stocked &&
      conversion === "create_unsorted_child" &&
      trimmed.toLowerCase() === "unsorted"
    )
      return fail(UNSORTED_COLLISION, true);
    setBusy(true);
    setError("");
    setNameInvalid(false);
    try {
      const result = await createLocation({
        name: trimmed,
        parent_id: parentId,
        parent_version: parent?.version ?? null,
        conversion: stocked ? conversion : null,
        idempotency_key: crypto.randomUUID(),
      });
      await onCreated(result.location);
    } catch (cause) {
      const code = cause instanceof LocationError ? cause.code : "";
      if (code === "STOCKED_LOCATION_REQUIRES_CONVERSION" && parentId) {
        setStockedParentId(parentId);
        setConversion(null);
      } else if (
        code === "LOCATION_NAME_CONFLICT" &&
        stocked &&
        conversion === "create_unsorted_child"
      ) {
        fail(UNSORTED_COLLISION, true);
      } else if (code === "INVALID_LOCATION_CONVERSION") {
        resetConversion();
        fail(
          `${parent?.name ?? "That Location"} no longer contains cards. Review and create again.`,
          false
        );
        await onTreeChanged();
      } else if (code === "STALE_LOCATION" || code === "LOCATION_NOT_FOUND") {
        resetConversion();
        fail(MESSAGES[code], false);
        await onTreeChanged();
      } else {
        fail(
          MESSAGES[code] ?? FALLBACK_MESSAGE,
          code === "INVALID_LOCATION_NAME" || code === "LOCATION_NAME_CONFLICT"
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <KitLayer>
      <Dialog
        open
        onClose={() => {
          if (!busy) onCancel();
        }}
        title="Add location"
      >
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <label className="flex flex-col gap-2 text-meta text-text-muted">
            Name
            <input
              ref={nameRef}
              className={FIELD}
              data-autofocus
              value={name}
              maxLength={120}
              autoComplete="off"
              aria-invalid={nameInvalid || undefined}
              aria-describedby={error ? "ws-create-error" : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError("");
                setNameInvalid(false);
              }}
            />
          </label>
          <label className="flex flex-col gap-2 text-meta text-text-muted">
            Parent location
            <select
              className={FIELD}
              value={parentId ?? ""}
              onChange={(event) => {
                setParentId(event.target.value || null);
                setConversion(null);
                setError("");
                setNameInvalid(false);
              }}
            >
              <option value="">Top level</option>
              {options.map((node) => (
                <option key={node.id} value={node.id}>
                  {index.path(node.id)}
                </option>
              ))}
            </select>
          </label>
          {stocked && parent && (
            <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-panel border border-border p-4">
              <legend className="px-1 text-meta">
                {parent.name} contains cards. Where should they go?
              </legend>
              <label className="flex items-start gap-2 text-meta phone:min-h-tap phone:items-center">
                <input
                  type="radio"
                  name="conversion"
                  value="move_holdings_to_child"
                  className="m-0 mt-0.5 shrink-0 accent-accent phone:mt-0"
                  checked={conversion === "move_holdings_to_child"}
                  onChange={() => {
                    setConversion("move_holdings_to_child");
                    setError("");
                    setNameInvalid(false);
                  }}
                />
                Move existing cards into {trimmed || "the new Location"}
              </label>
              <label className="flex items-start gap-2 text-meta phone:min-h-tap phone:items-center">
                <input
                  type="radio"
                  name="conversion"
                  value="create_unsorted_child"
                  className="m-0 mt-0.5 shrink-0 accent-accent phone:mt-0"
                  checked={conversion === "create_unsorted_child"}
                  onChange={() => {
                    setConversion("create_unsorted_child");
                    setError("");
                    setNameInvalid(false);
                  }}
                />
                Create a separate Unsorted child for existing cards
              </label>
            </fieldset>
          )}
          {error && (
            <p
              id="ws-create-error"
              role="alert"
              className="m-0 flex items-start gap-1 text-meta text-danger"
            >
              <Icon icon={TriangleAlert} size={14} className="mt-px shrink-0" />
              <span>{error}</span>
            </p>
          )}
          <div className={BUTTON_ROW}>
            <button
              type="button"
              className={`inline-flex ${BUTTON}`}
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`inline-flex ${PRIMARY_BUTTON}`}
              disabled={busy}
            >
              {busy ? "Creating…" : "Create location"}
            </button>
          </div>
        </form>
      </Dialog>
    </KitLayer>
  );
}
