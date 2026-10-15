import { Button } from "../ui/Button";
import type { WantListLine, WantListSection } from "../want_list_generated";
import { swapHintText, swapLabel, type WantListSwap } from "./useWantListSwap";

/**
 * A Want List line's Swap hint (decklist import #211; the Want List page): "↻ You own a playable version (PAL 254) × 1"
 * with **Swap**, which moves that many copies of the line onto a line for the owned Edition in the same Deck List. It
 * spans the line under its card and counts; on a phone the button takes the full width.
 */
export function SwapHint({
  section,
  line,
  swap,
}: {
  section: WantListSection;
  line: WantListLine;
  swap: WantListSwap;
}) {
  const hint = line.swap;
  if (!hint) return null;
  return (
    <div className="col-span-full flex flex-wrap items-center gap-x-3 gap-y-2 rounded-control border border-accent-border bg-accent-wash px-3 py-2">
      <p className="m-0 min-w-0 flex-1 text-meta wrap-anywhere">
        <span aria-hidden="true">↻</span> {swapHintText(hint)}
      </p>
      <Button
        aria-label={swapLabel(line, hint)}
        aria-disabled={swap.busy || undefined}
        onClick={() => {
          if (!swap.busy) swap.swap(section, line);
        }}
        className="phone:w-full"
      >
        Swap
      </Button>
    </div>
  );
}
