/** Owner controls' sub-tabs (spec "Missing cards and Owner controls"), in order. Status lives at /owner and
 * every other section at /owner/<id>, so a section survives a reload and Back returns to the last one. */
export type OwnerSection =
  | "status"
  | "catalog"
  | "metadata"
  | "attributes"
  | "reprints"
  | "missing"
  | "trade-reports"
  | "rules";

export const OWNER_SECTIONS: readonly {
  id: OwnerSection;
  label: string;
  /** A review queue: its tab shows how many items wait. */
  queue: boolean;
}[] = [
  { id: "status", label: "Status", queue: false },
  { id: "catalog", label: "Catalog", queue: true },
  { id: "metadata", label: "Metadata", queue: true },
  { id: "attributes", label: "Attributes", queue: true },
  { id: "reprints", label: "Reprints", queue: true },
  { id: "missing", label: "Missing cards", queue: true },
  { id: "trade-reports", label: "Trade reports", queue: true },
  { id: "rules", label: "Rules", queue: false },
];

/** The sub-addresses under /owner (the shell's routes read them). */
export const OWNER_SUBPATHS: readonly string[] = OWNER_SECTIONS.filter(
  (section) => section.id !== "status"
).map((section) => section.id);

/** The section a sub-address opens: none (/owner itself) is Status. */
export function ownerSection(subpath: string | null): OwnerSection {
  return (
    OWNER_SECTIONS.find((section) => section.id === subpath)?.id ?? "status"
  );
}

export function ownerSectionPath(section: OwnerSection): string {
  return section === "status" ? "/owner" : `/owner/${section}`;
}
