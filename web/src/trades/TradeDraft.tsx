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
} from "react";
import { cardCount } from "../loans/loanText";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Stepper } from "../ui/Stepper";
import { useLift, useToast } from "../ui/Toast";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import { tradeCardName } from "./tradeText";

/** The Friend a draft goes to. */
export type TradeDraftFriend = {
  collector_id: string;
  display_name: string;
  handle: string | null;
};

/** A card on one side of a draft: one Card Edition, with what the screens show of it. */
export type TradeDraftCard = {
  edition_id: string;
  name: string;
  set_code: string;
  collector_number: string;
  descriptor: Record<string, unknown>;
  image_url: string | null;
};

export type TradeDraftLine = TradeDraftCard & {
  quantity: number;
  /** The most that side lists now, as the Trade List showed it when the card was added. The API caps it again. */
  cap: number;
};

/** "give": the collector's own cards; "get": the Friend's. */
export type TradeDraftSide = "give" | "get";

export type TradeDraft = {
  friend: TradeDraftFriend;
  give: TradeDraftLine[];
  get: TradeDraftLine[];
};

type TradeDraftApi = {
  /** The one draft (prototype verdict: one draft at a time), or null. */
  draft: TradeDraft | null;
  /** Copies of one Edition on one side of the draft to this Friend; 0 when it isn't there or the draft is another
   * Friend's. */
  quantity: (
    friendId: string,
    side: TradeDraftSide,
    editionId: string
  ) => number;
  /** Makes sure the draft is this Friend's, then runs `then`. With another Friend's draft it asks "Discard your draft
   * for <name>?" first; Keep it keeps that draft and runs nothing. */
  start: (friend: TradeDraftFriend, then?: () => void) => void;
  /** Sets one line of the draft to this Friend: 0 takes it out. With no draft for this Friend it starts one first,
   * asking as `start` does. */
  set: (
    friend: TradeDraftFriend,
    side: TradeDraftSide,
    card: TradeDraftCard,
    quantity: number,
    cap: number
  ) => void;
  /** Throws the draft away. */
  discard: () => void;
  /** The send key: kept while the draft is unchanged, so a send whose outcome is unknown is retried safely. */
  sendKey: () => string;
  /** Forgets the send key, after a send the API refused. */
  forgetKey: () => void;
  /** The draft page shows the draft itself: while it is open the bar stays down. */
  setBarHidden: (hidden: boolean) => void;
};

const TradeDraftContext = createContext<TradeDraftApi | null>(null);

/** The draft, or null outside the signed-in shell (the Add buttons then draw nothing). */
export function useTradeDraft(): TradeDraftApi | null {
  return useContext(TradeDraftContext);
}

const STORAGE_PREFIX = "prizecheck.tradeDraft.";

function validLines(value: unknown): value is TradeDraftLine[] {
  return (
    Array.isArray(value) &&
    value.every(
      (line: TradeDraftLine) =>
        typeof line?.edition_id === "string" &&
        typeof line?.name === "string" &&
        typeof line?.set_code === "string" &&
        typeof line?.collector_number === "string" &&
        Number.isInteger(line?.quantity) &&
        line.quantity > 0 &&
        Number.isInteger(line?.cap)
    )
  );
}

/** The account's draft kept in this tab (sessionStorage), so a reload keeps it; anything unreadable is dropped. */
function readDraft(userId: string): TradeDraft | null {
  try {
    const value = JSON.parse(
      window.sessionStorage.getItem(STORAGE_PREFIX + userId) ?? "null"
    ) as TradeDraft | null;
    if (
      typeof value?.friend?.collector_id === "string" &&
      typeof value?.friend?.display_name === "string" &&
      validLines(value?.give) &&
      validLines(value?.get)
    )
      return value;
  } catch {
    // Unreadable: no draft.
  }
  return null;
}

function writeDraft(userId: string, draft: TradeDraft | null) {
  try {
    if (draft === null)
      window.sessionStorage.removeItem(STORAGE_PREFIX + userId);
    else
      window.sessionStorage.setItem(
        STORAGE_PREFIX + userId,
        JSON.stringify(draft)
      );
  } catch {
    // Storage full or off: the draft still lives for this page.
  }
}

