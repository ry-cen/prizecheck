import { useEffect, useRef, useState } from "react";
import { usePlaces } from "../catalog/usePlaces";
import {
  CollectionImportError,
  collectionImportPasteBody,
  getCurrentCollectionImport,
  startCollectionImport,
  startCollectionImportPaste,
  type CollectionImportSummary,
} from "../collection_import_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Segmented, segmentId } from "../ui/Segmented";
import { Select } from "../ui/Select";
import { TextArea } from "../ui/TextField";
import { ExportHelp } from "./ExportHelp";
import {
  MAX_UPLOAD_BYTES,
  PASTE_LARGE,
  SPLIT_LARGE,
  startErrorText,
  UNFINISHED_GONE,
} from "./importText";
import { ReplaceImportDialog, UnfinishedImport } from "./ImportUnfinished";

/** Upload a file, or Paste a list (#234). */
export type ImportMode = "file" | "paste";

const MODES = [
  { value: "file", label: "Upload a file" },
  { value: "paste", label: "Paste" },
] as const;

type Props = {
  /** Upload a file or Paste, kept by the page with the file and the text, so Back from the review keeps them. */
  mode: ImportMode;
  onMode: (mode: ImportMode) => void;
  /** The chosen file. */
  file: File | null;
  onFile: (file: File) => void;
  /** The pasted text. */
  text: string;
  onText: (text: string) => void;
  /** The chosen Storage Leaf, or null for the default: Unsorted, else the first Storage Leaf. */
  locationId: string | null;
  onLocation: (id: string) => void;
  onCancel: () => void;
  /** The review opens on `summary`; `label` is the file's name, or "Pasted list". */
  onReviewed: (summary: CollectionImportSummary, label: string) => void;
  /** The collector's open import draft (#233), or null; `checking` while the page still asks. */
  unfinished: CollectionImportSummary | null;
  checking: boolean;
  /** Continue import: the open draft as the server has it now. */
  onContinue: (summary: CollectionImportSummary) => void;
  /** Continue import found no open draft any more. */
  onGone: () => void;
};

/** Collection Import's first step (#226, #227): choose a file, or paste a list (#234), and where its cards go, then
 * Review import uploads it. A file PrizeCheck can't read opens How do I export from my tracker?, the one place the UI
 * names trackers. While an import is open (#233), Unfinished import offers to continue it, and Review import asks
 * before replacing it. */
