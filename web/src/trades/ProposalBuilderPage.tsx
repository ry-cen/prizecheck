import {
  readOfferInventory,
  selectedOfferInventory,
  currentOfferRead,
  OfferInventoryChanged,
} from "./offerInventory";
import { OfferReview, offerChanges } from "./offerReview";
import { offerCaps, offerControls, reviewRequired } from "./offerLifecycle";
import { offerVersion } from "./offerInventory";
import { offerLibrary, offerCopyMap } from "./offerCopies";
import { ProposedOfferChanges } from "./ProposedOfferChanges";
import { useMessagePrefill } from "./messagePrefill";
import { ArrowRight, ChevronLeft } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useInboxRefresh } from "../inbox/Inbox";
import { PageHeader } from "../shell/PageHeader";
import { useLeaveGuard, type LeaveGuard } from "../shell/useRoute";
import { TradeTermsRow } from "./TradeTermsRow";
import {
  getTrade,
  getTraderMatch,
  getTraderTradeList,
  SocialError,
  type TradeView,
} from "../social_generated";
import { counterTrade, getTradeList, TradesError } from "../trades_generated";
import {
  sendTradeProposal,
  type TradeView as SentTradeView,
} from "../trade_send_generated";
import {
  initialSendOutcome,
  isAppliedTradeUnavailable,
} from "./initialSendOutcome";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Segmented, segmentId } from "../ui/Segmented";
import { Stepper } from "../ui/Stepper";
import { TextArea } from "../ui/TextField";
import { TextField } from "../ui/TextField";
import { useToast } from "../ui/Toast";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import {
  clearProposalNotes,
  peekFromTradeList,
  peekProposalSeed,
  peekMatchProposal,
} from "./openProposal";
import { MatchPrintingChoices } from "./MatchPrintingChoices";
import { LiabilityNotice } from "./LiabilityNotice";
import {
  centsAmount,
  chooseMatchedPrinting,
  counterProposal,
  termsKey,
  EMPTY_PROPOSAL,
  matchesSearch,
  NO_CASH,
  parseCents,
  proposalCopies,
  quantityIn,
  requestLines,
  setQuantity,
  toProposalCard,
  valueLines,
  withReleased,
  type CashDraft,
  type CashPayer,
  type LibraryCard,
  type ProposalCard,
  type Proposal,
  type ProposalLine,
  type ProposalSide,
} from "./proposalModel";
import {
  ProposalLibrary,
  type MatchLoad,
  type MineLoad,
  type TheirsLoad,
} from "./ProposalLibrary";
import { UNAVAILABLE_NOTE } from "./conversationMessages";
import { TRADE_FIND_PATH, tradePath } from "./tradeListModel";
import {
  COUNTER_CHANGED_TEXT,
  COUNTER_GONE_TEXT,
  INVALID_CASH_TEXT,
  sendTradeMessage,
  tradeCardName,
  tradeOutcomeUnknown,
} from "./tradeText";
import { TRADER_LIST_TITLE } from "./traderMessages";
import { sideValueText, useTradeValue } from "./useTradeValue";

/** Compare content only: row order and empty representations do not make an unsent edit. */
export function proposalDraftChanged(
  opening: Proposal,
  openingCash: CashDraft,
  draft: Proposal,
  cash: CashDraft
): boolean {
  const key = (cards: Proposal, money: CashDraft) =>
    termsKey(
      {
        get: cards.get.filter((line) => line.quantity > 0),
        give: cards.give.filter((line) => line.quantity > 0),
      },
      money.payer !== "none" &&
        /^(?:(?:0+|0{1,3}(?:,000)+)(?:\.0{0,2})?|\.0{1,2})$/.test(
          money.amount.replace(/\s/g, "").replace(/^\$/, "")
        )
        ? NO_CASH
        : money
    );
  return key(opening, openingCash) !== key(draft, cash);
}

type Party = { trader_id: string; display_name: string };

type Theirs =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | Extract<TheirsLoad, { kind: "ready" }>;

type TerminalSend =
  | { kind: "applied_current"; trade: SentTradeView; label: "Current Trade" }
  | { kind: "unavailable" };

type Pane = "proposal" | "cards";

const SIDE_LABEL: Record<ProposalSide, string> = {
  get: "You get",
  give: "You give",
};

const FRAME =
  "mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-6 phone:px-4 phone:py-4";
const BACK =
  "inline-flex h-control items-center gap-1 self-start rounded-control px-2 text-control font-medium text-text-muted no-underline hover:bg-surface-raised hover:text-text phone:h-control-phone";

