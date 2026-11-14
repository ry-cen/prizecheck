import { useFlowGuard, useLoanRecovery, useDurableSend } from "./LoanRecovery";
import { PendingLoanNotice } from "./PendingLoanNotice";
import { refusalError, type FlowOutcome } from "./loanIntents";
import { threadIdOf } from "./loanAttempt";
import { RECOVERY_TEXT, resultText, signInAs } from "./loanText";
import { closeLoanRequest, PendingLoanRequest } from "./PendingLoanRequest";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { X } from "lucide-react";
import { getDecks, type DeckIndexEntry } from "../decks_generated";
import { useNoteLoansChanged } from "../inbox/Inbox";
import { CardImage } from "../social/FriendCollectionPage";
import {
  type SendBorrowRequest,
  SocialError,
  type FriendCopy,
  type LoanView,
} from "../social_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Select } from "../ui/Select";
import { endSentence } from "../social/sentenceEnd";
import { Stepper } from "../ui/Stepper";
import { TextField } from "../ui/TextField";
import { useLift, useToast } from "../ui/Toast";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import { cardCount, lineEdition, sendMessage, today } from "./loanText";
import { earlierFor, earlierText, useEarlierRequests } from "./earlierRequests";

/** The Friend a draft goes to. */
export type DraftFriend = {
  collector_id: string;
  display_name: string;
  handle: string | null;
};

/** A card a draft asks for: one Card Edition, with what the screens show of it. */
export type DraftCard = {
  edition_id: string;
  name: string;
  set_code: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
  image_url: string | null;
};

export type DraftLine = DraftCard & {
  quantity: number;
  /** The most the Friend could lend when it was asked (spare and in-a-Deck copies), or null when not known (a line
   * an Edit and resend brought back). The API caps it again on send. */
  cap: number | null;
  /** "2 spare · 1 in a Deck", or "" when not known. */
  lendable: string;
  /** The one Deck that needs this card where it was asked for (a Deck's page or section, a card only one Deck needs),
   * or null when no one Deck does (several Decks, or a page that is about none). */
  deck: string | null;
};

export type Draft = {
  friend: DraftFriend;
  lines: DraftLine[];
  /** The borrower's Deck the cards go to; null is Unsorted. */
  deckId: string | null;
  /** True once the collector picked For Deck (a Deck, or No Deck): never changed automatically after that. While false,
   * `deckId` follows the cards (`automaticDeck`). */
  deckChosen: boolean;
  /** "YYYY-MM-DD", or "" for none. */
  returnBy: string;
  /** The unanswered request this one replaces (Edit and resend), or null. */
  replaces: string | null;
};

/** The Deck a draft with no manual choice goes For: the one Deck every card independently names, else none. */
export function automaticDeck(lines: Pick<DraftLine, "deck">[]): string | null {
  const first = lines[0]?.deck ?? null;
  return first !== null && lines.every((line) => line.deck === first)
    ? first
    : null;
}

/** The draft with For Deck following its cards, unless the collector chose it. */
export function withAutomaticDeck(draft: Draft): Draft {
  if (draft.deckChosen) return draft;
  const deckId = automaticDeck(draft.lines);
  return deckId === draft.deckId ? draft : { ...draft, deckId };
}

type BorrowReadiness = boolean | "failed";

type DraftsApi = {
  drafts: Draft[];
  checkReadiness: (
    source: symbol,
    deckId: string | null,
    current: BorrowReadiness | null,
    retry?: () => void
  ) => void;
  /** Copies of one Edition in the draft to one Friend. */
  quantity: (friendId: string, editionId: string) => number;
  /** Sets a line: 0 takes it out, and a draft with no lines goes. `deckId` is the card's one Deck where it was asked
   * for (a Deck's page or section, a card only one Deck needs), or null. Until the collector picks For Deck, the draft
   * is For the Deck every card names, else none, recomputed whenever its cards change; a pick is never overwritten. */
  set: (
    friend: DraftFriend,
    card: DraftCard,
    quantity: number,
    cap: number | null,
    lendable: string,
    deckId?: string | null
  ) => void;
  /** Opens the composer on the draft to one Friend. */
  review: (friendId: string, opener?: HTMLElement | null) => void;
};

const DraftsContext = createContext<DraftsApi | null>(null);

/** The drafts, or null outside the signed-in shell (the slots then draw nothing). */
export function useBorrowDrafts(): DraftsApi | null {
  return useContext(DraftsContext);
}

/** A mounted Want List read blocks sending its scoped drafts until quantities are current. `retry` runs the read
 * again, so the composer can offer Retry while the page's own Retry is hidden behind it. */
export function useBorrowReadiness(
  deckId: string | null,
  current: BorrowReadiness | null,
  retry?: () => void
) {
  const register = useBorrowDrafts()?.checkReadiness;
  const source = useRef(Symbol());
  const latest = useRef(retry);
  latest.current = retry;
  const again = useCallback(() => latest.current?.(), []);
  useLayoutEffect(() => {
    register?.(source.current, deckId, current, again);
    return () => register?.(source.current, deckId, null);
  }, [register, deckId, current, again]);
}

