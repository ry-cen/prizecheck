/** What the desktop inspector's report should do to the address. */
export function writesInspectorClear(state: {
  /** The report was caused by a scope change (a Location, search or filter change). */
  scopeChange: boolean;
  /** The card key the address names now. */
  addressCard: string | null;
  /** The card key the inspector last wrote to an address. */
  writtenCard: string | null;
  /** The history entry showing now, and the one this page last rendered for. */
  entry: string | null;
  renderedEntry: string | null;
}): boolean {
  if (!state.scopeChange) return true;
  // A scope change that arrives with another history entry is Back or Forward (or a new page): that entry's
  // address names its own card. The card key alone can't tell, because All owned and its Location show the same
  // Holding under the same key.
  return (
    state.entry === state.renderedEntry &&
    state.addressCard === state.writtenCard
  );
}
