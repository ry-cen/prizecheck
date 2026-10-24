import { createContext, useContext, type ReactNode } from "react";
import { proposalPath } from "./tradeListModel";
import { toProposalCard, type ProposalCard } from "./proposalModel";

/**
 * Opens a Friend's proposal builder (through the Handle redirect, #299) from outside the Trades tab (Trading #284): Ask to trade in Catalog's card popup,
 * which has no navigation of its own. `open(handle, card)` opens the builder with one copy of `card` in You get;
 * without a card it opens empty. Null outside the signed-in shell, where Ask to trade stays hidden.
 */
export const OpenProposalContext = createContext<
  ((handle: string, card?: ProposalCard) => void) | null
>(null);

// What the next builder opened for this collector starts with, and where the collector came from. The key is a trader
// id, or a Handle between Ask to trade's click and the redirect that swaps it for the trader id. They live only in
// memory, from the click until the builder mounts, so a reload never brings them back: that is why they are not in the
// address or in history.state, which survives a reload. The builder's page state initializer reads them once (the app
// has no StrictMode, which would run it twice and drop them).
let seed: { key: string; card: ProposalCard } | null = null;
let origin: { key: string; back: string } | null = null;

export function OpenProposalProvider({
  onNavigate,
  children,
}: {
  onNavigate: (to: string) => void;
  children: ReactNode;
}) {
  const open = (handle: string, card?: ProposalCard) => {
    seed = card ? { key: handle, card: toProposalCard(card) } : null;
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

/** Moves the seed and the origin noted under one key (a Handle) to another (the trader id the Handle resolved to). */
export function rekeyProposal(from: string, to: string): void {
  const same = (key: string) => key.toLowerCase() === from.toLowerCase();
  if (seed && same(seed.key)) seed = { ...seed, key: to };
  if (origin && same(origin.key)) origin = { ...origin, key: to };
}

/** Notes that the next builder for this collector is opened from a Trade List page, so its back link returns to `back`. */
export function proposeFromTradeList(key: string, back: string): void {
  origin = { key, back };
}

/** The card Ask to trade opened this collector's builder with, or null. Always clears the seed. */
export function takeProposalSeed(key: string): ProposalCard | null {
  const taken = seed;
  seed = null;
  return taken && taken.key.toLowerCase() === key.toLowerCase()
    ? taken.card
    : null;
}

/** The Trade List page this collector's builder was opened from, or null. Always clears the note. */
export function takeFromTradeList(key: string): string | null {
  const taken = origin;
  origin = null;
  return taken !== null && taken.key.toLowerCase() === key.toLowerCase()
    ? taken.back
    : null;
}