/**
 * A proposal builder (Trading #284, #299), at /trades/new/<trader id> for a Friend or any collector in reach, laid out like the Deck builder. The proposal is
 * the wide left column: **You get** and **You give**, each line with a stepper up to the copies the library offered,
 * and **Send Trade Proposal**. The card library (ProposalLibrary) is the narrow right column. On a phone a Proposal
 * and Cards switch shows one pane at a time, Cards first; both stay mounted.
 *
 * The proposal starts empty, with one copy in You get from Ask to trade, or with the visible match cards from Find
 * trades. It lives only in this page: nothing is kept, so leaving ends it. Once the collector has changed it, leaving through the shell, a link,
 * the back link or the browser's Back and Forward asks "Discard this proposal to <name>?" (the router's leave guard),
 * and a reload or close shows the browser's own warning. Nothing is asked for a draft left as it opened, when the
 * collector didn't load, or after a successful send. A card can't be on both sides; a
 * refused send keeps the proposal and says which card and how many are on the Trade List now. The back link returns
 * to the Trade List page the builder was opened from, and to Find trades otherwise.
 *
 * Cash (Trading #277): a **Cash** section under You give takes an amount in US dollars and who pays it, recorded
 * only; the app never handles money. Each side shows its estimated total under its list, and nothing suggests an
 * amount. The liability notice shows while a payer is chosen. A cash change makes a new send key and counts as an edit.
 *
 * Counter mode (Trading #278), at /trades/<id>/counter through CounterPage, which passes the Trade being countered.
 * The builder starts from that Trade as the server read it, both sides and the cash, on the Proposal pane on a phone;
 * a reload reads it again. The prefill isn't an edit, so leaving asks "Discard this Counter to <name>?" only after the
 * collector's own change. The copies the proposal's sender gave are reserved by it, so the library offers them again
 * on You get. The back link returns to the Trade, and **Send Counter** closes it and sends the reply. A Counter
 * refused because the proposal changed takes the new revision and asks for one more tap; one refused because the
 * proposal no longer waits for the answer disables Send, and the leave guard stops.
 */
const noSubscribe = () => () => {};
const noOffer = () => null;

