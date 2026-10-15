import { useEffect, useState } from "react";
import {
  getCurrentCollectionImport,
  type CollectionImportSummary,
} from "../collection_import_generated";
import { ImportReview } from "./ImportReview";
import { ImportUpload, type ImportMode } from "./ImportUpload";

type Props = {
  /** Cancel: back to Collection. */
  onCancel: () => void;
  /** After a save: show the Storage Leaf the cards went to. */
  onLanded: (locationId: string) => void;
};

/** The collector's open import draft, as far as the page knows: still asking, none, or this one. */
type Unfinished =
  | { status: "checking" }
  | { status: "none" }
  | { status: "open"; summary: CollectionImportSummary };

/**
 * Collection Import (#226) at /collection/import, in Collection's place: upload a file, or paste a list (#234), and
 * choose where its cards go, then review it and add them in one step. The import draft lives on the server for a day after its last change
 * (#233): the page asks for it on opening, so a reload or a return offers Continue import, and a new upload asks
 * before it replaces the open draft.
 */
export function CollectionImportPage({ onCancel, onLanded }: Props) {
  const [mode, setMode] = useState<ImportMode>("file");
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [locationId, setLocationId] = useState<string | null>(null);
  const [unfinished, setUnfinished] = useState<Unfinished>({
    status: "checking",
  });
  const [review, setReview] = useState<{
    summary: CollectionImportSummary;
    /** What the review is of: the file's name, "Pasted list", or null for a continued import, whose name the server
     * doesn't keep. */
    label: string | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    // No open draft (404), or no answer: there is nothing to continue, and a new upload replaces whatever there is.
    getCurrentCollectionImport().then(
      (summary) => {
        if (live) setUnfinished({ status: "open", summary });
      },
      () => {
        if (live) setUnfinished({ status: "none" });
      }
    );
    return () => {
      live = false;
    };
  }, []);

  function open(summary: CollectionImportSummary, label: string | null) {
    setLocationId(summary.location_id);
    setUnfinished({ status: "open", summary });
    setReview({ summary, label });
  }

  if (review)
    return (
      <ImportReview
        key={review.summary.id}
        summary={review.summary}
        label={review.label}
        onBack={(latest) => {
          setUnfinished({ status: "open", summary: latest });
          setReview(null);
        }}
        onLanded={onLanded}
        onLocation={setLocationId}
      />
    );
  return (
    <ImportUpload
      mode={mode}
      onMode={setMode}
      file={file}
      onFile={setFile}
      text={text}
      onText={setText}
      locationId={locationId}
      onLocation={setLocationId}
      onCancel={onCancel}
      onReviewed={(summary, label) => open(summary, label)}
      unfinished={unfinished.status === "open" ? unfinished.summary : null}
      checking={unfinished.status === "checking"}
      onContinue={(summary) => open(summary, null)}
      onGone={() => setUnfinished({ status: "none" })}
    />
  );
}