export function ImportUpload({
  mode,
  onMode,
  file,
  onFile,
  text,
  onText,
  locationId,
  onLocation,
  onCancel,
  onReviewed,
  unfinished,
  checking,
  onContinue,
  onGone,
}: Props) {
  const places = usePlaces(true);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState<"reading" | "opening" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const fallback =
    places.leaves.find((leaf) => leaf.label === "Unsorted") ?? places.leaves[0];
  const chosen = places.leaves.some((leaf) => leaf.id === locationId)
    ? locationId
    : (fallback?.id ?? null);
  const pasting = mode === "paste";
  const ready = pasting ? text.trim() !== "" : file !== null;

  useEffect(() => {
    heading.current?.focus();
  }, []);

  /** Continue import: reads the open draft again, so the review opens on it as it is now. */
  async function resume() {
    setBusy("opening");
    setError(null);
    try {
      onContinue(await getCurrentCollectionImport());
    } catch (failure) {
      if (failure instanceof CollectionImportError && failure.status === 404) {
        onGone();
        setError(UNFINISHED_GONE);
      } else setError("Couldn't open your import. Try again.");
      setBusy(null);
    }
  }

  /** Review import: uploads the file or the pasted text, after asking first when it would replace an open import
   * (`replace` once the collector chose Replace import). */
  async function review(replace = false) {
    if (!ready || !chosen) return;
    // Refused here rather than by the gateway: a browser may report a refused upload as a lost connection. A paste is
    // measured as the JSON body it goes as, escapes included.
    const size = pasting
      ? new Blob([collectionImportPasteBody(text)]).size
      : file!.size;
    if (size > MAX_UPLOAD_BYTES) {
      setError(pasting ? PASTE_LARGE : SPLIT_LARGE);
      return;
    }
    if (unfinished && !replace) {
      setConfirming(true);
      return;
    }
    setBusy("reading");
    setError(null);
    try {
      if (pasting)
        onReviewed(
          await startCollectionImportPaste(chosen, text),
          "Pasted list"
        );
      else onReviewed(await startCollectionImport(chosen, file!), file!.name);
    } catch (failure) {
      setError(startErrorText(failure, mode));
      if (
        !pasting &&
        failure instanceof CollectionImportError &&
        failure.code === "IMPORT_UNREADABLE"
      )
        setHelpOpen(true);
      if (
        failure instanceof CollectionImportError &&
        failure.code === "NOT_STORAGE_LEAF"
      )
        places.reload();
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto box-border flex w-full max-w-3xl flex-col gap-6 px-7 py-6 phone:px-4 phone:py-4">
      <PageHeader
        title="Import your collection"
        headingRef={heading}
        actions={
          <Button variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        }
      />
      <p className="m-0 text-body text-text-muted">
        Bring cards over from another tracker. Nothing is added until
        you&apos;ve reviewed it.
      </p>
      {unfinished && (
        <UnfinishedImport
          summary={unfinished}
          busy={busy !== null}
          onContinue={() => void resume()}
        />
      )}
      <section
        aria-labelledby="import-source-heading"
        className="flex flex-col gap-3"
      >
        <h2
          id="import-source-heading"
          className="m-0 text-heading font-semibold"
        >
          Your cards
        </h2>
        <p className="m-0 text-body text-text-muted">
          PrizeCheck keeps each card, its finish and how many you have.
          Condition, prices paid and notes aren&apos;t imported.
        </p>
        <Segmented
          label="Upload a file or paste a list"
          idBase="import-source"
          panelId="import-source-panel"
          options={MODES}
          value={mode}
          onChange={(next) => {
            onMode(next);
            setError(null);
          }}
        />
        <div
          id="import-source-panel"
          role="tabpanel"
          aria-labelledby={segmentId("import-source", mode)}
          className="flex min-w-0 flex-col gap-3"
        >
          {pasting ? (
            <>
              <TextArea
                label="Your list"
                rows={10}
                spellCheck={false}
                value={text}
                aria-describedby="import-paste-help"
                onChange={(event) => {
                  onText(event.target.value);
                  setError(null);
                }}
              />
              <p
                id="import-paste-help"
                className="m-0 text-meta text-text-muted"
              >
                One card per line, like 3 Pikachu SVI 25 or Charizard #4 Base
                Set. Rows copied from a spreadsheet work too, with their header
                row.
              </p>
            </>
          ) : (
            <>
              <p className="m-0 text-body text-text-muted">
                Choose a CSV, TSV or TXT file, or a zip file holding one.
              </p>
              <input
                ref={input}
                type="file"
                accept=".csv,.tsv,.txt,.zip,text/csv,text/tab-separated-values,text/plain,application/zip"
                hidden
                onChange={(event) => {
                  const next = event.target.files?.[0];
                  event.target.value = "";
                  if (!next) return;
                  onFile(next);
                  setError(null);
                }}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={() => input.current?.click()}>
                  {file ? "Choose another file" : "Choose file"}
                </Button>
                {file && (
                  <span className="min-w-0 text-body wrap-anywhere">
                    {file.name}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </section>
      <section className="flex flex-col gap-2">
        <div className="w-80 max-w-full">
          <Select
            label="Put cards in"
            value={chosen ?? ""}
            disabled={places.state !== "ready" || places.leaves.length === 0}
            aria-describedby="import-place-help"
            onChange={(event) => onLocation(event.target.value)}
          >
            {places.leaves.map((leaf) => (
              <option key={leaf.id} value={leaf.id}>
                {leaf.label}
              </option>
            ))}
          </Select>
        </div>
        <p id="import-place-help" className="m-0 text-meta text-text-muted">
          {places.state === "failed"
            ? "Your Locations didn't load."
            : places.state === "ready" && places.leaves.length === 0
              ? "Make a Location in your Collection first."
              : "Everything goes here. You can sort cards into other Locations afterwards."}
        </p>
        {places.state === "failed" && (
          <Button className="self-start" onClick={places.reload}>
            Try again
          </Button>
        )}
      </section>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          ref={reviewButton}
          variant="primary"
          disabled={!ready || !chosen || busy !== null || checking}
          onClick={() => void review()}
        >
          Review import
        </Button>
        <p
          role="status"
          className={`m-0 min-w-0 text-body ${error ? "text-warning" : "text-text-muted"}`}
        >
          {busy === "reading"
            ? pasting
              ? "Reading your list…"
              : "Reading your file…"
            : busy === "opening"
              ? "Opening your import…"
              : (error ?? "")}
        </p>
      </div>
      <ReplaceImportDialog
        open={confirming}
        onKeep={() => setConfirming(false)}
        onReplace={() => {
          setConfirming(false);
          void review(true);
        }}
        returnFocus={reviewButton}
      />
      <ExportHelp
        open={helpOpen}
        onToggle={() => setHelpOpen((value) => !value)}
      />
    </main>
  );
}