const STORAGE_PREFIX = "prizecheck.borrowDrafts.";

/** The account's drafts kept in this tab (sessionStorage), so a reload keeps them; anything unreadable is dropped. */
function readDrafts(userId: string): Draft[] {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(STORAGE_PREFIX + userId) ?? "[]"
    ) as unknown;
    if (!Array.isArray(value)) return [];
    const found = value.filter(
      (draft): draft is Draft =>
        typeof draft?.friend?.collector_id === "string" &&
        typeof draft?.friend?.display_name === "string" &&
        Array.isArray(draft?.lines) &&
        draft.lines.length > 0 &&
        draft.lines.every(
          (line: DraftLine) =>
            typeof line?.edition_id === "string" &&
            typeof line?.name === "string" &&
            Number.isInteger(line?.quantity) &&
            line.quantity > 0
        )
    );
    // A Deck is a string or none. A draft kept without the flag, or one that edits a sent request (`replaces`), keeps the
    // Deck it has as the collector's choice; its lines' own Decks, if missing, are that Deck.
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return found.map((draft) => {
      const deckId = text(draft.deckId);
      return {
        ...draft,
        deckId,
        deckChosen:
          draft.deckChosen === true ||
          !!draft.replaces ||
          typeof draft.deckChosen !== "boolean",
        lines: draft.lines.map((line) => ({
          ...line,
          deck: line.deck === undefined ? deckId : text(line.deck),
        })),
      };
    });
  } catch {
    return [];
  }
}

/** Forgets every account's drafts kept in this tab: signing out leaves none behind for the next account. */
export function forgetBorrowDrafts() {
  try {
    const keys = Array.from(
      { length: window.sessionStorage.length },
      (_, index) => window.sessionStorage.key(index)
    );
    for (const key of keys)
      if (key?.startsWith(STORAGE_PREFIX))
        window.sessionStorage.removeItem(key);
  } catch {
    // Storage off: nothing was kept.
  }
}

/** Focuses the shown page's h1 when focus has fallen to the page (the body, or nothing, holds it), as the shell's
 * skip link does. */
