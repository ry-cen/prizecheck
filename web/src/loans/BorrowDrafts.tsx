import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  sendBorrowRequest,
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
import {
  cardCount,
  lineEdition,
  outcomeUnknown,
  sendMessage,
  today,
} from "./loanText";

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
};

export type Draft = {
  friend: DraftFriend;
  lines: DraftLine[];
  /** The borrower's Deck the cards go to; null is Unsorted. */
  deckId: string | null;
  /** "YYYY-MM-DD", or "" for none. */
  returnBy: string;
  /** The unanswered request this one replaces (Edit and resend), or null. */
  replaces: string | null;
};

type DraftsApi = {
  drafts: Draft[];
  /** Copies of one Edition in the draft to one Friend. */
  quantity: (friendId: string, editionId: string) => number;
  /** Sets a line: 0 takes it out, and a draft with no lines goes. `deckId` is the Deck the asking page is about: it
   * becomes For Deck only when this starts the Friend's draft, so a draft already started keeps its own choice. */
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
  /** Edit and resend: a draft to the Loan's other side with its cards, Deck and date, replacing the request while it
   * is unanswered, and the composer open on it. */
  editAndResend: (
    loan: LoanView,
    deckId: string | null,
    opener?: HTMLElement | null
  ) => void;
};

const DraftsContext = createContext<DraftsApi | null>(null);

/** The drafts, or null outside the signed-in shell (the slots then draw nothing). */
export function useBorrowDrafts(): DraftsApi | null {
  return useContext(DraftsContext);
}

const STORAGE_PREFIX = "prizecheck.borrowDrafts.";

/** The account's drafts kept in this tab (sessionStorage), so a reload keeps them; anything unreadable is dropped. */
function readDrafts(userId: string): Draft[] {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(STORAGE_PREFIX + userId) ?? "[]"
    ) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
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

/** What a Friend could lend of a copy, as a number: its spare and in-a-Deck copies. */
export function copyCap(copy: { spare: string; in_deck: string }): number {
  return Number(copy.spare) + Number(copy.in_deck);
}

/**
 * Draft Borrow Requests (social network #252, the Friends' cards verdict): client-only, one per Friend, kept in this
 * tab's sessionStorage under the account id. **Ask** anywhere (a Want List chip or panel, the card popup, a Friend's
 * Collection) adds to that Friend's draft; Ask on a page about one Deck (the Want List scoped to it, the deck builder's
 * Ways to get missing cards) starts a new draft For that Deck, and never changes one already started. The tray lists
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
  const opener = useRef<HTMLElement | null>(null);
  // Each draft's send key: kept while the draft is unchanged, so a send whose outcome is unknown is retried safely.
  const keys = useRef(new Map<string, string>());

  useEffect(() => writeDrafts(userId, drafts), [userId, drafts]);

  const change = useCallback(
    (friendId: string, update: (draft: Draft | undefined) => Draft | null) => {
      keys.current.delete(friendId);
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
    []
  );

  const api = useMemo<DraftsApi>(
    () => ({
      drafts,
      quantity: (friendId, editionId) =>
        drafts
          .find((draft) => draft.friend.collector_id === friendId)
          ?.lines.find((line) => line.edition_id === editionId)?.quantity ?? 0,
      set: (friend, card, quantity, cap, lendable, deckId) =>
        change(friend.collector_id, (draft) => {
          const base: Draft = draft ?? {
            friend,
            lines: [],
            deckId: deckId ?? null,
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
                      ? { ...line, quantity, cap: cap ?? line.cap }
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
                    },
                  ];
          // Only the Friend's id and names are kept, whatever object named them (a Friend copy, a Friend's page).
          const named: DraftFriend = {
            collector_id: friend.collector_id,
            display_name: friend.display_name,
            handle: friend.handle,
          };
          return lines.length ? { ...base, friend: named, lines } : null;
        }),
      review: (friendId, from) => {
        opener.current = from ?? null;
        setComposing(friendId);
      },
      editAndResend: (loan, deckId, from) => {
        const friendId = loan.other.collector_id;
        if (!friendId) return;
        const friend: DraftFriend = {
          collector_id: friendId,
          display_name: loan.other.display_name,
          handle: loan.other.handle,
        };
        change(friendId, (draft) => {
          const asked: DraftLine[] = loan.lines.map((line) => ({
            edition_id: line.edition_id,
            name: line.name,
            set_code: line.set_code,
            collector_number: line.collector_number,
            descriptor: line.descriptor,
            image_url: line.image_url,
            quantity: Number(line.requested),
            cap: null,
            lendable: "",
          }));
          const kept = (draft?.lines ?? []).filter(
            (line) =>
              !asked.some((other) => other.edition_id === line.edition_id)
          );
          return {
            friend,
            lines: [...asked, ...kept],
            deckId,
            returnBy: loan.return_by ?? "",
            replaces: loan.state === "requested" ? loan.id : null,
          };
        });
        opener.current = from ?? null;
        setComposing(friendId);
      },
    }),
    [drafts, change]
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
          sendKey={() => {
            const id = draft.friend.collector_id;
            const key = keys.current.get(id) ?? crypto.randomUUID();
            keys.current.set(id, key);
            return key;
          }}
          forgetKey={() => keys.current.delete(draft.friend.collector_id)}
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
  const shown = drafts.length > 0;

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
  sendKey,
  forgetKey,
  onChange,
  onClose,
  onOpenLoan,
  returnFocus,
}: {
  draft: Draft;
  sendKey: () => string;
  forgetKey: () => void;
  onChange: (update: (draft: Draft | undefined) => Draft | null) => void;
  onClose: () => void;
  onOpenLoan: (id: string) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const toast = useToast();
  // A sent request is a Loan changed outside the Loans tab: a Deck's pending requests read again.
  const noteLoansChanged = useNoteLoansChanged();
  const [decks, setDecks] = useState<DecksLoad>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const name = draft.friend.display_name;

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
    setMessage("");
    onChange((current) => (current ? update(current) : null));
  }
  const cardName = (editionId: string) =>
    draft.lines.find((line) => line.edition_id === editionId)?.name ?? "a card";

  async function send() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const loan = await sendBorrowRequest({
        lender_id: draft.friend.collector_id,
        lines: draft.lines.map((line) => ({
          edition_id: line.edition_id,
          quantity: String(line.quantity),
        })),
        deck_id: draft.deckId,
        return_by: draft.returnBy || null,
        replaces: draft.replaces,
        idempotency_key: sendKey(),
      });
      onChange(() => null);
      onClose();
      noteLoansChanged();
      toast.show({
        message: `Borrow Request sent to ${endSentence(name)}`,
        action: { label: "View", onAction: () => onOpenLoan(loan.id) },
        focus: true,
      });
    } catch (cause) {
      if (!outcomeUnknown(cause)) forgetKey();
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
          return lines.length ? { ...current, lines } : null;
        });
      } else if (error?.code === "DECK_NOT_FOUND") {
        onChange((current) => (current ? { ...current, deckId: null } : null));
        setAttempt((n) => n + 1);
      } else if (error?.code === "LOAN_CHANGED")
        onChange((current) =>
          current ? { ...current, replaces: null } : null
        );
      setMessage(sendMessage(cause, name, cardName));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`Borrow Request to ${name}`}
      closeLabel="Close Borrow Request"
      returnFocus={returnFocus}
    >
      <div className="flex flex-col gap-4">
        <p className="m-0 text-meta text-text-muted">
          {name} can accept all of it, part of it, or decline.
        </p>
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
                        return lines.length ? { ...current, lines } : null;
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
        <p role="alert" className="m-0 text-meta text-danger empty:hidden">
          {message}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              onChange(() => null);
              onClose();
            }}
          >
            Discard
          </Button>
          <Button onClick={onClose}>Keep draft</Button>
          <Button
            variant="primary"
            aria-disabled={busy || undefined}
            onClick={() => void send()}
          >
            Send Borrow Request
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * **Ask** (Get from Friends) or **Ask to borrow** (the card popup, a Friend's Collection): adds one copy to the
 * Friend's draft, then turns into a stepper up to what the Friend could lend; stepping to 0 takes the line out.
 */
