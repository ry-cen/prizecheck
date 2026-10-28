import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type {
  BrowseEdition,
  EditionStandings,
} from "../catalog_browse_generated";
import { EditionPrice } from "../EditionPrice";
import { MetadataReport } from "../MetadataReport";
import { MissingCardReports } from "../MissingCardReports";
import { Button } from "../ui/Button";
import { CardArt, CardPopup } from "../ui/CardPopup";
import { Pill, type PillTone } from "../ui/Pill";
import { Select } from "../ui/Select";
import { AskControl, copyCap, copyCard } from "../loans/BorrowDrafts";
import { lendableText } from "../social/friendCards";
import { FriendsWhoHaveThis } from "../social/FriendsWhoHaveThis";
import { AskToTrade } from "../trades/AskToTrade";
import { Stepper } from "../ui/Stepper";
import { variantLabel } from "../ui/variantLabel";
import { TILE_PRICE } from "../workspace/Gallery";
import { OLD_BUTTONS, OLD_FIELDS, OLD_TEXT } from "../workspace/legacyContent";
import { addToCollection, type AddCommand } from "./cardActions";
import {
  addedText,
  addFailed,
  addMayHaveCompletedFor,
  copies,
  earlierAddFinishedFor,
  FORMATS,
  MAX_ADD,
  STANDING_WORDS,
} from "./catalogText";
import {
  useCardDetails,
  useCopiesWhere,
  type PopupEdition,
} from "./useCardDetails";
import type { AddedCards } from "./useAddToast";
import { usePlaces, type Place, type Places } from "./usePlaces";

/** A report flow opened from the footer: a metadata report preset to an Edition (null: the Printing's metadata), or
 * a missing-Edition report. */
export type CardReport =
  { kind: "metadata"; editionId: string | null } | { kind: "missing" };

/** What the popup shows: a Printing, the Edition to select first, the gallery row it was opened from (null from the
 * inspector's report link), and a report flow to open at once (the link). */
export type CardRequest = {
  printingId: string;
  editionId: string | null;
  row: BrowseEdition | null;
  report: CardReport | null;
};

type Props = {
  request: CardRequest | null;
  onClose: () => void;
  /** "‹ N / M ›" (index from 0), or null for a card opened on its own. */
  position: { index: number; total: number } | null;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  /** The Add row's pending command for an Edition (an add that may have completed), kept by the gallery so closing or
   * stepping away and pressing Add again still resends it under its own key (#196). */
  pendingFor: (editionId: string) => { current: AddCommand | null };
  /** The Add row's Location (null: Unsorted, else the first), and a new choice in it. The gallery keeps it from card to
   * card, and sets it to Add mode's target when the popup opens in Add mode (#175). */
  location: string | null;
  onLocation: (id: string) => void;
  /** A Location the Add row offers besides the Storage Leaves: Add mode's target when that is a Deck (Collection's Add
   * cards on an open Deck). */
  alsoOffer: Place | null;
  /** A batch add from the Add row succeeded: the gallery shows the new count on the tile, knows the owner revision
   * moved by itself, and shows the Undo toast. */
  onAdded: (added: AddedCards) => void;
  /** A metadata report was sent: My metadata reports reads again. */
  onReported: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
};

const TONES: Record<keyof typeof STANDING_WORDS, PillTone> = {
  legal: "ok",
  not_legal: "bad",
  unknown: "unverified",
};
const HEADING = "m-0 text-meta font-semibold text-text-muted";
const META = "m-0 text-meta text-text-muted";
const ROW = "flex flex-wrap items-center gap-2";
const ROW_LABEL =
  "w-20 shrink-0 text-meta font-semibold text-text-muted phone:w-full";
const EDITION =
  "box-border m-0 flex min-h-control w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-solid border-border-strong bg-surface-raised px-2 py-1 text-left font-sans text-meta text-text enabled:hover:border-control-outline aria-pressed:border-accent-border aria-pressed:bg-surface-selected phone:min-h-control-phone";