/** Forgets every account's Trade Proposal draft kept in this tab: signing out leaves none for the next account. */
export function forgetTradeDraft() {
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

/** The copies a draft lists on both sides. */
export function draftCopies(draft: TradeDraft): number {
  return [...draft.give, ...draft.get].reduce(
    (total, line) => total + line.quantity,
    0
  );
}

/** Only the Friend's id and names are kept, whatever object named them. */
function named(friend: TradeDraftFriend): TradeDraftFriend {
  return {
    collector_id: friend.collector_id,
    display_name: friend.display_name,
    handle: friend.handle,
  };
}

/**
 * The Trade Proposal draft (Trading #270, prototype verdict variant A, "one draft at a time"): client-only, one
 * draft to one Friend, kept in this tab's sessionStorage under the account id, so it survives browsing and a reload.
 * **Add** on a Friend's Trade List adds to the draft to that Friend; **Add** on My Trade List adds to the draft's give
 * side. Starting a draft to another Friend asks **Discard your draft for <name>?** first. A draft never promises
 * cards: only sending does. The bar (fixed, above the Borrow Request drafts tray and Collection's Actions strip, and
 * raising the toast above itself) names the draft with **Review**, which opens the draft page; it stays down while
 * the draft page is open.
 */
export function TradeDraftProvider({
  userId,
  onOpenDraft,
  children,
}: {
  userId: string;
  /** Opens the draft page (/trades/draft). */
  onOpenDraft: () => void;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<TradeDraft | null>(() =>
    readDraft(userId)
  );
  const [asking, setAsking] = useState<{
    friend: TradeDraftFriend;
    then: (() => void) | undefined;
  } | null>(null);
  const [barHidden, setBarHidden] = useState(false);
  const key = useRef<string | null>(null);

  useEffect(() => writeDraft(userId, draft), [userId, draft]);

  const change = useCallback(
    (update: (current: TradeDraft | null) => TradeDraft | null) => {
      key.current = null;
      setDraft(update);
    },
    []
  );

  const api = useMemo<TradeDraftApi>(() => {
    const begin = (friend: TradeDraftFriend, then?: () => void) => {
      if (
        draft &&
        draftCopies(draft) > 0 &&
        draft.friend.collector_id !== friend.collector_id
      ) {
        setAsking({ friend, then });
        return;
      }
      if (!draft || draft.friend.collector_id !== friend.collector_id)
        change(() => ({ friend: named(friend), give: [], get: [] }));
      then?.();
    };
    return {
      draft,
      quantity: (friendId, side, editionId) =>
        draft?.friend.collector_id === friendId
          ? (draft[side].find((line) => line.edition_id === editionId)
              ?.quantity ?? 0)
          : 0,
      start: begin,
      set: (friend, side, card, quantity, cap) =>
        begin(friend, () =>
          change((current) => {
            const base: TradeDraft =
              current && current.friend.collector_id === friend.collector_id
                ? current
                : { friend: named(friend), give: [], get: [] };
            const lines = base[side];
            const existing = lines.find(
              (line) => line.edition_id === card.edition_id
            );
            const next =
              quantity <= 0
                ? lines.filter((line) => line !== existing)
                : existing
                  ? lines.map((line) =>
                      line === existing ? { ...line, quantity, cap } : line
                    )
                  : [
                      ...lines,
                      {
                        edition_id: card.edition_id,
                        name: card.name,
                        set_code: card.set_code,
                        collector_number: card.collector_number,
                        descriptor: card.descriptor,
                        image_url: card.image_url,
                        quantity,
                        cap,
                      },
                    ];
            return { ...base, [side]: next };
          })
        ),
      discard: () => change(() => null),
      sendKey: () => {
        key.current ??= crypto.randomUUID();
        return key.current;
      },
      forgetKey: () => {
        key.current = null;
      },
      setBarHidden,
    };
  }, [draft, change]);

  return (
    <TradeDraftContext.Provider value={api}>
      {children}
      {draft && draftCopies(draft) > 0 && !barHidden && (
        <TradeDraftBar draft={draft} onReview={onOpenDraft} />
      )}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={`Discard your draft for ${draft?.friend.display_name ?? ""}?`}
        closeLabel="Keep your draft"
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 text-body">You can keep one draft at a time.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setAsking(null)}>Keep it</Button>
            <Button
              variant="primary"
              onClick={() => {
                const next = asking;
                setAsking(null);
                if (!next) return;
                change(() => ({
                  friend: named(next.friend),
                  give: [],
                  get: [],
                }));
                next.then?.();
              }}
            >
              Discard and start
            </Button>
          </div>
        </div>
      </Dialog>
    </TradeDraftContext.Provider>
  );
}

/**
 * The draft bar: fixed over the page's bottom right on desktop and full width above the tab bar on a phone, above the
 * Borrow Request drafts tray and Collection's Actions strip (their lifts), and raising the toast by its own height. A
 * spacer of its height after the page lets the page's last lines scroll clear of it.
 */
function TradeDraftBar({
  draft,
  onReview,
}: {
  draft: TradeDraft;
  onReview: () => void;
}) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const toast = useToast();
  const below = useLift("selection") + useLift("drafts");
  const bar = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = bar.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect().height;
      const gap = parseFloat(
        getComputedStyle(element).getPropertyValue("--space-2")
      );
      setHeight(box);
      toast.setLift("tradeDraft", box + (gap || 8));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      toast.setLift("tradeDraft", 0);
    };
  }, [phone, toast]);

  const name = draft.friend.display_name;
  const copies = draftCopies(draft);
  return (
    <>
      <div aria-hidden="true" style={{ height: height + 24 }} />
      <section
        ref={bar}
        aria-label="Trade Proposal draft"
        style={{ "--bar-lift": `${below}px` } as CSSProperties}
        className={
          phone
            ? "fixed inset-x-3 bottom-[calc(var(--spacing-tabbar)+var(--space-2)+var(--bar-lift))] z-(--layer-sticky) flex flex-col"
            : "fixed bottom-[calc(var(--space-6)+var(--bar-lift))] right-6 z-(--layer-sticky) flex w-80 flex-col"
        }
      >
        <div className="box-border flex min-w-0 items-center gap-3 rounded-panel border border-accent-border bg-surface-raised px-3 py-2">
          <p className="m-0 min-w-0 flex-1 text-meta">
            <span className="block font-semibold text-text wrap-anywhere">
              Trade Proposal to {name}
            </span>
            <span className="block text-text-muted">{cardCount(copies)}</span>
          </p>
          <Button
            variant="primary"
            aria-label={`Review Trade Proposal to ${name}`}
            onClick={onReview}
          >
            Review
          </Button>
        </div>
      </section>
    </>
  );
}

/** A Trade List row's draft control (Trading #270): Add, or once the card is on this side of the draft a stepper
 * setting how many, up to the copies listed (0 takes it out). A card on the draft's other side can't be on both
 * sides, so its Add is off. */
export function DraftControl({
  card,
  friend,
  inDraft,
  onOtherSide,
  onSet,
  side = "get",
}: {
  card: {
    name: string;
    set_code: string;
    collector_number: string;
    descriptor: Record<string, unknown>;
    copies: string;
  };
  friend: TradeDraftFriend;
  inDraft: number;
  onOtherSide: boolean;
  onSet: (quantity: number) => void;
  side?: "give" | "get";
}) {
  const label = tradeCardName(card);
  if (inDraft > 0)
    return (
      <Stepper
        label={`${label} ${side === "give" ? "you give" : "you get"}`}
        value={inDraft}
        min={0}
        max={Math.max(Number(card.copies), inDraft)}
        onChange={onSet}
      />
    );
  return (
    <Button
      aria-label={`Add ${label} to your Trade Proposal to ${friend.display_name}`}
      disabled={onOtherSide}
      onClick={() => onSet(1)}
    >
      Add
    </Button>
  );
}
