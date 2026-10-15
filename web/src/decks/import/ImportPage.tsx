import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  deleteDeck,
  DeckError,
  importDeck,
  type ImportDeckResult,
} from "../../decks_generated";
import { useToast } from "../../ui/Toast";
import type { TargetFormat } from "../targetFormat";
import {
  fixesFor,
  fixRefused,
  keeps,
  needsYou,
  sectionsOf,
  type Filter,
  type Pick,
} from "./importModel";
import { PasteStep } from "./PasteStep";
import { ReviewStep, type OpenPanel } from "./ReviewStep";
import { useImportReview } from "./useImportReview";

type Choices = { picks: Map<number, Pick>; drops: Set<number> };
type FocusNext = "heading" | "textArea" | "nameField" | null;
/** Where focus goes once the next review lands: past the fixed line, or back on its own action button. */
type FocusAfter = { line: number; same: boolean } | null;

/**
 * Import a decklist (/decks/import, #212): paste a list, name the new Deck and choose its Target Format, then check
 * every line ("Check the list") and Create Deck. The server reads the paste and answers every review; the page keeps
 * the collector's choices (a picked card or Edition, a dropped line) and posts them with the text. Create Deck is one
 * idempotent command; it lands in the Deck's builder with an Undo toast that deletes the Deck again.
 */
export function ImportPage({
  onOpenDeck,
  onAllDecks,
}: {
  onOpenDeck: (id: string) => void;
  onAllDecks: () => void;
}) {
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [targetFormat, setTargetFormat] = useState<TargetFormat>("standard");
  const [picks, setPicks] = useState<Map<number, Pick>>(new Map());
  const [drops, setDrops] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<OpenPanel>(null);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [nameMessage, setNameMessage] = useState("");

  const pendingSave = useRef<{ payloadKey: string; key: string } | null>(null);
  const previousChoices = useRef<Choices>({
    picks: new Map(),
    drops: new Set(),
  });
  const focusAfter = useRef<FocusAfter>(null);
  const focusNext = useRef<FocusNext>(null);
  const actionButtons = useRef(new Map<number, HTMLButtonElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);

  const state = useImportReview(
    text,
    fixesFor(picks, drops),
    step === "paste" ? 300 : 0
  );
  const toast = useToast();
  const review = state.review;

  // A step starts at the top, with focus where the collector goes next.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "heading") heading.current?.focus();
    if (target === "textArea") textArea.current?.focus();
    if (target === "nameField") nameField.current?.focus();
  }, [step]);

  // A fix the API refused is taken back.
  useEffect(() => {
    if (!fixRefused(state.code)) return;
    setPicks(previousChoices.current.picks);
    setDrops(previousChoices.current.drops);
    setSaveMessage(state.error);
  }, [state.code, state.error]);

  // After a fix lands, focus moves on to the next line that needs the collector.
  useEffect(() => {
    const after = focusAfter.current;
    if (!state.current || !review || after === null) return;
    focusAfter.current = null;
    const own = after.same ? actionButtons.current.get(after.line) : undefined;
    // Focus moves on only from where the collector's fix left it: the page, or the control the fix removed.
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    if (own) {
      own.focus();
      return;
    }
    const shown = sectionsOf(review.lines).flatMap((section) =>
      section.lines.filter((line) => keeps(filter, line))
    );
    const flagged = (line: { line: number }) =>
      actionButtons.current.has(line.line);
    const next =
      shown.find(
        (line) => line.line > after.line && needsYou(line) && flagged(line)
      ) ?? shown.find((line) => needsYou(line) && flagged(line));
    if (next) actionButtons.current.get(next.line)?.focus();
    else createButton.current?.focus();
  }, [review, state.current, filter]);

  const canReview =
    review !== null &&
    state.current &&
    review.totals.card_lines > 0 &&
    name.trim() !== "" &&
    state.error === "";

  function remember() {
    previousChoices.current = { picks: new Map(picks), drops: new Set(drops) };
  }

  function typeText(next: string) {
    setText(next);
    setPicks(new Map());
    setDrops(new Set());
    setOpen(null);
    setSaveMessage("");
    pendingSave.current = null;
  }

  function startReview() {
    if (!canReview || !review) return;
    setFilter(review.totals.to_resolve > 0 ? "needs" : "all");
    focusNext.current = "heading";
    setStep("review");
  }

  function backToPaste(focus: FocusNext = "textArea") {
    setOpen(null);
    focusNext.current = focus;
    setStep("paste");
  }

  function pick(line: number, choice: Pick) {
    remember();
    setSaveMessage("");
    setPicks((previous) => new Map(previous).set(line, choice));
    setDrops((previous) => {
      const next = new Set(previous);
      next.delete(line);
      return next;
    });
    setOpen(null);
    focusAfter.current = { line, same: false };
  }

  function drop(line: number) {
    remember();
    setSaveMessage("");
    setDrops((previous) => new Set(previous).add(line));
    setOpen(null);
    focusAfter.current = { line, same: false };
  }

  function restore(line: number) {
    remember();
    setSaveMessage("");
    setDrops((previous) => {
      const next = new Set(previous);
      next.delete(line);
      return next;
    });
    focusAfter.current = { line, same: true };
  }

  function chooseEdition(line: number, editionId: string) {
    remember();
    setSaveMessage("");
    setPicks((previous) =>
      new Map(previous).set(line, { edition_id: editionId })
    );
    setOpen(null);
    focusAfter.current = { line, same: true };
  }

  async function save() {
    if (!review || !state.current || review.totals.to_resolve > 0 || saving)
      return;
    setSaving(true);
    setSaveMessage("");
    const lines = review.deck_list.map(({ edition_id, quantity }) => ({
      edition_id,
      quantity,
    }));
    const payloadKey = JSON.stringify([name, targetFormat, lines]);
    const attempt =
      pendingSave.current?.payloadKey === payloadKey
        ? pendingSave.current
        : { payloadKey, key: crypto.randomUUID() };
    pendingSave.current = attempt;
    try {
      const result = await importDeck({
        name,
        target_format: targetFormat,
        lines,
        idempotency_key: attempt.key,
      });
      pendingSave.current = null;
      offerUndo(toast, result, review.totals.cards, onAllDecks);
      onOpenDeck(result.deck_id);
    } catch (cause) {
      if (cause instanceof DeckError && cause.status < 500) {
        pendingSave.current = null;
        if (
          cause.code === "LOCATION_NAME_CONFLICT" ||
          cause.code === "INVALID_LOCATION_NAME"
        ) {
          setNameMessage(
            cause.code === "LOCATION_NAME_CONFLICT"
              ? "Choose a different Deck name."
              : "Enter a valid Deck name."
          );
          backToPaste("nameField");
        } else {
          setSaveMessage(
            "Some cards changed in the catalog. The review is up to date now: check it and save again."
          );
          state.retry();
        }
      } else
        setSaveMessage(
          "Creation may have completed. Press Create Deck again to check safely."
        );
    } finally {
      setSaving(false);
    }
  }

  if (step === "review" && review)
    return (
      <ReviewStep
        review={review}
        state={state}
        name={name}
        targetFormat={targetFormat}
        filter={filter}
        onFilter={setFilter}
        open={open}
        onToggle={(line, kind) =>
          setOpen((previous) =>
            previous?.line === line && previous.kind === kind
              ? null
              : { line, kind }
          )
        }
        onPick={pick}
        onDrop={drop}
        onRestore={restore}
        onEdition={chooseEdition}
        actionRef={(line) => (element) => {
          if (element) actionButtons.current.set(line, element);
          else actionButtons.current.delete(line);
        }}
        headingRef={heading}
        createButtonRef={createButton}
        saving={saving}
        saveMessage={saveMessage}
        onBack={() => backToPaste()}
        onCreate={() => void save()}
      />
    );
  return (
    <PasteStep
      text={text}
      onText={typeText}
      name={name}
      onName={(next) => {
        setName(next);
        setNameMessage("");
        pendingSave.current = null;
      }}
      nameMessage={nameMessage}
      targetFormat={targetFormat}
      onTargetFormat={setTargetFormat}
      state={state}
      canReview={canReview}
      onReview={startReview}
      onAllDecks={onAllDecks}
      textAreaRef={textArea}
      nameRef={nameField}
    />
  );
}

