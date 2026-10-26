import type { ScannerProgress } from "../assets/loader";
import { GETTING_READY } from "./copy";

/** "Getting the scanner ready", and a bar only while something is downloading. Nothing else is said. */
export function GettingReady({
  progress,
}: {
  progress: ScannerProgress | null;
}) {
  const percent =
    progress && progress.total > 0
      ? Math.round((progress.loaded / progress.total) * 100)
      : 0;
  return (
    <div className="absolute inset-x-0 top-1/2 z-10 mx-auto flex w-full max-w-80 -translate-y-1/2 flex-col items-center gap-3 px-6 text-center">
      <h2 className="m-0 text-heading font-semibold text-text">
        {GETTING_READY}
      </h2>
      {progress && (
        <div
          role="progressbar"
          aria-label={GETTING_READY}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-2 w-full overflow-hidden rounded-round bg-surface-raised"
        >
          <div
            style={{ width: `${percent}%` }}
            className="h-full rounded-round bg-accent"
          />
        </div>
      )}
    </div>
  );
}