const REPORT_LINK =
  "inline-flex min-h-(--target-pointer) cursor-pointer items-center border-0 bg-transparent p-0 font-sans text-meta text-accent underline underline-offset-2 hover:text-accent-strong aria-expanded:font-semibold phone:min-h-tap";
// The old report forms (MetadataReport, MissingCardReports) keep their markup inside the kit dialog (#166, #173).
const LEGACY = `flex flex-col gap-3 pt-3 text-body ${OLD_BUTTONS} ${OLD_FIELDS} ${OLD_TEXT} [&_h2]:text-[length:1.5em] [&_h2]:font-bold [&_h3]:text-[length:1.17em] [&_h3]:font-bold [&_h4]:font-bold [&_label]:flex [&_label]:flex-col [&_label]:gap-1 [&_label]:text-meta [&_label]:text-text-muted [&_textarea]:box-border [&_textarea]:rounded-control [&_textarea]:border [&_textarea]:border-solid [&_textarea]:border-control-outline [&_textarea]:bg-bg [&_textarea]:p-2 [&_textarea]:font-sans [&_textarea]:text-control [&_textarea]:text-text [&_form]:flex [&_form]:flex-col [&_form]:gap-3 [&_ul]:m-0 [&_ul]:list-none [&_ul]:p-0`;

const byPath = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** Per card: the Edition picked and the report flow open. A step or a new card starts again from the request. */
type CardState = {
  key: string;
  selectedId: string | null;
  report: CardReport | null;
};

/**
 * Catalog's card popup (#174, spec "Catalog": CardPopup (Browse)). It answers everything about one Card Printing: the
 * art and its note; set name, code and number; regulation mark; the Card Identity when it differs from the name; the
 * owner-reviewed note on a manual record; a legality Pill per Format with the reason for an unknown one; the Editions as a picker, each with its
 * Variant, copies owned and price, and Owner reviewed and Unavailable badges; where the picked Edition's copies are;
 * "Friends who have this" (#251, FriendsWhoHaveThis); "Friends with this on their Trade List" with Ask to trade
 * (Trading #276, AskToTrade); the Add row (Collection | Location | − N + | Add N); and a quiet footer that opens today's
 * report flows.
 */
