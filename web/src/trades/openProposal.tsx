import { createContext, useContext, type ReactNode } from "react";
import { proposalPath } from "./tradeListModel";
import { toProposalCard, type ProposalCard } from "./proposalModel";

/**
 * Opens a Friend's proposal builder from outside the Trades tab (Trading #284): Ask to trade in Catalog's card popup,
 * which has no navigation of its own. `open(handle, card)` opens the builder with one copy of `card` in You get;
 * without a card it opens empty. Null outside the signed-in shell, where Ask to trade stays hidden.
 */
export const OpenProposalContext = createContext<
  ((handle: string, card?: ProposalCard) => void) | null
>(null);

// What the next builder opened for this Friend starts with, and where the collector came from. They live only in
// memory, from the click until the builder mounts, so a reload never brings them back: that is why they are not in the
// address or in history.state, which survives a reload. The builder's page state initializer reads them once (the app
// has no StrictMode, which would run it twice and drop them).
let seed: { handle: string; card: ProposalCard } | null = null;
let origin: { handle: string } | null = null;

export function OpenProposalProvider({
  onNavigate,
  children,
}: {
  onNavigate: (to: string) => void;
  children: ReactNode;
}) {
  const open = (handle: string, card?: ProposalCard) => {
    seed = card ? { handle, card: toProposalCard(card) } : null;
    origin = null;
    onNavigate(proposalPath(handle));
  };
  return (
    <OpenProposalContext.Provider value={open}>
      {children}
    </OpenProposalContext.Provider>
  );
}

export function useOpenProposal() {
  return useContext(OpenProposalContext);
}

/** Notes that the next builder for this Friend is opened from their Trade List page, so its back link returns there. */
export function proposeFromTradeList(handle: string): void {
  origin = { handle };
}

/** The card Ask to trade opened this Friend's builder with, or null. Always clears the seed. */
export function takeProposalSeed(handle: string): ProposalCard | null {
  const taken = seed;
  seed = null;
  return taken && taken.handle.toLowerCase() === handle.toLowerCase()
    ? taken.card
    : null;
}

/** Whether this Friend's builder was opened from their Trade List page. Always clears the note. */
export function takeFromTradeList(handle: string): boolean {
  const taken = origin;
  origin = null;
  return taken !== null && taken.handle.toLowerCase() === handle.toLowerCase();
}