export function ProposalBuilderPage({
  traderId,
  onNavigate,
  counter,
}: {
  traderId: string;
  onNavigate: (to: string) => void;
  /** The Trade being countered, as the reader sees it: set in counter mode. */
  counter?: TradeView;
}) {
  const toast = useToast();
  const idBase = useId();
  const libraryId = useId();
  const phone = useMediaQuery(MOBILE_QUERY);
  const [proposal, setProposal] = useState<Proposal>(() => {
    if (counter) return counterProposal(counter);
    return peekProposalSeed(traderId) ?? EMPTY_PROPOSAL;
  });
  const [fromMatch] = useState(() => !counter && peekMatchProposal(traderId));
  const [listBack] = useState(() =>
    counter ? null : peekFromTradeList(traderId)
  );
  const [loadedParty, setParty] = useState<Party | null>(null);
  const [theirs, setTheirs] = useState<Theirs>({ kind: "loading" });
  const [match, setMatch] = useState<MatchLoad>({ kind: "loading" });
  const [mine, setMine] = useState<MineLoad>({ kind: "loading" });
  const [theirQ, setTheirQ] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [matchAttempt, setMatchAttempt] = useState(0);
  const [mineAttempt, setMineAttempt] = useState(0);
  const [pane, setPane] = useState<Pane>(counter ? "proposal" : "cards");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const prefilledMessage = useMessagePrefill();
  const [initialMessage, setInitialMessage] = useState(prefilledMessage);
  const [announcement, setAnnouncement] = useState<{
    text: string;
    owner: "cards" | "proposal";
  }>({ text: "", owner: "proposal" });
  const [asking, setAsking] = useState<{ leave: () => void } | null>(null);
  const [cash, setCash] = useState<CashDraft>(() =>
    counter?.cash
      ? {
          payer: counter.cash.payer,
          amount: centsAmount(counter.cash.cents),
        }
      : NO_CASH
  );
  const cashHeadingId = useId();
  const value = useTradeValue(
    useMemo(() => valueLines(proposal.give, proposal.get), [proposal])
  );

  const [offerReview] = useState(() =>
    counter ? new OfferReview(counter) : null
  );
  const lifecycle = useSyncExternalStore(
    offerReview?.subscribe ?? noSubscribe,
    offerReview?.getSnapshot ?? noOffer,
    offerReview?.getSnapshot ?? noOffer
  );
  const reviewedOffer = lifecycle?.reviewed;
  const controls = lifecycle ? offerControls(lifecycle) : null;
  const reviewNeeded = lifecycle ? reviewRequired(lifecycle) : false;
  const answered = reviewedOffer;
  const party = lifecycle
    ? {
        trader_id: traderId,
        display_name: lifecycle.reviewed.other.display_name,
      }
    : loadedParty;
  const released = useMemo(
    () => offerCopyMap(reviewedOffer, "get"),
    [reviewedOffer]
  );
  const releasedOwn = useMemo(
    () => offerCopyMap(reviewedOffer, "give"),
    [reviewedOffer]
  );
  const gone = lifecycle?.phase === "gone";
  const refreshInbox = useInboxRefresh();
  const key = useRef<string | null>(null);
  const sent = useRef(false);
  const terminalRef = useRef<TerminalSend | null>(null);
  const [terminal, setTerminal] = useState<TerminalSend | null>(null);
  const opening = useRef({ proposal, cash });
  const changed = useRef(false);
  changed.current = proposalDraftChanged(
    opening.current.proposal,
    opening.current.cash,
    proposal,
    cash
  );
  // The guard reads these: it is made once. A collector who is gone (a 404 after load) can't be sent to, so nothing asks.
  const reachable = useRef(false);
  reachable.current = party !== null && theirs.kind !== "missing";
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // The seed and the origin are read while rendering and cleared once mounted, so a repeated render keeps them.
  useEffect(() => {
    if (!counter) clearProposalNotes();
  }, []);
  const returnTo = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const sideHeading = {
    get: useRef<HTMLHeadingElement>(null),
    give: useRef<HTMLHeadingElement>(null),
  };
  const refocus = useRef<ProposalSide | null>(null);
  // Bumped each time the main read starts, so a Show more read begun under an earlier search is dropped on arrival.
  const generation = useRef(0);

  // The model owns counter inventory/version scheduling. This bridge executes only its read effects.
  useEffect(() => {
    if (!offerReview) return;
    return offerReview.connect({
      version: (id, signal) => getTrade(id, signal),
      inventory: async (side, offer, editions, signal) => {
        if (side === "give") {
          setMine({ kind: "loading" });
          try {
            const { value: list, offerVersion } = await readOfferInventory(
              offer,
              () => getTradeList(signal),
              (id) => getTrade(id, signal)
            );
            if (!signal.aborted)
              setMine({ kind: "ready", cards: list.cards, offerVersion });
            return list.cards;
          } catch (cause) {
            if (!signal.aborted) setMine({ kind: "failed" });
            throw cause;
          }
        }
        const { value } = await readOfferInventory(
          offer,
          () =>
            selectedOfferInventory(editions, (page) =>
              getTraderTradeList(traderId, { page }, signal)
            ),
          (id) => getTrade(id, signal)
        );
        return value;
      },
    });
  }, [offerReview, traderId]);

  // The other side's Trade List, searched on the server; the first answer names them.
  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setTheirs((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    readOfferInventory(
      reviewedOffer,
      () => getTraderTradeList(traderId, { q: theirQ }, controller.signal),
      (id) => getTrade(id, controller.signal)
    )
      .then(({ value: page, offerVersion }) => {
        if (controller.signal.aborted) return;
        setParty(
          (current) =>
            current ?? {
              trader_id: page.trader_id,
              display_name: page.display_name,
            }
        );
        setTheirs({
          kind: "ready",
          q: theirQ,
          offerVersion,
          cards: page.cards,
          nextPage: page.next_page,
          more: "idle",
        });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        inventoryFailed(cause, reviewedOffer);
        setTheirs(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      });
    return () => controller.abort();
  }, [traderId, theirQ, attempt, reviewedOffer]);

  // The matches with this collector, listed first in the library.
  useEffect(() => {
    const controller = new AbortController();
    setMatch({ kind: "loading" });
    readOfferInventory(
      reviewedOffer,
      () => getTraderMatch(traderId, controller.signal),
      (id) => getTrade(id, controller.signal)
    ).then(
      ({ value: row, offerVersion }) => {
        if (!controller.signal.aborted)
          setMatch({ kind: "ready", row, offerVersion });
      },
      (cause) => {
        if (!controller.signal.aborted) {
          setMatch({ kind: "failed" });
          inventoryFailed(cause, reviewedOffer);
        }
      }
    );
    return () => controller.abort();
  }, [traderId, matchAttempt, reviewedOffer]);

  // Initial proposals have no reviewed offer; counter caps are read by model effects above.
  useEffect(() => {
    if (offerReview) return;
    const controller = new AbortController();
    setMine({ kind: "loading" });
    getTradeList(controller.signal).then(
      (list) => {
        if (!controller.signal.aborted)
          setMine({ kind: "ready", cards: list.cards });
      },
      () => {
        if (!controller.signal.aborted) setMine({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [mineAttempt, offerReview]);

  const selectedGet = proposal.get
    .map((line) => line.edition_id)
    .sort()
    .join("\0");
  useEffect(() => {
    offerReview?.select(selectedGet ? selectedGet.split("\0") : []);
  }, [offerReview, selectedGet]);
  const currentTheirs = currentOfferRead(theirs, reviewedOffer);
  const currentMatch = currentOfferRead(match, reviewedOffer);
  const currentMine = currentOfferRead(mine, reviewedOffer);
  const libraryTheirs = useMemo<TheirsLoad>(
    () =>
      currentTheirs.kind === "ready"
        ? {
            ...currentTheirs,
            cards: offerLibrary(
              currentTheirs.cards,
              reviewedOffer,
              "get",
              currentTheirs.q
            ),
          }
        : currentTheirs.kind === "loading"
          ? { kind: "loading" }
          : { kind: "failed" }, // a missing Friend shows its own frame, never the library
    [currentTheirs, released, reviewedOffer]
  );
  const libraryMatch = useMemo<MatchLoad>(
    () =>
      currentMatch.kind === "ready"
        ? {
            ...currentMatch,
            row: {
              ...currentMatch.row,
              you_get: withReleased(currentMatch.row.you_get, released),
              you_give: withReleased(currentMatch.row.you_give, releasedOwn),
            },
          }
        : currentMatch,
    [currentMatch, released, releasedOwn]
  );

  const libraryMine = useMemo<MineLoad>(
    () =>
      currentMine.kind === "ready"
        ? {
            ...currentMine,
            cards: offerLibrary(currentMine.cards, reviewedOffer, "give"),
          }
        : currentMine,
    [currentMine, reviewedOffer]
  );

  const caps = lifecycle
    ? offerCaps(lifecycle, proposal)
    : { proposal, ready: true, overCap: false };
  const capsReady = caps.ready;
  const displayedProposal = caps.proposal;
  const overCap = caps.overCap;
  const replaying =
    lifecycle?.phase === "retry_send" && lifecycle.pending !== null;

  async function showMore() {
    if (
      currentTheirs.kind !== "ready" ||
      currentTheirs.nextPage === null ||
      currentTheirs.more === "loading" ||
      currentTheirs.q !== theirQ
    )
      return;
    const current = currentTheirs;
    const at = generation.current;
    setTheirs({ ...current, more: "loading" });
    try {
      const { value: page, offerVersion } = await readOfferInventory(
        reviewedOffer,
        () =>
          getTraderTradeList(traderId, {
            q: current.q,
            page: current.nextPage!,
          }),
        getTrade
      );
      if (generation.current !== at) return;
      setTheirs({
        kind: "ready",
        q: current.q,
        offerVersion,
        cards: [...current.cards, ...page.cards],
        nextPage: page.next_page,
        more: "idle",
      });
    } catch (cause) {
      if (generation.current !== at) return;
      inventoryFailed(cause, reviewedOffer);
      if (cause instanceof SocialError && cause.status === 404) {
        setTheirs({ kind: "missing" });
        return;
      }
      setTheirs({ ...current, more: "failed" });
    }
  }

  // Any change makes a new send key: a send is the same only when the proposal is.
  function change(next: (p: Proposal) => Proposal) {
    if (
      terminalRef.current ||
      sending.current ||
      lifecycle?.phase === "sending"
    )
      return;
    offerReview?.dispatch({ type: "draft_edited" });
    setProposal(next);
    key.current = null;
  }

  // A cash change is an edit like a card: it makes a new send key.
  function editCash(next: CashDraft) {
    if (
      terminalRef.current ||
      sending.current ||
      lifecycle?.phase === "sending"
    )
      return;
    offerReview?.dispatch({ type: "draft_edited" });
    key.current = null;
    setCash(next);
  }

  // The same words twice are announced twice: the line is cleared first, then set a moment later.
  const announceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);
  function say(text: string, owner: "cards" | "proposal" = "cards") {
    window.clearTimeout(announceTimer.current);
    setAnnouncement({ text: "", owner });
    announceTimer.current = window.setTimeout(
      () => setAnnouncement({ text, owner }),
      60
    );
  }

  function add(side: ProposalSide, libraryCard: LibraryCard) {
    if (!capsReady || sending.current || lifecycle?.phase === "sending") return;
    const card = toProposalCard(libraryCard.card);
    const label = tradeCardName(card);
    const n = quantityIn(proposal, side, card.edition_id);
    const cap = Number(card.copies);
    const held = quantityIn(
      proposal,
      side === "get" ? "give" : "get",
      card.edition_id
    );
    if (held > 0)
      say(
        `${label} is in ${SIDE_LABEL[side === "get" ? "give" : "get"]}. A card can't be on both sides.`
      );
    else if (n >= cap) say(`All ${cap} ${label} are in ${SIDE_LABEL[side]}.`);
    else {
      change((p) => setQuantity(p, side, card, n + 1));
      say(`${label}: ${n + 1} in ${SIDE_LABEL[side]}`);
    }
  }

  // A line taken out moves focus to its side's heading, since the stepper left with it.
  useEffect(() => {
    const side = refocus.current;
    refocus.current = null;
    if (side) sideHeading[side].current?.focus();
  }, [proposal]);

  function inventoryFailed(cause: unknown, expected: TradeView | undefined) {
    if (
      expected &&
      (cause instanceof OfferInventoryChanged ||
        (cause instanceof SocialError && cause.status === 404))
    )
      offerReview?.invalidate(expected);
  }
  async function checkCurrentOffer() {
    if (!offerReview) return;
    try {
      await offerReview.refresh(getTrade);
    } catch {
      /* The model keeps the cached candidate and exposes Retry. */
    }
  }
  function retryOfferRead() {
    if (!offerReview) return;
    const retry = offerControls(offerReview.getSnapshot()).retry;
    if (retry === "check") {
      void checkCurrentOffer();
      return;
    }
    offerReview.dispatch({ type: "retry" });
    setMineAttempt((n) => n + 1);
    setAttempt((n) => n + 1);
    setMatchAttempt((n) => n + 1);
  }
  async function sendCounter(
    current: Proposal,
    name: string,
    cashBody: { cents: string; payer: "you" | "them" } | null
  ) {
    if (!offerReview || !offerControls(offerReview.getSnapshot()).send) return;
    try {
      const trade = await offerReview.submit(
        {
          you_give: requestLines(current.give),
          you_get: requestLines(current.get),
          cash: cashBody,
        },
        crypto.randomUUID(),
        counterTrade,
        getTrade
      );
      if (!trade) {
        refreshInbox();
        return;
      }
      sent.current = true;
      if (mounted.current) {
        toast.show({
          message: `${offerReview.reviewed.actions.includes("change_offer") ? "Offer" : "Counter"} sent to ${name}`,
          route: tradePath(trade.thread_id),
        });
        onNavigate(tradePath(trade.thread_id));
      }
      refreshInbox();
    } catch (cause) {
      setMessage(
        sendTradeMessage(cause, name, current.give, current.get, "counter")
      );
    }
  }

  async function send() {
    if (
      terminalRef.current ||
      sending.current ||
      busy ||
      !party ||
      (!replaying && (!capsReady || overCap)) ||
      (controls !== null && !controls.send)
    )
      return;
    const current = proposal;
    const name = party.display_name;
    let cashBody: { cents: string; payer: "you" | "them" } | null = null;
    if (cash.payer !== "none") {
      const cents = parseCents(cash.amount);
      if (cents === null) {
        setMessage(INVALID_CASH_TEXT);
        return;
      }
      cashBody = { cents, payer: cash.payer };
    }
    setBusy(true);
    sending.current = true;
    setMessage("");
    if (counter) {
      try {
        await sendCounter(current, name, cashBody);
      } finally {
        sending.current = false;
        setBusy(false);
      }
      return;
    }
    // Capture the submission key for this frozen draft.
    const submittedKey = key.current ?? crypto.randomUUID();
    if (terminalRef.current) return;
    key.current = submittedKey;
    const settle = (result: TerminalSend) => {
      sent.current = true;
      terminalRef.current = result;
      key.current = submittedKey;
      if (mounted.current) setTerminal(result);
    };
    try {
      const result = initialSendOutcome(
        await sendTradeProposal({
          recipient_trader_id: party.trader_id,
          you_give: requestLines(current.give),
          you_get: requestLines(current.get),
          cash: cashBody,
          idempotency_key: submittedKey,
          message: initialMessage || null,
        })
      );
      if (result.kind === "applied_current") {
        settle(result);
        return;
      }
      sent.current = true;
      if (mounted.current)
        toast.show({
          message: `Trade Proposal sent to ${name}`,
          route: tradePath(result.trade.thread_id),
        });
      // Leaving while the send was out is the collector's choice; the Trade is theirs to find in Trades.
      if (mounted.current) onNavigate(tradePath(result.trade.thread_id));
    } catch (cause) {
      if (isAppliedTradeUnavailable(cause)) {
        settle({ kind: "unavailable" });
        return;
      }
      if (terminalRef.current) return;
      // A refusal is final for this key; an unknown outcome keeps it, so the retry is the same send.
      if (!tradeOutcomeUnknown(cause)) key.current = null;
      if (mounted.current)
        setMessage(sendTradeMessage(cause, name, current.give, current.get));
    } finally {
      sending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  // The leave guard reads refs only, so it is made once.
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () =>
        !sent.current &&
        !sending.current &&
        reachable.current &&
        !offerReview?.unavailable &&
        changed.current,
      ask: (leave) => {
        const active = document.activeElement;
        // Focus inside a dialog (the account sheet, the inbox, the Friends drawer) can't be returned to once it
        // closes with the page change, so the heading takes it.
        returnTo.current =
          active instanceof HTMLElement &&
          active !== document.body &&
          !active.closest("dialog")
            ? active
            : headingRef.current;
        setAsking({ leave });
      },
    }),
    []
  );
  useLeaveGuard(guard);

  // The browser's own warning on reload or close, while something the collector changed is unsent.
  const dirty = !terminal && reachable.current && !gone && changed.current;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (sent.current || sending.current || terminalRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const go = (to: string) => (event: MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    onNavigate(to);
  };
  const backTo = counter
    ? tradePath(counter.thread_id)
    : (listBack ?? TRADE_FIND_PATH);
  const backLink = (
    <a href={backTo} onClick={go(backTo)} className={BACK}>
      <Icon icon={ChevronLeft} />
      {counter
        ? `${counter.other.display_name}'s Trade Proposal`
        : listBack
          ? party
            ? `${party.display_name}'s Trade List`
            : TRADER_LIST_TITLE
          : "Find trades"}
    </a>
  );
  const back = backLink;
  const frameTitle = counter
    ? counter.actions.includes("change_offer")
      ? "Change offer"
      : "Counter"
    : "Trade Proposal";
  const frame = (title: string, children: ReactNode, loading = false) => (
    <main className={FRAME}>
      {back}
      <PageHeader title={title} loading={loading} />
      {children}
    </main>
  );

  if (terminal) {
    const backToTrades = (
      <a href="/trades" onClick={go("/trades")} className={BACK}>
        Back to Trades
      </a>
    );
    if (terminal.kind === "unavailable")
      return (
        <main className={FRAME}>
          <PageHeader title="Trade Proposal" />
          <p role="status" className="m-0 text-body text-text">
            Your proposal was already sent. This Trade isn't available to view.
            Return to Trades to check your items.
          </p>
          {backToTrades}
        </main>
      );
    const trade = terminal.trade;
    const target = tradePath(trade.thread_id);
    return (
      <main className={FRAME}>
        <PageHeader title={terminal.label} />
        <p role="status" className="m-0 text-body text-text">
          Your proposal was already sent. These are the current terms.
        </p>
        <p className="m-0 text-body text-text">
          {
            { proposed: "Proposed", accepted: "Agreed", closed: "Closed" }[
              trade.state
            ]
          }
        </p>
        {(["give", "get"] as const).map((side) => (
          <section key={side} aria-label={SIDE_LABEL[side]}>
            <h2 className="m-0 text-heading font-semibold">
              {SIDE_LABEL[side]}
            </h2>
            <ul className="m-0 list-none p-0">
              {trade[side === "give" ? "you_give" : "you_get"].map((card) => (
                <TradeTermsRow
                  key={card.edition_id}
                  card={card}
                  quantity={`${card.copies} copies`}
                />
              ))}
            </ul>
          </section>
        ))}
        <p className="m-0 text-body text-text">
          {trade.cash
            ? `${trade.cash.payer === "you" ? "You pay" : "They pay"} $${centsAmount(trade.cash.cents)}`
            : "No cash"}
        </p>
        <a href={target} onClick={go(target)} className={BACK}>
          View current Trade
        </a>
        {backToTrades}
      </main>
    );
  }

  if (!lifecycle && theirs.kind === "missing")
    return frame(
      frameTitle,
      <p className="m-0 text-body text-text-muted">{UNAVAILABLE_NOTE}</p>
    );
  if (!lifecycle && theirs.kind === "failed" && !party)
    return frame(
      frameTitle,
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-body text-danger">
          This proposal couldn't be opened. Please retry.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (!party)
    return frame(
      frameTitle,
      <p role="status" className="m-0 text-body text-text-muted">
        Loading…
      </p>,
      true
    );

  const name = party.display_name;
  const copies = proposalCopies(proposal);
  const empty = copies === 0;
  const reasonId = `${idBase}-reason`;
  const unchanged =
    answered !== undefined &&
    termsKey(proposal, cash) ===
      termsKey(
        counterProposal(answered),
        answered.cash
          ? {
              payer: answered.cash.payer,
              amount: centsAmount(answered.cash.cents),
            }
          : NO_CASH
      );
  const reason = !capsReady
    ? "Checking available copies…"
    : overCap
      ? "Some quantities exceed the available copies. Lower them before sending."
      : empty
        ? "Add at least one card to either side."
        : unchanged
          ? "Change a card, a quantity or the cash to send a Counter."
          : null;

  const sideSection = (side: ProposalSide) => (
    <ProposalSideSection
      key={side}
      side={side}
      lines={displayedProposal[side]}
      loadingCaps={!capsReady}
      heading={sideHeading[side]}
      total={sideValueText(
        value,
        side === "get" ? "you_get" : "you_give",
        proposal[side].length > 0
      )}
      onChange={(line, quantity) => {
        if (sending.current) return;
        say(
          `${tradeCardName(line)}: ${quantity} in ${SIDE_LABEL[side]}`,
          "proposal"
        );
        if (quantity === 0) refocus.current = side;
        change((p) => setQuantity(p, side, line, quantity));
      }}
    />
  );
  const proposalPane = (
    <fieldset
      aria-disabled={busy || undefined}
      className="contents"
      onClickCapture={(event) => {
        // Keep controls focusable while the submitted draft is frozen. Handler guards also protect late events.
        if (!sending.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <section aria-label="Proposal" className="flex min-w-0 flex-col gap-4">
        {lifecycle &&
          (reviewNeeded ||
            lifecycle.phase === "read_failed" ||
            lifecycle.phase === "loading") && (
            <section
              aria-label="Current offer to review"
              className="flex flex-col gap-2 rounded-panel border border-border p-3"
            >
              <p role="status">
                {lifecycle.phase === "gone"
                  ? "This Trade no longer accepts an offer change. Your draft is kept."
                  : lifecycle.phase === "read_failed"
                    ? lifecycle.failure === "version"
                      ? "The current offer couldn't be loaded. Your draft is kept. Retry the check before sending."
                      : "Available copies couldn't be loaded. Your draft is kept."
                    : lifecycle.phase === "loading"
                      ? "Checking available copies…"
                      : lifecycle.phase === "checking"
                        ? "Checking the current offer. Your draft is kept."
                        : "The offer changed. Your draft is kept."}
              </p>
              {lifecycle.candidate ? (
                <>
                  <h2>Current offer</h2>
                  <ul>
                    {offerChanges(lifecycle.reviewed, lifecycle.candidate).map(
                      (text) => (
                        <li key={text}>{text}</li>
                      )
                    )}
                  </ul>
                  <p>
                    You give:{" "}
                    {lifecycle.candidate.you_give
                      .map((card) => `${card.copies} ${tradeCardName(card)}`)
                      .join(", ") || "Nothing"}
                  </p>
                  <p>
                    You get:{" "}
                    {lifecycle.candidate.you_get
                      .map((card) => `${card.copies} ${tradeCardName(card)}`)
                      .join(", ") || "Nothing"}
                  </p>
                  <p>
                    {lifecycle.candidate.cash
                      ? `${lifecycle.candidate.cash.payer === "you" ? "You pay" : "They pay"} $${(Number(lifecycle.candidate.cash.cents) / 100).toFixed(2)}`
                      : "No cash"}
                  </p>
                  <Button
                    disabled={!controls?.review}
                    onClick={() => {
                      if (!offerReview?.confirm()) return;
                      setMineAttempt((n) => n + 1);
                      setAttempt((n) => n + 1);
                      setMatchAttempt((n) => n + 1);
                      setMessage(
                        "Current offer reviewed. Check your draft before sending."
                      );
                    }}
                  >
                    I reviewed the current offer
                  </Button>
                  {gone && <p>This Trade no longer accepts an offer change.</p>}
                </>
              ) : (
                <p>The current offer has not been loaded.</p>
              )}
              {controls?.retry && controls.retry !== "send" && (
                <Button onClick={retryOfferRead}>
                  {controls.retry === "check"
                    ? lifecycle.phase === "read_failed"
                      ? "Retry current offer"
                      : "Check current offer"
                    : "Retry available copies"}
                </Button>
              )}
            </section>
          )}
        {sideSection("get")}
        {fromMatch && match.kind === "ready" && (
          <MatchPrintingChoices
            side="get"
            row={match.row}
            proposal={proposal}
            onChoose={(groupId, editionId) =>
              change((p) =>
                chooseMatchedPrinting(p, "get", match.row, groupId, editionId)
              )
            }
          />
        )}
        {sideSection("give")}
        {fromMatch && match.kind === "ready" && (
          <MatchPrintingChoices
            side="give"
            row={match.row}
            proposal={proposal}
            onChoose={(groupId, editionId) =>
              change((p) =>
                chooseMatchedPrinting(p, "give", match.row, groupId, editionId)
              )
            }
          />
        )}
        <section
          aria-labelledby={cashHeadingId}
          className="flex min-w-0 flex-col gap-2"
        >
          <h2 id={cashHeadingId} className="m-0 text-heading font-semibold">
            Cash
          </h2>
          <Segmented<CashPayer>
            mode="choice"
            label="Cash"
            labelledBy={cashHeadingId}
            value={cash.payer}
            onChange={(payer) =>
              editCash(payer === "none" ? NO_CASH : { ...cash, payer })
            }
            options={[
              { value: "none", label: "No cash" },
              { value: "you", label: "You pay" },
              { value: "them", label: `${name} pays` },
            ]}
          />
          {cash.payer !== "none" && (
            <TextField
              label="Amount in US dollars"
              inputMode="decimal"
              placeholder="0.00"
              autoComplete="off"
              maxLength={14}
              readOnly={busy}
              value={cash.amount}
              onChange={(event) =>
                editCash({ ...cash, amount: event.currentTarget.value })
              }
            />
          )}
        </section>
        {cash.payer !== "none" && <LiabilityNotice />}
        {counter && answered && (
          <ProposedOfferChanges
            before={counterProposal(answered)}
            after={displayedProposal}
            cashBefore={answered.cash}
            cashAfter={cash}
            other={name}
          />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            className="disabled:opacity-45"
            disabled={
              !busy &&
              (empty ||
                gone ||
                unchanged ||
                reviewNeeded ||
                (controls !== null && !controls.send) ||
                (!replaying && (!capsReady || overCap)) ||
                terminal !== null)
            }
            aria-disabled={busy || undefined}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => void send()}
          >
            {counter
              ? counter.actions.includes("change_offer")
                ? "Send changed offer"
                : "Send Counter"
              : "Send Trade Proposal"}
          </Button>
          {reason && (
            <p id={reasonId} className="m-0 text-meta text-text-muted">
              {reason}
            </p>
          )}
        </div>
        {!counter && (
          <TextArea
            label="Message (optional)"
            value={initialMessage}
            maxLength={4000}
            readOnly={busy || terminal !== null || key.current !== null}
            onChange={(event) => {
              if (
                sending.current ||
                terminalRef.current ||
                key.current !== null
              )
                return;
              setInitialMessage(event.target.value);
            }}
          />
        )}

        <p role="alert" className="m-0 text-meta text-danger empty:hidden">
          {message}
        </p>
      </section>
    </fieldset>
  );
  const libraryAnnounces =
    announcement.owner === "cards" && (!phone || pane === "cards");
  const library = (
    <ProposalLibrary
      headingId={libraryId}
      additionsBlocked={!capsReady || busy || lifecycle?.phase === "sending"}
      announcement={libraryAnnounces ? announcement.text : null}
      ownScroll={!phone}
      friendName={name}
      theirs={libraryTheirs}
      mine={libraryMine}
      match={libraryMatch}
      onTheirSearch={setTheirQ}
      onShowMore={() => void showMore()}
      onRetry={(which) => {
        if (which === "theirs") {
          setAttempt((n) => n + 1);
          offerReview?.beginInventory("get");
        } else if (which === "mine") {
          setMineAttempt((n) => n + 1);
          offerReview?.beginInventory("give");
        } else setMatchAttempt((n) => n + 1);
      }}
      proposal={displayedProposal}
      onAdd={add}
    />
  );

  return (
    <main className={FRAME}>
      {back}
      <PageHeader title={`${frameTitle} to ${name}`} headingRef={headingRef} />
      {phone ? (
        <>
          <Segmented
            label="Proposal builder"
            idBase={idBase}
            panelId={`${idBase}-panel`}
            value={pane}
            onChange={(next) => {
              window.clearTimeout(announceTimer.current);
              setAnnouncement({ text: "", owner: "proposal" });
              setPane(next);
            }}
            options={[
              { value: "proposal", label: "Proposal", count: String(copies) },
              { value: "cards", label: "Cards" },
            ]}
          />
          <div
            role="tabpanel"
            id={`${idBase}-panel`}
            aria-labelledby={segmentId(idBase, pane)}
            className="min-w-0"
          >
            <div hidden={pane !== "proposal"}>{proposalPane}</div>
            <div hidden={pane !== "cards"}>{library}</div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)] items-start gap-6 compact:grid-cols-[minmax(0,1fr)_16rem]">
          {proposalPane}
          {library}
        </div>
      )}
      {!libraryAnnounces && (
        <p role="status" className="m-0 min-h-5 text-meta text-text-muted">
          {announcement.owner === "proposal" ? announcement.text : ""}
        </p>
      )}
      <Dialog
        open={asking !== null}
        onClose={() => setAsking(null)}
        title={
          counter
            ? `Discard this Counter to ${name}?`
            : `Discard this proposal to ${name}?`
        }
        closeLabel="Back to the proposal"
        returnFocus={returnTo}
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 text-body">
            {counter
              ? `Your changes aren't kept. ${name}'s Trade Proposal stays as it was.`
              : "Your changes aren't kept."}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              data-autofocus
              variant="secondary"
              onClick={() => setAsking(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (!asking) return;
                const { leave } = asking;
                setAsking(null);
                leave();
              }}
            >
              Discard
            </Button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}

/** One side of the proposal: its heading, its lines with steppers (0 takes a line out) and "Nothing yet" when empty. */
function ProposalSideSection({
  side,
  lines,
  heading,
  total,
  loadingCaps,
  onChange,
}: {
  side: ProposalSide;
  lines: ProposalLine[];
  heading: React.RefObject<HTMLHeadingElement | null>;
  /** The side's estimated total, or null when it has no lines. */
  total: string | null;
  loadingCaps: boolean;
  onChange: (line: ProposalLine, quantity: number) => void;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex min-w-0 flex-col gap-2"
    >
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="m-0 text-heading font-semibold"
      >
        {SIDE_LABEL[side]}
      </h2>
      <ul
        aria-label={SIDE_LABEL[side]}
        className="m-0 list-none overflow-hidden rounded-panel border border-border bg-surface p-0"
      >
        {lines.length === 0 ? (
          <li className="flex min-h-36 items-center justify-center gap-3 px-4 py-6 text-body text-text-muted">
            <Icon icon={ArrowRight} size={20} className="phone:rotate-90" />
            Nothing yet
          </li>
        ) : (
          lines.map((line) => {
            const cap = Number(line.copies);
            return (
              <TradeTermsRow
                key={line.edition_id}
                card={line}
                quantity={
                  <Stepper
                    label={`${tradeCardName(line)} ${side === "get" ? "you get" : "you give"}`}
                    value={line.quantity}
                    min={0}
                    max={loadingCaps ? line.quantity : cap}
                    announceValue={false}
                    onChange={(value) => onChange(line, value)}
                  />
                }
                context={
                  <span className="text-meta text-text-subtle tabular-nums">
                    {loadingCaps
                      ? "Checking available copies…"
                      : `Up to ${cap}`}
                  </span>
                }
                details={
                  <p className="m-0 text-body">
                    ×{line.quantity} · {SIDE_LABEL[side]}
                  </p>
                }
              />
            );
          })
        )}
      </ul>
      {total && (
        <p className="m-0 text-meta text-text-muted tabular-nums">{total}</p>
      )}
    </section>
  );
}