export function CatalogCardPopup({
  request,
  onClose,
  position,
  canPrevious,
  canNext,
  onPrevious,
  onNext,
  pendingFor,
  location,
  onLocation,
  alsoOffer,
  onAdded,
  onReported,
  returnFocus,
}: Props) {
  const open = request !== null;
  const { details, reload } = useCardDetails(request?.printingId ?? null);
  const places = usePlaces(open);
  const cardKey = request
    ? `${request.printingId}:${request.editionId ?? ""}`
    : "";
  const [card, setCard] = useState<CardState>({
    key: "",
    selectedId: null,
    report: null,
  });
  const focusReport = useRef(false);
  if (card.key !== cardKey) {
    // A new card: start from the request (React's "adjusting state when a prop changes").
    focusReport.current = request?.report != null;
    setCard({
      key: cardKey,
      selectedId: request?.editionId ?? null,
      report: request?.report ?? null,
    });
  }
  const [whereVersion, setWhereVersion] = useState(0);
  const reportRef = useRef<HTMLDivElement>(null);

  const ready = details.state === "ready" ? details : null;
  // Without the browse read, the gallery row still knows its own Edition's copies; the others read "unknown".
  const editions = (ready?.editions ?? []).map((edition) =>
    ready?.browse !== "ok" &&
    edition.active &&
    request?.row?.edition_id === edition.id
      ? { ...edition, owned: request.row.owned }
      : edition
  );
  const selected =
    editions.find((edition) => edition.id === card.selectedId) ??
    editions.find((edition) => edition.active) ??
    editions[0] ??
    null;
  const where = useCopiesWhere(selected?.id ?? null, whereVersion);
  const row = ready?.rows[0] ?? request?.row ?? null;
  const name = ready?.printing.name ?? request?.row?.name ?? "Card details";
  const artUrl = ready
    ? ready.printing.high_image_url
    : (request?.row?.image_url ?? null);

  // A report flow takes focus once its form is on screen, so it is in view and keyboard-ready.
  useEffect(() => {
    if (!focusReport.current || !card.report || !ready) return;
    focusReport.current = false;
    reportRef.current
      ?.querySelector<HTMLElement>("select, input, textarea")
      ?.focus();
  }, [card.report, ready]);

  function toggleReport(next: CardReport) {
    const same =
      card.report?.kind === next.kind &&
      (next.kind === "missing" ||
        (card.report?.kind === "metadata" &&
          card.report.editionId === next.editionId));
    focusReport.current = !same;
    setCard({ ...card, report: same ? null : next });
  }

  const announcement =
    position && request
      ? `Card ${(position.index + 1).toLocaleString()} of ${position.total.toLocaleString()}: ${name}`
      : "";
  const report = card.report;
  const reportEditionId =
    report?.kind === "metadata" &&
    editions.some((edition) => edition.id === report.editionId)
      ? report.editionId
      : null;

  return (
    <CardPopup
      open={open}
      onClose={onClose}
      title={name}
      position={position}
      canPrevious={canPrevious}
      canNext={canNext}
      onPrevious={onPrevious}
      onNext={onNext}
      cardKey={cardKey}
      announcement={announcement}
      returnFocus={returnFocus}
      art={<CardArt url={artUrl} name={name} />}
      footer={
        ready && (
          <>
            <p className="m-0 flex flex-wrap items-center gap-x-1.5 text-meta text-text-muted">
              <span>Report:</span>
              <button
                type="button"
                className={REPORT_LINK}
                aria-label="Report this Edition"
                aria-expanded={
                  report?.kind === "metadata" && report.editionId !== null
                }
                onClick={() =>
                  toggleReport({
                    kind: "metadata",
                    editionId: selected?.id ?? null,
                  })
                }
              >
                this Edition
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className={REPORT_LINK}
                aria-label="Report Printing metadata"
                aria-expanded={
                  report?.kind === "metadata" && report.editionId === null
                }
                onClick={() =>
                  toggleReport({ kind: "metadata", editionId: null })
                }
              >
                Printing metadata
              </button>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                className={REPORT_LINK}
                aria-label="Report a missing Edition"
                aria-expanded={report?.kind === "missing"}
                onClick={() => toggleReport({ kind: "missing" })}
              >
                a missing Edition
              </button>
            </p>
            {report && (
              <div ref={reportRef} className={LEGACY}>
                {report.kind === "missing" ? (
                  <MissingCardReports printingId={ready.printing.id} />
                ) : (
                  <MetadataReport
                    key={reportEditionId ? "edition" : "printing"}
                    printingId={ready.printing.id}
                    printingName={ready.printing.name}
                    editions={ready.printing.editions.map((edition) => ({
                      id: edition.id,
                      label: variantLabel(edition.descriptor),
                    }))}
                    initialEditionId={reportEditionId}
                    onSubmitted={onReported}
                  />
                )}
              </div>
            )}
          </>
        )
      }
    >
      {details.state === "failed" ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-body text-danger"
        >
          <p className="m-0">Card details are unavailable. Please retry.</p>
          <Button onClick={reload}>Retry</Button>
        </div>
      ) : !ready ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Loading card details…
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="m-0">
              {ready.printing.set_name} (
              {row?.set_code ?? ready.printing.set_id}) · #
              {ready.printing.collector_number}
            </p>
            <p className={META}>
              {row
                ? row.regulation_mark
                  ? `Regulation mark ${row.regulation_mark}`
                  : "No regulation mark recorded"
                : "Regulation mark unavailable"}
            </p>
            {ready.printing.identity_name !== ready.printing.name && (
              <p className={META}>
                Card Identity: {ready.printing.identity_name}
              </p>
            )}
            {ready.printing.source !== "tcgdex" && (
              <p className={META}>
                Owner reviewed manual record
                {ready.printing.evidence_url && (
                  <>
                    {" · "}
                    <a
                      href={ready.printing.evidence_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open reviewed evidence
                    </a>
                  </>
                )}
              </p>
            )}
          </div>
          <Legality
            standing={row?.standing ?? null}
            pending={ready.browse === "pending"}
          />
          <EditionPicker
            editions={editions}
            selectedId={selected?.id ?? null}
            onSelect={(id) =>
              setCard({
                ...card,
                selectedId: id,
                // An open Edition report follows the picker.
                report:
                  card.report?.kind === "metadata" &&
                  card.report.editionId !== null
                    ? { kind: "metadata", editionId: id }
                    : card.report,
              })
            }
          />
          {/* With one Edition the picker already says everything this block would repeat. */}
          {selected && editions.length > 1 && (
            <SelectedEdition edition={selected} />
          )}
          <Where where={where} places={places} />
          <FriendsWhoHaveThis
            printingId={ready.printing.id}
            editionId={selected?.id ?? null}
            action={(copy) => (
              <AskControl
                friend={copy}
                card={copyCard(copy, null)}
                cap={copyCap(copy)}
                lendable={lendableText(copy)}
                text="Ask to borrow"
              />
            )}
          />
          <AskToTrade printingId={ready.printing.id} />
          {selected && (
            <AddRows
              key={cardKey}
              cardName={name}
              pendingFor={pendingFor}
              edition={selected}
              places={places}
              alsoOffer={alsoOffer}
              location={location}
              onLocation={onLocation}
              onAdded={(added) => {
                onAdded(added);
                reload();
                setWhereVersion((value) => value + 1);
              }}
            />
          )}
        </>
      )}
    </CardPopup>
  );
}