export function AskControl({
  friend,
  card,
  cap,
  lendable,
  text = "Ask",
  deckId = null,
}: {
  friend: DraftFriend;
  card: DraftCard;
  cap: number;
  lendable: string;
  text?: "Ask" | "Ask to borrow";
  /** The Deck the page is about, For Deck when this starts the Friend's draft; null for none. */
  deckId?: string | null;
}) {
  const drafts = useBorrowDrafts();
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
  if (!drafts || cap < 1) return null;
  const name =
    text === "Ask"
      ? `Ask ${friend.display_name} for ${card.name}`
      : `Ask to borrow ${card.name} from ${friend.display_name}`;
  if (quantity === 0)
    return (
      <Button
        ref={ask}
        aria-label={name}
        onClick={() => {
          pressed.current = true;
          drafts.set(friend, card, 1, cap, lendable, deckId);
        }}
      >
        {text}
      </Button>
    );
  return (
    <span ref={group} className="inline-flex">
      <Stepper
        label={`Copies of ${card.name} to ask ${friend.display_name} for`}
        value={quantity}
        min={0}
        max={cap}
        onChange={(next) => {
          pressed.current = true;
          drafts.set(friend, card, next, cap, lendable, deckId);
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
  lendable,
  text,
  deckId = null,
}: {
  friend: DraftFriend;
  card: DraftCard;
  cap: number;
  lendable: string;
  text: string;
  /** The Deck the page is about, For Deck when this starts the Friend's draft; null for none. */
  deckId?: string | null;
}) {
  const drafts = useBorrowDrafts();
  if (!drafts || cap < 1)
    return (
      <span className="inline-flex min-h-chip items-center rounded-round border border-border-strong px-2.5 text-meta text-text-muted wrap-anywhere">
        {text}
      </span>
    );
  const asked = drafts.quantity(friend.collector_id, card.edition_id) > 0;
  return (
    <button
      type="button"
      aria-pressed={asked}
      title={
        asked
          ? `In your Borrow Request to ${friend.display_name}`
          : `Ask ${friend.display_name} to lend one`
      }
      onClick={() =>
        drafts.set(friend, card, asked ? 0 : 1, cap, lendable, deckId)
      }
      className="group m-0 box-border inline-flex min-h-chip max-w-full cursor-pointer items-center border-0 bg-transparent p-0 text-left font-sans phone:min-h-tap"
    >
      <span className="box-border inline-flex min-h-chip max-w-full items-center gap-1 rounded-round border border-border-strong px-2.5 text-meta text-text-muted wrap-anywhere group-hover:border-control-outline group-aria-pressed:border-accent-border group-aria-pressed:bg-accent-wash group-aria-pressed:text-accent-strong phone:min-h-control">
        {asked && <span aria-hidden="true">✓</span>}
        {text}
      </span>
    </button>
  );
}
