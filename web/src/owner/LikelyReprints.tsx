import { useEffect, useRef, useState } from "react";
import {
  dismissLikelyReprints,
  getLikelyReprints,
  undoLikelyReprints,
  type LikelyReprintPair,
} from "../metadata_generated";
import { HoldingError } from "../holdings_generated";
import { Button } from "../ui/Button";
import { ReprintReviewCard } from "./ReprintReviewCard";
import { place } from "./reprintValues";

/** Structural matches between effective groups; the existing card owns all merge decisions. */
export function LikelyReprints({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<LikelyReprintPair[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [undo, setUndo] = useState<{
    key: string;
    id: string;
    evidence_digest: string;
  } | null>(null);
  const loading = useRef(false);
  const generation = useRef(0);
  const [pending, setPending] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | null>(null);
  const previousKeys = useRef<string[]>([]);
  useEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = items.map((pair) => pair.key);
    if (!focusAfter.current) return;
    const target = focusAfter.current;
    focusAfter.current = null;
    const index = previous.indexOf(target);
    const neighbour =
      previous.slice(index + 1).find((key) => buttons.current.has(key)) ??
      previous
        .slice(0, index)
        .reverse()
        .find((key) => buttons.current.has(key));
    (
      buttons.current.get(target) ??
      buttons.current.get(neighbour ?? "") ??
      heading.current
    )?.focus();
  }, [items]);
  function close(key: string) {
    setOpen(null);
    buttons.current.get(key)?.focus();
  }
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  // A failed full refresh hides the rows, so no control acts on evidence the list could not confirm.
  const [failed, setFailed] = useState(false);
  /** True when the page was read and shown; a superseded or failed request is false. */
  async function load(cursor?: string): Promise<boolean> {
    if (cursor && loading.current) return false;
    const request = ++generation.current;
    loading.current = true;
    setPending(true);
    try {
      const page = await getLikelyReprints(cursor);
      if (request !== generation.current) return false;
      setItems((previous) =>
        cursor ? [...previous, ...page.items] : page.items
      );
      setNext(page.next_cursor);
      setFailed(false);
      setStatus("");
      return true;
    } catch {
      if (request === generation.current) {
        if (!cursor) {
          setItems([]);
          setNext(null);
          setOpen(null);
          setFailed(true);
        }
        setStatus("Unable to load likely reprints.");
      }
      return false;
    } finally {
      if (request === generation.current) {
        loading.current = false;
        setPending(false);
      }
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function conflict(key: string) {
    setUndo(null);
    setOpen(null);
    focusAfter.current = key;
    if (await load()) setStatus("The cards changed. Review them again.");
    onChanged();
  }
  async function dismiss(pair: LikelyReprintPair) {
    setBusy(true);
    try {
      const decision = await dismissLikelyReprints(pair);
      setUndo({
        key: pair.key,
        id: decision.id,
        evidence_digest: pair.evidence_digest,
      });
      focusAfter.current = pair.key;
      setOpen(null);
      await load();
      onChanged();
    } catch (error) {
      if (error instanceof HoldingError && error.status === 409)
        await conflict(pair.key);
      else setStatus("Unable to dismiss likely reprints.");
    } finally {
      setBusy(false);
    }
  }
  async function restore() {
    if (!undo) return;
    setBusy(true);
    try {
      await undoLikelyReprints(undo.id, {
        evidence_digest: undo.evidence_digest,
      });
      focusAfter.current = undo.key;
      setUndo(null);
      await load();
      onChanged();
    } catch (error) {
      if (error instanceof HoldingError && error.status === 409)
        await conflict(undo.key);
      else setStatus("Unable to undo dismissal.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Likely reprints">
      <h2 ref={heading} tabIndex={-1}>
        Likely reprints
      </h2>
      <p>
        These groups have matching Pokémon stats, attacks and regulation marks.
        Review their text before merging.
      </p>
      {status && <p role="status">{status}</p>}
      {failed && (
        <Button disabled={pending} onClick={() => void load()}>
          Try again
        </Button>
      )}
      {undo && (
        <p>
          Dismissed.{" "}
          <Button disabled={busy} onClick={() => void restore()}>
            Undo dismissal
          </Button>
        </p>
      )}
      {!items.length && !failed && <p>No likely reprints.</p>}
      {items.map((pair) => (
        <div key={pair.key}>
          <h3>{pair.identity_name}</h3>
          <p>{pair.printings.map(place).join(", ")}</p>
          <Button
            ref={(element: HTMLButtonElement | null) => {
              if (element) buttons.current.set(pair.key, element);
              else buttons.current.delete(pair.key);
            }}
            aria-label={`Review ${pair.identity_name}, ${pair.printings.map(place).join(", ")}`}
            aria-expanded={open === pair.key}
            onClick={() =>
              open === pair.key ? close(pair.key) : setOpen(pair.key)
            }
          >
            Review
          </Button>
          <Button disabled={busy} onClick={() => void dismiss(pair)}>
            Not reprints
          </Button>
          {open === pair.key && (
            <ReprintReviewCard
              row={{
                identityId: pair.identity_id,
                name: pair.identity_name,
                printings: [],
                openedAt: "",
              }}
              onClose={() => close(pair.key)}
              onDone={() => {
                focusAfter.current = pair.key;
                setOpen(null);
                void load();
                onChanged();
              }}
            />
          )}
        </div>
      ))}
      {next && (
        <Button disabled={pending} onClick={() => void load(next)}>
          Load more likely reprints
        </Button>
      )}
    </section>
  );
}
