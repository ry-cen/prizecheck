import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  changeDeckList,
  deleteDeck,
  DeckError,
  importDeck,
  type ImportDeckResult,
  type ImportReplace,
} from "../../decks_generated";
import { useToast } from "../../ui/Toast";
import { formatLabel, type TargetFormat } from "../targetFormat";
import {
  fixesFor,
  fixRefused,
  keeps,
  needsYou,
  sectionsOf,
  type Filter,
  type Pick,
} from "./importModel";
import { useOwnedCards } from "./ownedCards";
import { PasteStep } from "./PasteStep";
import {
  offerReplaceUndo,
  STALE_REPLACE_TEXT,
  tooManyChanges,
  tooManyText,
  type ReplaceTarget,
} from "./replaceList";
import {
  ReplacePasteDestination,
  ReplaceReviewDestination,
  WillBecomeSurplus,
} from "./ReplaceParts";
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
 *
 * With `replace` (/decks/<id>/replace, Replace list…, #215) the paste replaces that Deck's Deck List: the review uses
 * the Deck's own copies first and shows Will become Surplus, and Replace Deck List sends the review's changes batch at
 * its Deck List revision (replaceList.ts). A save answered STALE_DECK_LIST reviews again; Undo is the inverse batch.
 */
export function ImportPage({
  onOpenDeck,
  onAllDecks,
  replace = null,
}: {
  onOpenDeck: (id: string) => void;
  onAllDecks: () => void;
  /** The Deck whose Deck List the paste replaces; null imports into a new Deck. */
  replace?: ReplaceTarget | null;
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
  const [owned, setOwned] = useOwnedCards();

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
    owned,
    step === "paste" ? 300 : 0,
    replace?.deckId ?? null
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
    (replace !== null || name.trim() !== "") &&
    state.error === "";
  // Replace (#215): a batch over the Deck List changes cap can't be saved.
  const saveBlocked =
    replace && review?.replace && tooManyChanges(review.replace)
      ? tooManyText(review.replace)
      : null;

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
    // Change on a resolved line (Basic Energy) keeps the focus on that line; a fix moves on to the next flagged line.
    const resolved =
      review?.lines.some((each) => each.line === line && !needsYou(each)) ??
      false;
    remember();
    setSaveMessage("");
    setPicks((previous) => new Map(previous).set(line, choice));
    setDrops((previous) => {
      const next = new Set(previous);
      next.delete(line);
      return next;
    });
    setOpen(null);
    focusAfter.current = { line, same: resolved };
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
    if (replace) {
      if (review.replace && saveBlocked === null)
        await saveReplace(review.replace);
      return;
    }
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

  /** Replace Deck List (#215): the review's changes batch at the Deck List revision it read, sent once per key. */
  async function saveReplace(answer: ImportReplace) {
    // Nothing listed before and nothing now: there is no batch to send.
    if (answer.changes.length === 0) {
      onOpenDeck(answer.deck_id);
      return;
    }
    setSaving(true);
    setSaveMessage("");
    const payloadKey = JSON.stringify([
      "replace",
      answer.deck_id,
      answer.deck_list_revision,
      answer.changes,
    ]);
    const attempt =
      pendingSave.current?.payloadKey === payloadKey
        ? pendingSave.current
        : { payloadKey, key: crypto.randomUUID() };
    pendingSave.current = attempt;
    try {
      const result = await changeDeckList(answer.deck_id, {
        revision: answer.deck_list_revision,
        idempotency_key: attempt.key,
        changes: answer.changes,
      });
      pendingSave.current = null;
      offerReplaceUndo(toast, answer, result);
      onOpenDeck(answer.deck_id);
    } catch (cause) {
      if (cause instanceof DeckError && cause.status < 500) {
        pendingSave.current = null;
        // A deleted Deck: its builder says so.
        if (cause.status === 404) onOpenDeck(answer.deck_id);
        else {
          setSaveMessage(
            cause.code === "STALE_DECK_LIST"
              ? STALE_REPLACE_TEXT
              : "Some cards changed in the catalog. The review is up to date now: check it and save again."
          );
          state.retry();
        }
      } else
        setSaveMessage(
          "Replacing may have completed. Press Replace Deck List again to check safely."
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
        destination={
          replace ? (
            <ReplaceReviewDestination name={replace.name} />
          ) : (
            <p className="m-0 text-body">
              New Deck <strong className="font-semibold">{name}</strong> ·
              Target Format{" "}
              <strong className="font-semibold">
                {formatLabel(targetFormat)}
              </strong>
            </p>
          )
        }
        sidePanel={
          replace && review.replace ? (
            <WillBecomeSurplus
              rows={review.replace.surplus}
              name={replace.name}
            />
          ) : undefined
        }
        saveLabel={replace ? "Replace Deck List" : "Create Deck"}
        saveBlocked={saveBlocked}
        owned={owned}
        onOwned={(next) => {
          setSaveMessage("");
          setOwned(next);
        }}
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
      {...(replace
        ? {
            heading: `Replace ${replace.name}'s list`,
            back: {
              label: replace.name,
              href: `/decks/${encodeURIComponent(replace.deckId)}`,
              onClick: () => onOpenDeck(replace.deckId),
            },
            destination: <ReplacePasteDestination name={replace.name} />,
          }
        : {})}
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
