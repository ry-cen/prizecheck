import { useId } from "react";
import { Button } from "../ui/Button";

/** Each tracker's export steps, from the export research (#219). This is the only place the UI names a tracker. */
const STEPS: { tracker: string; steps: string }[] = [
  {
    tracker: "TCGplayer app",
    steps:
      "In the app's settings, set Email Export to CSV. Then open a list, tap ⋯ and choose Send via Email.",
  },
  {
    tracker: "Collectr",
    steps:
      "Pro members: on your Portfolio, tap ⋯ and choose Export. Collectr emails you one CSV of every portfolio.",
  },
  {
    tracker: "PriceCharting",
    steps:
      "In Settings, choose Export Collection. Upload the zip file it emails you as it is.",
  },
  {
    tracker: "TCG Collector",
    steps:
      "Premium members can export their collection as a CSV file from the TCG Collector website.",
  },
  {
    tracker: "Dragon Shield",
    steps: "Export a folder from the app as a CSV file.",
  },
  {
    tracker: "Sorted",
    steps: "Export your collection from the app as a CSV file.",
  },
  {
    tracker: "Another app",
    steps:
      "Export a CSV file with a column for each card's set, and its number or name.",
  },
];

type Props = {
  open: boolean;
  onToggle: () => void;
};

/** Collection Import's collapsed "How do I export from my tracker?" (#227). The steps render only while it's open. */
export function ExportHelp({ open, onToggle }: Props) {
  const panel = useId();
  return (
    <section className="flex flex-col gap-3">
      <div>
        <Button
          variant="quiet"
          aria-expanded={open}
          aria-controls={open ? panel : undefined}
          onClick={onToggle}
        >
          How do I export from my tracker?
        </Button>
      </div>
      {open && (
        <ul
          id={panel}
          aria-label="Export steps"
          className="m-0 flex list-none flex-col gap-3 p-0"
        >
          {STEPS.map(({ tracker, steps }) => (
            <li key={tracker} className="m-0 text-body">
              <span className="font-semibold">{tracker}</span>
              <span className="block text-text-muted">{steps}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