/** One Pill per Format, and the reasons behind an unknown standing. */
function Legality({
  standing,
  pending,
}: {
  standing: EditionStandings | null;
  pending: boolean;
}) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <h3 id={headingId} className={HEADING}>
        Legality
      </h3>
      {standing ? (
        <>
          <ul
            aria-labelledby={headingId}
            className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          >
            {FORMATS.map((format) => {
              const { status } = standing[format.value];
              return (
                <li key={format.value}>
                  <Pill tone={TONES[status]}>
                    {format.label}: {STANDING_WORDS[status]}
                  </Pill>
                </li>
              );
            })}
          </ul>
          {FORMATS.filter(
            (format) => standing[format.value].status === "unknown"
          ).map((format) => (
            <p key={format.value} className={META}>
              {format.label} legality unknown:{" "}
              {standing[format.value].reasons.join(" ") ||
                "no reason was recorded."}
            </p>
          ))}
        </>
      ) : (
        <p className={META}>
          {pending ? "Loading legality…" : "Legality unavailable"}
        </p>
      )}
    </div>
  );
}

/** The Printing's Editions as toggle buttons: Variant, copies owned, price, and the badges. */
function EditionPicker({
  editions,
  selectedId,
  onSelect,
}: {
  editions: PopupEdition[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const headingId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <h3 id={headingId} className={HEADING}>
        Editions
      </h3>
      <div
        role="group"
        aria-labelledby={headingId}
        className="flex flex-col gap-1"
      >
        {editions.map((edition) => (
          <button
            key={edition.id}
            type="button"
            aria-pressed={edition.id === selectedId}
            onClick={() => onSelect(edition.id)}
            className={EDITION}
          >
            <span className="font-semibold">
              {variantLabel(edition.descriptor)}
            </span>
            <span className="text-text-muted tabular-nums">
              {edition.owned === null
                ? "Copies owned unknown"
                : edition.owned > 0
                  ? `${edition.owned.toLocaleString()} owned`
                  : "Not owned"}
            </span>
            {edition.active && (
              <span className={`${TILE_PRICE} min-w-0 tabular-nums`}>
                <EditionPrice editionId={edition.id} />
              </span>
            )}
            {edition.reviewed && <Pill>Owner reviewed</Pill>}
            {!edition.active && <Pill tone="unverified">Unavailable</Pill>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The picked Edition: its source and evidence, and its full price sentence. */
function SelectedEdition({ edition }: { edition: PopupEdition }) {
  return (
    <div
      role="group"
      aria-label="Selected Edition"
      className="flex flex-col gap-1 text-meta"
    >
      <p className="m-0">
        <strong>{variantLabel(edition.descriptor)}</strong>
        {edition.reviewed && " · Owner reviewed manual Edition"}
        {edition.evidenceUrl && (
          <>
            {" · "}
            <a href={edition.evidenceUrl} target="_blank" rel="noreferrer">
              Reviewed evidence
            </a>
          </>
        )}
      </p>
      {edition.active ? (
        <p className="m-0 text-text-muted">
          <EditionPrice key={edition.id} editionId={edition.id} />
        </p>
      ) : (
        <p className="m-0 text-text-muted">
          This Edition is unavailable: it has no price and can't be added.
        </p>
      )}
    </div>
  );
}

/** Where the picked Edition's copies are: each Location that holds some, by path. */
function Where({
  where,
  places,
}: {
  where: ReturnType<typeof useCopiesWhere>;
  places: Places;
}) {
  const headingId = useId();
  const leaves =
    where.state === "ready"
      ? where.holdings
          .map((holding) => ({
            id: holding.location_id,
            quantity: Number(holding.quantity) || 0,
            path: places.path(holding.location_id) ?? holding.location_name,
          }))
          .sort((a, b) => byPath.compare(a.path, b.path))
      : [];
  const total = leaves.reduce((sum, leaf) => sum + leaf.quantity, 0);
  return (
    <div className="flex flex-col gap-1">
      <h3 id={headingId} className={HEADING}>
        Where your copies are
      </h3>
      <p className={`${META} tabular-nums`}>
        {where.state === "loading"
          ? "Counting copies owned…"
          : where.state === "failed"
            ? "Copies owned unavailable"
            : total > 0
              ? `${copies(total.toLocaleString())} owned`
              : "You don't own this Edition yet."}
      </p>
      {leaves.length > 0 && (
        <ul
          aria-label="Copies by location"
          className="m-0 flex list-none flex-col gap-0.5 p-0 text-meta tabular-nums text-text-muted"
        >
          {leaves.map((leaf) => (
            <li key={leaf.id}>
              <span className="font-semibold text-text">
                {leaf.quantity.toLocaleString()}
              </span>{" "}
              in {leaf.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The Add row's last trouble: the Edition it was for, and what to say about it. */
type AddNote = {
  editionId: string;
  words: string;
  retry: boolean;
  text: string;
};

/**
 * The Add row: Collection | Location | − N + | Add N. The Location chosen stays chosen while the page is open (the
 * popup stays mounted). Add N puts physical copies in a Storage Leaf through a batch add of one item (#175), with an
 * Undo record.
 */
function AddRows({
  cardName,
  pendingFor,
  edition,
  places,
  alsoOffer,
  location: locationId,
  onLocation,
  onAdded,
}: {
  cardName: string;
  pendingFor: (editionId: string) => { current: AddCommand | null };
  edition: PopupEdition;
  places: Places;
  alsoOffer: Place | null;
  location: string | null;
  onLocation: (id: string) => void;
  onAdded: (added: AddedCards) => void;
}) {
  const headingId = useId();
  const leaves =
    alsoOffer && !places.leaves.some((leaf) => leaf.id === alsoOffer.id)
      ? [alsoOffer, ...places.leaves]
      : places.leaves;
  // The chosen Location while it still exists, else Unsorted (the Location every collector has), else the first.
  const location =
    leaves.find((leaf) => leaf.id === locationId) ??
    leaves.find((leaf) => leaf.label === "Unsorted") ??
    leaves[0];
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const words = (of: PopupEdition) =>
    `${cardName} ${variantLabel(of.descriptor)}`;
  // The last add's trouble: the Edition it was for (an add that may have completed stays resendable, kept by the
  // gallery), and what to say about it.
  const heldNote = (of: PopupEdition): AddNote | null =>
    pendingFor(of.id).current
      ? {
          editionId: of.id,
          words: words(of),
          retry: true,
          text: addFailed("", true),
        }
      : null;
  const [note, setNote] = useState<AddNote | null>(() => heldNote(edition));
  const usable = edition.active;
  const shown = useRef(edition.id);
  shown.current = edition.id;
  // Another Edition was picked: the count stays and the last Edition's result line goes. An add that may have
  // completed is not forgotten: the Edition picked now says so if it holds one, else the note names the other one.
  const [shownFor, setShownFor] = useState(edition.id);
  if (shownFor !== edition.id) {
    setShownFor(edition.id);
    setDone("");
    setNote(
      heldNote(edition) ??
        (note?.retry && note.editionId !== edition.id ? note : null)
    );
  }
  const failure = !note
    ? ""
    : note.editionId === edition.id
      ? note.text
      : addMayHaveCompletedFor(note.words);

  async function add() {
    if (!location || busy) return;
    setBusy(true);
    setDone("");
    setNote(null);
    const sent = edition;
    const outcome = await addToCollection(
      location.id,
      location.label,
      sent.id,
      count,
      pendingFor(sent.id)
    );
    setBusy(false);
    if (outcome.ok) {
      // A batch that may have completed earlier is settled first (#196): its copies are reported, and this press's
      // are not sent until the next one.
      const copiesAdded = outcome.items.reduce(
        (sum, item) => sum + item.quantity,
        0
      );
      // Like Add mode, only the settled copies leave the count; when that covers all of it, this is a plain success.
      const settledQuantity = outcome.settledEarlier
        ? outcome.items
            .filter((item) => item.editionId === shown.current)
            .reduce((sum, item) => sum + item.quantity, 0)
        : count;
      const remaining = count - settledQuantity;
      const stillPending = outcome.settledEarlier && remaining > 0;
      setDone(
        stillPending
          ? earlierAddFinishedFor(copiesAdded, words(sent), outcome.path)
          : addedText(copiesAdded, outcome.path)
      );
      setCount(Math.max(1, remaining));
      onAdded({
        locationId: outcome.locationId,
        path: outcome.path,
        items: outcome.items,
        copies: outcome.copies,
        ownerRevision: outcome.ownerRevision,
        undoId: outcome.undoId,
        from: "popup",
      });
    } else {
      setNote({
        editionId: sent.id,
        words: words(sent),
        retry: outcome.retry,
        text: addFailed(outcome.code, outcome.retry),
      });
      if (outcome.code === "LOCATION_NOT_FOUND") places.reload();
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 id={headingId} className={HEADING}>
        Add
      </h3>
      <div role="group" aria-label="Add to Collection" className={ROW}>
        <span className={ROW_LABEL}>Collection</span>
        <div className="min-w-0 flex-1 basis-40">
          <Select
            label="Location"
            labelHidden
            value={location?.id ?? ""}
            disabled={!leaves.length}
            onChange={(event) => onLocation(event.target.value)}
          >
            {leaves.length ? (
              leaves.map((leaf) => (
                <option key={leaf.id} value={leaf.id}>
                  {leaf.label}
                </option>
              ))
            ) : (
              <option value="">
                {places.state === "failed"
                  ? "Locations unavailable"
                  : "Loading Locations…"}
              </option>
            )}
          </Select>
        </div>
        <Stepper
          label="Copies to add"
          value={count}
          onChange={setCount}
          min={1}
          max={MAX_ADD}
          disabled={!usable}
        />
        <Button
          variant="primary"
          disabled={!usable || !location}
          aria-disabled={busy || undefined}
          onClick={() => void add()}
        >
          Add {count}
        </Button>
      </div>
      {!usable && (
        <p className={META}>
          This Edition is unavailable, so it can't be added.
        </p>
      )}
      <p role="status" className="m-0 text-meta text-text">
        {done}
      </p>
      <p role="alert" className="m-0 text-meta text-danger">
        {failure}
      </p>
    </div>
  );
}
