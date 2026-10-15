import { useEffect, useRef, useState } from "react";
import { usePlaces } from "../catalog/usePlaces";
import {
  CollectionImportError,
  getCurrentCollectionImport,
  startCollectionImport,
  type CollectionImportSummary,
} from "../collection_import_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { ExportHelp } from "./ExportHelp";
import {
  MAX_UPLOAD_BYTES,
  SPLIT_LARGE,
  startErrorText,
  UNFINISHED_GONE,
} from "./importText";
import { ReplaceImportDialog, UnfinishedImport } from "./ImportUnfinished";

type Props = {
  /** The chosen file, kept by the page so Back from the review keeps it. */
  file: File | null;
  onFile: (file: File) => void;
  /** The chosen Storage Leaf, or null for the default: Unsorted, else the first Storage Leaf. */
  locationId: string | null;
  onLocation: (id: string) => void;
  onCancel: () => void;
  onReviewed: (summary: CollectionImportSummary, fileName: string) => void;
  /** The collector's open import draft (#233), or null; `checking` while the page still asks. */
  unfinished: CollectionImportSummary | null;
  checking: boolean;
  /** Continue import: the open draft as the server has it now. */
  onContinue: (summary: CollectionImportSummary) => void;
  /** Continue import found no open draft any more. */
  onGone: () => void;
};

/** Collection Import's first step (#226, #227): choose a file and where its cards go, then Review import uploads it.
 * A file PrizeCheck can't read opens How do I export from my tracker?, the one place the UI names trackers. While an
 * import is open (#233), Unfinished import offers to continue it, and Review import asks before replacing it. */
export function ImportUpload({
  file,
  onFile,
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

  /** Review import: uploads the file, after asking first when it would replace an open import (`replace` once the
   * collector chose Replace import). */
  async function review(replace = false) {
    if (!file || !chosen) return;
    // Refused here rather than by the gateway: a browser may report a refused upload as a lost connection.
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(SPLIT_LARGE);
      return;
    }
    if (unfinished && !replace) {
      setConfirming(true);
      return;
    }
    setBusy("reading");
    setError(null);
    try {
      onReviewed(await startCollectionImport(chosen, file), file.name);
    } catch (failure) {
      setError(startErrorText(failure));
      if (
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
        aria-labelledby="import-upload-heading"
        className="flex flex-col gap-3"
      >
        <h2
          id="import-upload-heading"
          className="m-0 text-heading font-semibold"
        >
          Upload a file
        </h2>
        <p className="m-0 text-body text-text-muted">
          PrizeCheck keeps each card, its finish and how many you have.
          Condition, prices paid and notes aren&apos;t imported.
        </p>
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
            <span className="min-w-0 text-body wrap-anywhere">{file.name}</span>
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
          disabled={!file || !chosen || busy !== null || checking}
          onClick={() => void review()}
        >
          Review import
        </Button>
        <p
          role="status"
          className={`m-0 min-w-0 text-body ${error ? "text-warning" : "text-text-muted"}`}
        >
          {busy === "reading"
            ? "Reading your file…"
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