/** Offers Undo for a Deck just created. A module-level function, so the toast and its Undo outlive the import page. */
function offerUndo(
  toast: ReturnType<typeof useToast>,
  result: ImportDeckResult,
  cards: string,
  onAllDecks: () => void
) {
  const deck = result.location;
  const key = crypto.randomUUID();
  const message = `Created ${deck.name} with ${cards === "1" ? "1 card" : `${cards} cards`}.`;
  const id = toast.show({
    message,
    action: { label: "Undo", keepOpen: true, onAction: () => void undo() },
  });
  async function undo() {
    toast.update(id, {
      message,
      action: {
        label: "Undo",
        keepOpen: true,
        busy: true,
        onAction: () => undefined,
      },
    });
    try {
      await deleteDeck(deck.id, {
        name: deck.name,
        version: deck.version,
        idempotency_key: key,
      });
    } catch (cause) {
      if (!(cause instanceof DeckError && cause.status === 404)) {
        toast.update(
          id,
          cause instanceof DeckError && cause.status < 500
            ? {
                message: `${deck.name} changed after it was created, so Undo is unavailable.`,
                action: {
                  label: "Undo",
                  disabled: true,
                  onAction: () => undefined,
                },
              }
            : {
                message: "Undo didn't finish. Press Undo to try again.",
                action: {
                  label: "Undo",
                  keepOpen: true,
                  onAction: () => void undo(),
                },
              }
        );
        return;
      }
    }
    onAllDecks();
    toast.show({ message: `Removed ${deck.name}.` });
  }
}