function focusPageHeading() {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const heading = document
    .getElementById("main-content")
    ?.querySelector<HTMLElement>("h1");
  if (!heading) return;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

function writeDrafts(userId: string, drafts: Draft[]) {
  try {
    if (drafts.length === 0)
      window.sessionStorage.removeItem(STORAGE_PREFIX + userId);
    else
      window.sessionStorage.setItem(
        STORAGE_PREFIX + userId,
        JSON.stringify(drafts)
      );
  } catch {
    // Storage full or off: the drafts still live for this page.
  }
}

/** A Friend copy as the card a draft asks for. */
export function copyCard(copy: FriendCopy, imageUrl: string | null): DraftCard {
  return {
    edition_id: copy.edition_id,
    name: copy.name,
    set_code: copy.set_code,
    collector_number: copy.collector_number,
    descriptor: copy.descriptor,
    image_url: imageUrl,
  };
}

/** The cap a line is stored with. `cap` is what the page offers after your own pending requests, `limit` is what the
 * Friend could really lend. Your own requests may stop a stepper going up but never leave a line over its cap: only the
 * Friend's availability can. */
export function lineCap(cap: number, quantity: number, limit: number): number {
  return Math.max(cap, Math.min(quantity, limit));
}

/** What a Friend could lend of a copy, as a number: its spare and in-a-Deck copies. */
export function copyCap(copy: { spare: string; in_deck: string }): number {
  return Number(copy.spare) + Number(copy.in_deck);
}

/**
 * Draft Borrow Requests (social network #252, the Friends' cards verdict): client-only, one per Friend, kept in this
 * tab's sessionStorage under the account id. **Ask** anywhere (a Want List chip or panel, the card popup, a Friend's
 * Collection) adds to that Friend's draft; Each card carries the one Deck it was asked for (a page about one Deck, a
 * Deck's section on All Decks, a Get from Friends card only one Deck needs), or none. Until the collector picks For
 * Deck in the composer, the draft is For the Deck every card names, else No Deck, recomputed as cards come and go; a
 * pick, even No Deck, is kept. The tray lists
 * the drafts with **Review**, which opens the composer: a stepper per line capped at what the Friend could lend, **For
 * Deck** (or none: Unsorted), an optional **Return by** and **Send Borrow Request**. On a phone the tray is one bar
 * above the tab bar; with several drafts its **Review** lists them first. When the composer closes and the control that
 * opened it went with it (the tray's Review, once the last draft is sent or discarded), focus goes to the page's h1; a
 * sent request's toast then takes it for View.
 */
export function BorrowDraftsProvider({
  userId,
  onOpenLoan,
  children,
}: {
  userId: string;
  /** Opens a Loan's screen (/loans/<id>), from the sent toast's View. */
  onOpenLoan: (id: string) => void;
  children: ReactNode;
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => readDrafts(userId));
  const [composing, setComposing] = useState<string | null>(null);
  const [checks, setChecks] = useState(
    new Map<
      symbol,
      { deckId: string | null; current: BorrowReadiness; retry?: () => void }
    >()
  );
  const checkReadiness = useCallback(
    (
      source: symbol,
      deckId: string | null,
      current: BorrowReadiness | null,
      retry?: () => void
    ) => {
      setChecks((previous) => {
        const next = new Map(previous);
        if (current === null) next.delete(source);
        else next.set(source, { deckId, current, retry });
        return next;
      });
    },
    []
  );

  const opener = useRef<HTMLElement | null>(null);
  const { store } = useLoanRecovery();
  const guard = useFlowGuard();
  const toast = useToast();

  useEffect(() => writeDrafts(userId, drafts), [userId, drafts]);

  const change = useCallback(
    (
      friendId: string,
      update: (draft: Draft | undefined) => Draft | null,
      friendName?: string
    ) => {
      if (store.blockerFor("borrow_request:" + friendId)) {
        const tok = guard.capture();
        const name =
          friendName ??
          drafts.find((d) => d.friend.collector_id === friendId)?.friend
            .display_name ??
          "";
        if (guard.live(tok))
          toast.show({
            message: RECOVERY_TEXT.blockedDraft.replace("{name}", name),
          });
        return;
      }
      setDrafts((current) => {
        const index = current.findIndex(
          (draft) => draft.friend.collector_id === friendId
        );
        const next = update(index < 0 ? undefined : current[index]);
        if (index < 0) return next ? [...current, next] : current;
        return next
          ? current.map((draft, at) => (at === index ? next : draft))
          : current.filter((_, at) => at !== index);
      });
    },
    [store, drafts, toast]
  );

  const api = useMemo<DraftsApi>(
    () => ({
      drafts,
      checkReadiness,
      quantity: (friendId, editionId) =>
        drafts
          .find((draft) => draft.friend.collector_id === friendId)
          ?.lines.find((line) => line.edition_id === editionId)?.quantity ?? 0,
      set: (friend, card, quantity, cap, lendable, deckId) =>
        change(
          friend.collector_id,
          (draft) => {
            const base: Draft = draft ?? {
              friend,
              lines: [],
              deckId: null,
              deckChosen: false,
              returnBy: "",
              replaces: null,
            };
            const others = base.lines.filter(
              (line) => line.edition_id !== card.edition_id
            );
            const existing = base.lines.find(
              (line) => line.edition_id === card.edition_id
            );
            const lines =
              quantity <= 0
                ? others
                : existing
                  ? base.lines.map((line) =>
                      line === existing
                        ? { ...line, quantity, cap: cap ?? line.cap, lendable }
                        : line
                    )
                  : [
                      ...base.lines,
                      {
                        edition_id: card.edition_id,
                        name: card.name,
                        set_code: card.set_code,
                        collector_number: card.collector_number,
                        descriptor: card.descriptor,
                        image_url: card.image_url,
                        quantity,
                        cap,
                        lendable,
                        deck: deckId ?? null,
                      },
                    ];
            // Only the Friend's id and names are kept, whatever object named them (a Friend copy, a Friend's page).
            const named: DraftFriend = {
              collector_id: friend.collector_id,
              display_name: friend.display_name,
              handle: friend.handle,
            };
            return lines.length
              ? withAutomaticDeck({ ...base, friend: named, lines })
              : null;
          },
          friend.display_name
        ),
      review: (friendId, from) => {
        opener.current = from ?? null;
        setComposing(friendId);
      },
    }),
    [drafts, change, checkReadiness]
  );

  const draft = drafts.find((item) => item.friend.collector_id === composing);
  // A draft that empties while its composer is open (its last line removed, or refused as not lendable) closes the
  // composer for good, so asking that Friend again doesn't reopen it.
  useEffect(() => {
    if (composing !== null && !draft) setComposing(null);
  }, [composing, draft]);
  // After the composer's Dialog has given focus back to its opener: if the opener is gone, the page's h1 takes it.
  // This runs before the toast host's own effect, so a toast that asks for focus still gets it.
  const composerOpen = draft !== undefined;
  const wasOpen = useRef(composerOpen);
  useLayoutEffect(() => {
    if (wasOpen.current && !composerOpen) focusPageHeading();
    wasOpen.current = composerOpen;
  }, [composerOpen]);
  return (
    <DraftsContext.Provider value={api}>
      {children}
      <BorrowTray drafts={drafts} onReview={api.review} />
      {draft && (
        <BorrowComposer
          key={draft.friend.collector_id}
          draft={draft}
          current={Array.from(checks.values()).every(
            (check) =>
              (check.deckId !== null && check.deckId !== draft.deckId) ||
              check.current === true
          )}
          onRetry={() => {
            for (const check of checks.values())
              if (
                (check.deckId === null || check.deckId === draft.deckId) &&
                check.current === "failed"
              )
                check.retry?.();
          }}
          failed={Array.from(checks.values()).some(
            (check) =>
              (check.deckId === null || check.deckId === draft.deckId) &&
              check.current === "failed"
          )}
          onChange={(update) => change(draft.friend.collector_id, update)}
          onClose={() => setComposing(null)}
          onOpenLoan={onOpenLoan}
          returnFocus={opener}
        />
      )}
    </DraftsContext.Provider>
  );
}

const BAR =
  "box-border flex min-w-0 items-center gap-3 rounded-panel border border-accent-border bg-surface-raised px-3 py-2";

/** One draft's bar: who it goes to, how many cards, and Review. */
function DraftBar({
  draft,
  onReview,
}: {
  draft: Draft;
  onReview: (friendId: string, opener: HTMLElement | null) => void;
}) {
  const copies = draft.lines.reduce((total, line) => total + line.quantity, 0);
  const name = draft.friend.display_name;
  return (
    <div className={BAR}>
      <p className="m-0 min-w-0 flex-1 text-meta">
        <span className="block font-semibold text-text wrap-anywhere">
          Borrow Request to {name}
        </span>
        <span className="block text-text-muted">{cardCount(copies)}</span>
      </p>
      <Button
        variant="primary"
        aria-label={`Review Borrow Request to ${name}`}
        onClick={(event) =>
          onReview(draft.friend.collector_id, event.currentTarget)
        }
      >
        Review
      </Button>
    </div>
  );
}

/**
 * The drafts tray: fixed over the page's bottom right on desktop, one bar per draft; on a phone one bar above the tab
 * bar, which names the one draft or counts several (its Review lists them). It sits above Collection's Actions strip
 * while one is up (the strip's lift), and raises the toast by its own height (setLift), so the three stack: strip, tray,
 * toast. A spacer of the tray's height after the page lets its last lines scroll clear of it.
 */
function BorrowTray({
  drafts,
  onReview,
}: {
  drafts: Draft[];
  onReview: (friendId: string, opener?: HTMLElement | null) => void;
}) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const toast = useToast();
  const strip = useLift("selection");
  const tray = useRef<HTMLElement>(null);
  const listOpener = useRef<HTMLButtonElement>(null);
  const [listing, setListing] = useState(false);
  const [height, setHeight] = useState(0);
  const { intents } = useLoanRecovery();
  const guard = useFlowGuard();
  const noteLoansChanged = useNoteLoansChanged();
  const orphaned = intents.filter(
    (v) =>
      (v.scope === "*" || v.scope.startsWith("borrow_request:")) &&
      !drafts.some((d) => v.scope === "borrow_request:" + d.friend.collector_id)
  );
  const shown = drafts.length > 0 || orphaned.length > 0;
  function recovered(o: FlowOutcome) {
    const tok = guard.capture();
    if (!guard.live(tok)) return;
    if (o.kind === "done" || o.kind === "voided") noteLoansChanged();
    const message = resultText(o);
    if (message) toast.show({ message });
  }

  useLayoutEffect(() => {
    const element = tray.current;
    if (!element) {
      setHeight(0);
      return;
    }
    // The toast stacks above the tray, with the same gap as between the tray and what is under it.
    const measure = () => {
      const box = element.getBoundingClientRect().height;
      const gap = parseFloat(
        getComputedStyle(element).getPropertyValue("--space-2")
      );
      setHeight(box);
      toast.setLift("drafts", box + (gap || 8));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      toast.setLift("drafts", 0);
    };
  }, [shown, phone, toast]);
  useEffect(() => {
    if (drafts.length < 2) setListing(false);
  }, [drafts.length]);

  if (!shown) return null;
  const copies = drafts.reduce(
    (total, draft) =>
      total + draft.lines.reduce((sum, line) => sum + line.quantity, 0),
    0
  );
  return (
    <>
      <div aria-hidden="true" style={{ height: height + 24 }} />
      <section
        ref={tray}
        aria-label="Borrow Request drafts"
        style={{ "--tray-lift": `${strip}px` } as CSSProperties}
        className={
          phone
            ? "fixed inset-x-3 bottom-[calc(var(--spacing-tabbar)+var(--space-2)+var(--tray-lift))] z-(--layer-sticky) flex flex-col"
            : "fixed bottom-[calc(var(--space-6)+var(--tray-lift))] right-6 z-(--layer-sticky) flex w-80 flex-col gap-2"
        }
      >
        {orphaned.map((view) => (
          <PendingLoanNotice
            key={view.operationId}
            view={view}
            onOutcome={recovered}
          />
        ))}
        {phone && drafts.length > 1 ? (
          <div className={BAR}>
            <p className="m-0 min-w-0 flex-1 text-meta">
              <span className="block font-semibold text-text">
                Borrow Requests to {drafts.length} Friends
              </span>
              <span className="block text-text-muted">{cardCount(copies)}</span>
            </p>
            <Button
              ref={listOpener}
              variant="primary"
              aria-label="Review Borrow Requests"
              aria-haspopup="dialog"
              onClick={() => setListing(true)}
            >
              Review
            </Button>
          </div>
        ) : (
          drafts.map((draft) => (
            <DraftBar
              key={draft.friend.collector_id}
              draft={draft}
              onReview={onReview}
            />
          ))
        )}
      </section>
      <Dialog
        open={listing}
        onClose={() => setListing(false)}
        title="Borrow Requests"
        closeLabel="Close Borrow Requests"
        returnFocus={listOpener}
      >
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {drafts.map((draft) => (
            <li key={draft.friend.collector_id}>
              <DraftBar
                draft={draft}
                onReview={(friendId) => {
                  setListing(false);
                  onReview(friendId, listOpener.current);
                }}
              />
            </li>
          ))}
        </ul>
      </Dialog>
    </>
  );
}

