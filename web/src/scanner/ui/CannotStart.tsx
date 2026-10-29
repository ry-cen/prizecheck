import { CameraOff } from "lucide-react";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { ScrollArea } from "../../ui/ScrollArea";
import {
  CANNOT_START,
  CAUSE_DENIED,
  CAUSE_NO_CAMERA,
  CAUSE_UNSUPPORTED,
  GENERIC_CAUSE,
  HOW_TO_ALLOW,
  HOW_TO_ALLOW_ANDROID,
  HOW_TO_ALLOW_IOS,
  IMPORT_ELSEWHERE,
  REVIEW_TRAY,
  SEARCH_FOR_CARDS,
  trayStill,
  TRY_AGAIN,
} from "./copy";
import type { StartCause } from "./startFailure";

const CAUSES: Partial<Record<StartCause, string>> = {
  denied: CAUSE_DENIED,
  "no-camera": CAUSE_NO_CAMERA,
  unsupported: CAUSE_UNSUPPORTED,
};

/** One screen for every reason the scanner cannot start. It names a cause only when the collector can act on it (no
 * camera, camera denied with how to allow it, an unsupported browser); any other failure gets the generic line. */
export function CannotStart({
  cause,
  trayCopies,
  onSearch,
  onImport,
  onTryAgain,
  onReviewTray,
}: {
  cause: StartCause;
  /** Copies in the tray, so Review tray shows only when it holds cards. */
  trayCopies: number;
  onSearch: () => void;
  onImport: () => void;
  onTryAgain: () => void;
  onReviewTray: () => void;
}) {
  return (
    <ScrollArea
      className="absolute inset-0 z-10"
      viewportClassName="flex flex-col items-center justify-center gap-3 px-5 py-6 text-center"
    >
      <Icon icon={CameraOff} size={28} className="text-text-muted" />
      <h2 className="m-0 text-heading font-semibold text-text">
        {CANNOT_START}
      </h2>
      {CAUSES[cause] && (
        <p className="m-0 max-w-96 text-body text-text">{CAUSES[cause]}</p>
      )}
      <p className="m-0 max-w-96 text-body text-text-muted">{GENERIC_CAUSE}</p>
      {cause === "denied" && (
        <details className="max-w-96 text-left text-body text-text-muted">
          <summary className="flex min-h-tap cursor-pointer items-center text-text">
            {HOW_TO_ALLOW}
          </summary>
          <p>{HOW_TO_ALLOW_IOS}</p>
          <p>{HOW_TO_ALLOW_ANDROID}</p>
        </details>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={onSearch}>
          {SEARCH_FOR_CARDS}
        </Button>
        <Button onClick={onImport}>{IMPORT_ELSEWHERE}</Button>
        <Button variant="quiet" onClick={onTryAgain}>
          {TRY_AGAIN}
        </Button>
      </div>
      {trayCopies > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <p className="m-0 text-body text-text-muted tabular-nums">
            {trayStill(trayCopies)}
          </p>
          <Button onClick={onReviewTray}>{REVIEW_TRAY}</Button>
        </div>
      )}
    </ScrollArea>
  );
}
