import type { CollectionImportGroup } from "../collection_import_generated";
import { rowsText } from "./importText";

type Props = {
  /** The file's groups in file order, from the summary. */
  groups: CollectionImportGroup[];
  /** Untick a group to leave its rows out, tick it to bring them back. */
  onInclude: (group: CollectionImportGroup, include: boolean) => void;
};

const PANEL =
  "box-border flex flex-col gap-2 rounded-panel border border-border bg-surface p-4";

/** Collection Import's In this file panel (#232): the file's groups (portfolios, folders, lists), each with its rows and
 * a checkbox, all ticked at first. Unticking one leaves its rows out of the import; a group never becomes a Location.
 * Nothing shows for a file without groups. Each checkbox is named by its group and row count, and its label is the
 * 44 px tap area on a phone. */
export function ImportGroups({ groups, onInclude }: Props) {
  if (groups.length === 0) return null;
  return (
    <section aria-labelledby="import-groups-heading" className={PANEL}>
      <h2 id="import-groups-heading" className="m-0 text-heading font-semibold">
        In this file
      </h2>
      <ul className="m-0 flex list-none flex-col p-0">
        {groups.map((group) => (
          <li key={group.name}>
            <label className="flex min-h-(--target-pointer) cursor-pointer items-center gap-2 text-body phone:min-h-tap">
              <input
                type="checkbox"
                className="m-0 size-4 shrink-0 accent-accent"
                checked={group.included}
                onChange={(event) =>
                  onInclude(group, event.currentTarget.checked)
                }
              />
              <span className="min-w-0 flex-1 wrap-anywhere">{group.name}</span>
              <span className="shrink-0 text-meta text-text-muted tabular-nums">
                {rowsText(group.rows)}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p className="m-0 text-meta text-text-muted">
        Untick a group to leave its rows out.
      </p>
    </section>
  );
}