type DecksLoad =
  | { kind: "loading" }
  | { kind: "ready"; decks: DeckIndexEntry[] }
  | { kind: "failed" };

/** Every Deck of the collector's, for For Deck: the index read page by page. */
export async function readDecks(): Promise<DeckIndexEntry[]> {
  const found: DeckIndexEntry[] = [];
  let cursor: string | undefined;
  for (;;) {
    const index = await getDecks(cursor);
    found.push(...index.decks.filter((deck) => deck.kind === "deck"));
    if (!index.next_cursor) return found;
    cursor = index.next_cursor;
  }
}

/** The composer: the draft's lines with steppers, For Deck, Return by, and Send Borrow Request. */
function BorrowComposer({
  draft,
  current,
  failed,
  onRetry,
  onChange,
  onClose,
  onOpenLoan,
  returnFocus,
}: {
  draft: Draft;
  current: boolean;
  failed: boolean;
  onRetry: () => void;
  onChange: (update: (draft: Draft | undefined) => Draft | null) => void;
  onClose: () => void;
  onOpenLoan: (id: string) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const toast = useToast();
  // A sent request is a Loan changed outside the Loans tab: a Deck's pending requests read again.
  const noteLoansChanged = useNoteLoansChanged();
  const [decks, setDecks] = useState<DecksLoad>({ kind: "loading" });
  const earlier = useEarlierRequests();
  const warnId = useId();
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const name = draft.friend.display_name;
  const durable = useDurableSend();
  const fence = durable.fence;
  const { blockerFor, accountName } = useLoanRecovery();
  const guard = useFlowGuard();
  const scope = "borrow_request:" + draft.friend.collector_id;
  const blocker = blockerFor(scope);
  const frozen = busy || fence.pending || !!blocker;
  const quantitiesValid = draft.lines.every(
    (line) => line.cap === null || line.quantity <= line.cap
  );
  const form = useRef<HTMLDivElement>(null);
  const intro = useRef<HTMLParagraphElement>(null);
  const close = () =>
    closeLoanRequest(form.current, fence.command.current !== null, onClose);

  useEffect(() => {
    let live = true;
    readDecks().then(
      (found) => live && setDecks({ kind: "ready", decks: found }),
      () => live && setDecks({ kind: "failed" })
    );
    return () => {
      live = false;
    };
  }, [attempt]);

  function edit(update: (current: Draft) => Draft | null) {
    if (frozen || fence.command.current) return;
    setMessage("");
    onChange((current) => (current ? update(current) : null));
  }
  // Where an earlier request went: its Deck's name, Unsorted, or nothing when the Deck's name isn't known.
  const place = (deckId: string | null) =>
    deckId === null
      ? "Unsorted"
      : decks.kind === "ready"
        ? (decks.decks.find((deck) => deck.id === deckId)?.name ?? null)
        : null;
  const before = (editionId: string) =>
    draft.replaces
      ? []
      : earlierFor(earlier.lines, draft.friend.collector_id, editionId);
  const again = draft.lines.some((line) => before(line.edition_id).length > 0);
  const cardName = (editionId: string) =>
    draft.lines.find((line) => line.edition_id === editionId)?.name ?? "a card";

  function refused(cause: unknown) {
    const error = cause instanceof SocialError ? cause : null;
    if (error?.code === "NOT_LENDABLE") {
      const editionId = String(error.detail.edition_id ?? "");
      const available = Number(error.detail.available ?? 0);
      // Nothing left to ask for: the draft goes with the composer, so the refusal is said in a toast.
      if (
        available <= 0 &&
        draft.lines.every((line) => line.edition_id === editionId)
      ) {
        onChange(() => null);
        onClose();
        toast.show({
          message: sendMessage(cause, name, cardName),
          focus: true,
        });
        return;
      }
      onChange((current) => {
        if (!current) return null;
        const lines = current.lines.flatMap((line) =>
          line.edition_id !== editionId
            ? [line]
            : available > 0
              ? [
                  {
                    ...line,
                    cap: available,
                    quantity: Math.min(line.quantity, available),
                  },
                ]
              : []
        );
        return lines.length ? withAutomaticDeck({ ...current, lines }) : null;
      });
    } else if (error?.code === "DECK_NOT_FOUND") {
      onChange((current) =>
        current
          ? {
              ...current,
              deckId: null,
              deckChosen: true,
              // The Deck is gone: its lines no longer name it.
              lines: current.lines.map((line) =>
                line.deck === current.deckId ? { ...line, deck: null } : line
              ),
            }
          : null
      );
      setAttempt((n) => n + 1);
    }
    setMessage(sendMessage(cause, name, cardName));
  }
  function outcome(o: FlowOutcome, recovered = false) {
    if (o.kind === "done" || o.kind === "voided") noteLoansChanged();
    if (o.kind === "done") {
      const id = threadIdOf(o.response);
      onChange(() => null);
      onClose();
      toast.show({
        message: recovered
          ? RECOVERY_TEXT.done
          : `Borrow Request sent to ${endSentence(name)}`,
        ...(id
          ? { action: { label: "View", onAction: () => onOpenLoan(id) } }
          : {}),
        focus: true,
      });
    } else if (o.kind === "voided" && o.refusal)
      refused(refusalError(o.refusal));
    else if (o.kind === "pending" && o.refusal)
      setMessage(sendMessage(refusalError(o.refusal), name, cardName));
    else
      setMessage(
        o.kind === "wrong_account"
          ? signInAs(accountName)
          : (resultText(o) ?? "")
      );
  }
  async function send() {
    if (
      !current ||
      !quantitiesValid ||
      draft.replaces ||
      frozen ||
      fence.command.current
    )
      return;
    const tok = guard.capture();
    const fields = {
      lender_id: draft.friend.collector_id,
      lines: draft.lines.map((line) => ({
        edition_id: line.edition_id,
        quantity: String(line.quantity),
      })),
      deck_id: draft.deckId,
      return_by: draft.returnBy || null,
    } satisfies Omit<SendBorrowRequest, "account_id" | "idempotency_key">;
    setBusy(true);
    setMessage("");
    const o = await durable.send({
      kind: "borrow_request",
      scope,
      path: "/api/loans",
      fields,
    });
    if (!guard.live(tok)) return;
    setBusy(false);
    if (o) outcome(o);
  }

  return (
    <Dialog
      open
      onClose={close}
      title={`Borrow Request to ${name}`}
      closeLabel="Close Borrow Request"
      returnFocus={returnFocus}
    >
      <div ref={form} className="flex flex-col gap-4">
        <p
          ref={intro}
          tabIndex={-1}
          className="m-0 text-meta text-text-muted outline-none"
        >
          {name} can accept all of it, part of it, or decline.
        </p>
        <fieldset disabled={frozen} className="contents">
          <ul
            aria-label="Cards to borrow"
            className="m-0 flex list-none flex-col gap-3 p-0"
          >
            {draft.lines.map((line) => {
              const edition = lineEdition(line);
              return (
                <li
                  key={line.edition_id}
                  className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 phone:grid-cols-[3rem_minmax(0,1fr)]"
                >
                  <CardImage url={line.image_url} />
                  <div className="min-w-0">
                    <p className="m-0 text-body font-medium wrap-anywhere">
                      {line.name}
                    </p>
                    <p className="m-0 text-meta text-text-muted wrap-anywhere">
                      {edition}
                      {line.lendable && ` · ${line.lendable}`}
                    </p>
                    {before(line.edition_id).map((ask, index) => (
                      <p
                        key={index}
                        className="m-0 text-meta text-warning wrap-anywhere"
                      >
                        {earlierText(ask, place(ask.deck_id))}
                      </p>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 phone:col-start-2">
                    <Stepper
                      label={`Copies of ${line.name}, ${edition}`}
                      value={line.quantity}
                      min={1}
                      max={line.cap ?? undefined}
                      onChange={(quantity) =>
                        edit((current) => ({
                          ...current,
                          lines: current.lines.map((item) =>
                            item.edition_id === line.edition_id
                              ? { ...item, quantity }
                              : item
                          ),
                        }))
                      }
                    />
                    <Button
                      variant="quiet"
                      icon={X}
                      label={`Remove ${line.name}, ${edition}`}
                      onClick={() =>
                        edit((current) => {
                          const lines = current.lines.filter(
                            (item) => item.edition_id !== line.edition_id
                          );
                          return lines.length
                            ? withAutomaticDeck({ ...current, lines })
                            : null;
                        })
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          <Select
            label="For Deck"
            value={draft.deckId ?? ""}
            onChange={(event) =>
              edit((current) => ({
                ...current,
                deckId: event.target.value || null,
                deckChosen: true,
              }))
            }
          >
            <option value="">No Deck (they go to Unsorted)</option>
            {decks.kind === "ready" &&
              decks.decks.map((deck) => (
                <option key={deck.id} value={deck.id}>
                  {deck.name}
                </option>
              ))}
            {decks.kind !== "ready" && draft.deckId && (
              <option value={draft.deckId}>The Deck you chose</option>
            )}
          </Select>
          {earlier.state === "failed" && !draft.replaces && (
            <p className="m-0 text-meta text-text-muted">
              Couldn't check what you've already asked {name} for.{" "}
              <button
                type="button"
                aria-label="Retry checking earlier requests"
                onClick={earlier.retry}
                className="cursor-pointer border-0 bg-transparent p-0 font-sans text-meta text-accent-strong underline"
              >
                Retry
              </button>
            </p>
          )}
          {decks.kind === "failed" && (
            <p className="m-0 text-meta text-text-muted">
              Your Decks couldn't be loaded.{" "}
              <button
                type="button"
                onClick={() => setAttempt((n) => n + 1)}
                className="cursor-pointer border-0 bg-transparent p-0 font-sans text-meta text-accent-strong underline"
              >
                Retry
              </button>
            </p>
          )}
          <TextField
            type="date"
            label="Return by (optional)"
            min={today()}
            value={draft.returnBy}
            onChange={(event) =>
              edit((current) => ({ ...current, returnBy: event.target.value }))
            }
          />
        </fieldset>
        {fence.pending && (
          <PendingLoanRequest
            boundaryRef={fence.boundary}
            busy
            onRetry={() => {}}
          />
        )}
        {blocker && !busy && (
          <PendingLoanNotice
            view={blocker}
            autoFocus
            onOutcome={(o) => outcome(o, true)}
          />
        )}

        {again && (
          <p id={warnId} className="m-0 text-meta text-warning">
            Some of these cards are already asked for. Sending asks {name}{" "}
            again.
          </p>
        )}
        <p role="alert" className="m-0 text-meta text-danger empty:hidden">
          {message}
        </p>
        {!current && (
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="m-0 text-meta text-text-muted">
              {failed
                ? "Couldn't check what's available."
                : "Checking what's available…"}
            </p>
            {failed && (
              <Button
                variant="quiet"
                onClick={(event) => {
                  const held = event.currentTarget;
                  onRetry();
                  // Keep the collector's place when the check starting again removes the Retry they hold.
                  if (document.activeElement === held) intro.current?.focus();
                }}
              >
                Retry
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            disabled={busy || !!blocker}
            onClick={() => {
              if (frozen || fence.command.current) return;
              onChange(() => null);
              onClose();
            }}
          >
            Discard
          </Button>
          <Button onClick={close}>Keep draft</Button>
          {draft.replaces && (
            <>
              <p>
                This edit was started before an update. Open the Borrow Request
                to edit it again.
              </p>
              <Button
                onClick={() =>
                  closeLoanRequest(
                    form.current,
                    fence.command.current !== null,
                    () => {
                      onClose();
                      onOpenLoan(draft.replaces!);
                    }
                  )
                }
              >
                View
              </Button>
            </>
          )}
          <Button
            variant="primary"
            aria-describedby={again ? warnId : undefined}
            disabled={
              !current || !quantitiesValid || frozen || !!draft.replaces
            }
            onClick={() => void send()}
          >
            Send Borrow Request
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Only a known, current cap may reconcile a draft; another Deck's draft keeps its own scope. */
function useDraftCap(
  friend: DraftFriend,
  card: DraftCard,
  cap: number,
  limit: number,
  lendable: string,
  deckId: string | null,
  current: boolean
) {
  const drafts = useBorrowDrafts();
  useEffect(() => {
    if (!drafts || !current || cap < 0) return;
    const draft = drafts.drafts.find(
      (item) =>
        item.friend.collector_id === friend.collector_id &&
        item.deckId === deckId
    );
    if (!draft || draft.replaces) return;
    const line = draft.lines.find(
      (item) => item.edition_id === card.edition_id
    );
    if (!line) return;
    const quantity = limit > 0 ? Math.min(line.quantity, limit) : line.quantity;
    // Coverage (your own requests) may stop the stepper going up, never make the line unsendable; only the Friend's
    // availability lowers it, and none left blocks sending but keeps the line for explicit removal.
    const nextCap = lineCap(cap, quantity, limit);
    if (
      line.cap !== nextCap ||
      line.quantity !== quantity ||
      line.lendable !== lendable
    )
      drafts.set(friend, card, quantity, nextCap, lendable, deckId);
  }, [drafts, friend, card, cap, limit, lendable, deckId, current]);
}

/**
 * **Ask** (Get from Friends) or **Ask to borrow** (the card popup, a Friend's Collection): adds one copy to the
 * Friend's draft, then turns into a stepper up to what the Friend could lend; stepping to 0 takes the line out.
 */
export function AskControl({
  friend,
  card,
  cap,
  limit = cap,
  lendable,
  text = "Ask",
  deckId = null,
  initialQuantity = 1,
  more = false,
  current = true,
}: {
  initialQuantity?: number;
  more?: boolean;
  current?: boolean;
  friend: DraftFriend;
  card: DraftCard;
  cap: number;
  /** What the Friend could really lend; `cap` less your own pending requests. Defaults to `cap`. */
  limit?: number;
  lendable: string;
  text?: "Ask" | "Ask to borrow";
  /** The Deck this starts the Friend's draft For (a page about one Deck, or a section's Deck on All Decks); null for none. */
  deckId?: string | null;
}) {
  const drafts = useBorrowDrafts();
  useDraftCap(friend, card, cap, limit, lendable, deckId, current);
  const ask = useRef<HTMLButtonElement>(null);
  const group = useRef<HTMLSpanElement>(null);
  const quantity = drafts?.quantity(friend.collector_id, card.edition_id) ?? 0;
  const previous = useRef(quantity);
  // Set by this control's own Ask or stepper, so focus follows only its own change: never a draft changed elsewhere
  // (sent, discarded, edited in the composer), whose own focus move would be undone.
  const pressed = useRef(false);
  // Focus follows the control that replaced the one pressed: the stepper after Ask, Ask after stepping to 0.
  useEffect(() => {
    if (pressed.current && previous.current === 0 && quantity > 0)
      group.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
    if (pressed.current && previous.current > 0 && quantity === 0)
      ask.current?.focus();
    pressed.current = false;
    previous.current = quantity;
  }, [quantity]);
  if (!drafts || (cap < 1 && quantity === 0)) return null;
  const name =
    text === "Ask"
      ? `Ask ${friend.display_name} for ${card.name}`
      : `Ask to borrow ${card.name} from ${friend.display_name}`;
  if (quantity === 0)
    return (
      <Button
        ref={ask}
        aria-label={name}
        aria-disabled={!current}
        className="aria-disabled:opacity-45"
        onClick={() => {
          if (!current) return;
          pressed.current = true;
          drafts.set(
            friend,
            card,
            Math.min(initialQuantity, cap),
            cap,
            lendable,
            deckId
          );
        }}
      >
        {more ? `Ask for ${initialQuantity} more` : text}
      </Button>
    );
  return (
    <span ref={group} className="inline-flex">
      <Stepper
        label={`Copies of ${card.name} to ask ${friend.display_name} for`}
        value={quantity}
        min={0}
        max={current ? cap : quantity}
        onChange={(next) => {
          pressed.current = true;
          drafts.set(
            friend,
            card,
            next,
            lineCap(cap, next, limit),
            lendable,
            deckId
          );
        }}
      />
    </span>
  );
}

/**
 * A Want List line's Friend chip as the control that asks (the Friends' cards verdict): pressing it puts one copy in
 * that Friend's draft and ticks it; pressing it again takes the line out.
 */
export function AskChip({
  friend,
  card,
  cap,
  limit = cap,
  lendable,
  text,
  deckId = null,
  initialQuantity = 1,
  more = false,
  current = true,
}: {
  initialQuantity?: number;
  more?: boolean;
  current?: boolean;
  friend: DraftFriend;
  card: DraftCard;
  cap: number;
  /** What the Friend could really lend; `cap` less your own pending requests. Defaults to `cap`. */
  limit?: number;
  lendable: string;
  text: string;
  /** The Deck this starts the Friend's draft For (a page about one Deck, or a section's Deck on All Decks); null for none. */
  deckId?: string | null;
}) {
  const drafts = useBorrowDrafts();
  useDraftCap(friend, card, cap, limit, lendable, deckId, current);
  const quantity = drafts?.quantity(friend.collector_id, card.edition_id) ?? 0;
  const asked = quantity > 0;
  if (cap < 1 && !asked) return null;
  if (!drafts)
    return (
      <span className="inline-flex min-h-chip items-center rounded-round border border-border-strong px-2.5 text-meta text-text-muted wrap-anywhere">
        {text}
      </span>
    );
  return (
    <button
      type="button"
      aria-pressed={asked}
      aria-disabled={!current && !asked}
      title={
        asked
          ? `${cardCount(quantity)} in your Borrow Request to ${friend.display_name}`
          : `Ask ${friend.display_name} to lend ${cardCount(initialQuantity)}`
      }
      onClick={() => {
        if (!current && !asked) return;
        drafts.set(
          friend,
          card,
          asked ? 0 : Math.min(initialQuantity, cap),
          cap,
          lendable,
          deckId
        );
      }}
      className="group aria-disabled:cursor-default aria-disabled:opacity-45 m-0 box-border inline-flex min-h-chip max-w-full cursor-pointer items-center border-0 bg-transparent p-0 text-left font-sans phone:min-h-tap"
    >
      <span className="box-border inline-flex min-h-chip max-w-full items-center gap-1 rounded-round border border-border-strong px-2.5 text-meta text-text-muted wrap-anywhere group-hover:border-control-outline group-aria-pressed:border-accent-border group-aria-pressed:bg-accent-wash group-aria-pressed:text-accent-strong phone:min-h-control">
        {asked && <span aria-hidden="true">✓</span>}
        {more
          ? `Ask for ${asked ? quantity : initialQuantity} more from `
          : "Borrow from "}
        {text}
        {asked && !more && ` · ${cardCount(quantity)} in draft`}
      </span>
    </button>
  );
}
