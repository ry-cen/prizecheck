import { useState } from "react";
import type { CollectionImportSummary } from "../collection_import_generated";
import { ImportReview } from "./ImportReview";
import { ImportUpload } from "./ImportUpload";

type Props = {
  /** Cancel: back to Collection. */
  onCancel: () => void;
  /** After a save: show the Storage Leaf the cards went to. */
  onLanded: (locationId: string) => void;
};

/**
 * Collection Import (#226) at /collection/import, in Collection's place: upload a file and choose where its cards
 * go, then review it and add them in one step. The import draft lives on the server; opening this page always starts
 * at the upload, and a new upload replaces the collector's open draft (resuming one is #233).
 */
export function CollectionImportPage({ onCancel, onLanded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [review, setReview] = useState<{
    summary: CollectionImportSummary;
    fileName: string;
  } | null>(null);

  if (review)
    return (
      <ImportReview
        key={review.summary.id}
        summary={review.summary}
        fileName={review.fileName}
        onBack={() => setReview(null)}
        onLanded={onLanded}
        onLocation={setLocationId}
      />
    );
  return (
    <ImportUpload
      file={file}
      onFile={setFile}
      locationId={locationId}
      onLocation={setLocationId}
      onCancel={onCancel}
      onReviewed={(summary, fileName) => {
        setLocationId(summary.location_id);
        setReview({ summary, fileName });
      }}
    />
  );
}
