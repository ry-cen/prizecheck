import { ArrowRight, ChevronLeft } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useInboxRefresh } from "../inbox/Inbox";
import { lineEdition } from "../loans/loanText";
import { PageHeader } from "../shell/PageHeader";
import { useLeaveGuard, type LeaveGuard } from "../shell/useRoute";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getTrade,
  getTraderMatch,
  getTraderTradeList,
  SocialError,
  type TradeView,
} from "../social_generated";
import {
  counterTrade,
  getTradeList,
  sendTradeProposal,
  TradesError,
} from "../trades_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Segmented, segmentId } from "../ui/Segmented";
import { Stepper } from "../ui/Stepper";
import { TextField } from "../ui/TextField";
import { useToast } from "../ui/Toast";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import {
  clearProposalNotes,
  peekFromTradeList,
  peekProposalSeed,
} from "./openProposal";
import { LiabilityNotice } from "./LiabilityNotice";
import {
  centsAmount,
  counterProposal,
  termsKey,
  EMPTY_PROPOSAL,
  matchesSearch,
  NO_CASH,
  parseCents,
  proposalCopies,
  quantityIn,
  requestLines,
  seededProposal,
  setQuantity,
  toProposalCard,
  valueLines,
  withLibraryCaps,
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
import { conversationLinkText, UNAVAILABLE_NOTE } from "./conversationMessages";
import { conversationPath, TRADE_FIND_PATH, tradePath } from "./tradeListModel";
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

type Party = { trader_id: string; display_name: string };

type Theirs =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | Extract<TheirsLoad, { kind: "ready" }>;

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
 * The proposal starts empty (or, from Ask to trade, with one copy of that card in You get) and lives only in this
 * page: nothing is kept, so leaving ends it. Once the collector has changed it, leaving through the shell, a link,
 * the back link or the browser's Back and Forward asks "Discard this proposal to <name>?" (the router's leave guard),
 * and a reload or close shows the browser's own warning. Nothing is asked for a proposal that holds no cards, for one
 * left as it opened, when the collector didn't load, or after a successful send. A card can't be on both sides; a
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
    const card = peekProposalSeed(traderId);
    return card ? seededProposal(card) : EMPTY_PROPOSAL;
  });
  const [listBack] = useState(() =>
    counter ? null : peekFromTradeList(traderId)
  );
  const [party, setParty] = useState<Party | null>(null);
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
  const [announce, setAnnounce] = useState("");
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

  // A Counter: the copies the proposal's sender gave are reserved by it, so the library offers them again.
  const released = useMemo(
    () =>
      new Map(
        (counter?.you_get ?? []).map((c) => [c.edition_id, Number(c.copies)])
      ),
    [counter]
  );
  const revision = useRef(counter?.revision ?? 0);
  // The terms the Counter answers: the Trade as read, or as read again after a refusal that took a new revision.
  const [answered, setAnswered] = useState(counter);
  const [gone, setGone] = useState(false);
  const goneRef = useRef(false);
  const refreshInbox = useInboxRefresh();
  const key = useRef<string | null>(null);
  const sent = useRef(false);
  const edited = useRef(false);
  const latest = useRef(proposal);
  latest.current = proposal;
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

  // The other side's Trade List, searched on the server; the first answer names them.
  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setTheirs((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getTraderTradeList(traderId, { q: theirQ }, controller.signal)
      .then((page) => {
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
          cards: page.cards,
          nextPage: page.next_page,
          more: "idle",
        });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setTheirs(
          cause instanceof SocialError && cause.status === 404
            ? { kind: "missing" }
            : { kind: "failed" }
        );
      });
    return () => controller.abort();
  }, [traderId, theirQ, attempt]);

  // The matches with this collector, listed first in the library.
  useEffect(() => {
    const controller = new AbortController();
    setMatch({ kind: "loading" });
    getTraderMatch(traderId, controller.signal).then(
      (row) => {
        if (!controller.signal.aborted) setMatch({ kind: "ready", row });
      },
      () => {
        if (!controller.signal.aborted) setMatch({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [traderId, matchAttempt]);

  // The collector's own Trade List, one row per Edition (not per Location).
  useEffect(() => {
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
  }, [mineAttempt]);

  // A released Edition the Friend lists no copy of now has no tile, so it is added back after the list (when the search
  // matches it), at the copies the proposal held.
  function releasedCards<T extends ProposalCard>(
    cards: readonly T[],
    q: string
  ): ProposalCard[] {
    const adjusted: ProposalCard[] = withReleased(cards, released);
    if (!counter) return adjusted;
    const listed = new Set(cards.map((card) => card.edition_id));
    return [
      ...adjusted,
      ...counter.you_get
        .filter(
          (card) => !listed.has(card.edition_id) && matchesSearch(card.name, q)
        )
        .map(toProposalCard),
    ];
  }
  const libraryTheirs = useMemo<TheirsLoad>(
    () =>
      theirs.kind === "ready"
        ? { ...theirs, cards: releasedCards(theirs.cards, theirs.q) }
        : theirs.kind === "loading"
          ? { kind: "loading" }
          : { kind: "failed" }, // a missing Friend shows its own frame, never the library
    [theirs, released, counter]
  );
  const libraryMatch = useMemo<MatchLoad>(
    () =>
      match.kind === "ready"
        ? {
            ...match,
            row: {
              ...match.row,
              you_get: withReleased(match.row.you_get, released),
            },
          }
        : match,
    [match, released]
  );

  // A Counter's lines start at the countered copies as their cap; each library that lists more raises it. Only the caps
  // change, never the terms, so this is not an edit.
  useEffect(() => {
    if (!counter) return;
    setProposal((p) => {
      let next = p;
      if (libraryTheirs.kind === "ready")
        next = withLibraryCaps(next, "get", libraryTheirs.cards);
      if (libraryMatch.kind === "ready") {
        next = withLibraryCaps(next, "get", libraryMatch.row.you_get);
        next = withLibraryCaps(next, "give", libraryMatch.row.you_give);
      }
      if (mine.kind === "ready")
        next = withLibraryCaps(next, "give", mine.cards);
      return next;
    });
  }, [counter, libraryTheirs, libraryMatch, mine]);

  async function showMore() {
    if (
      theirs.kind !== "ready" ||
      theirs.nextPage === null ||
      theirs.more === "loading" ||
      theirs.q !== theirQ
    )
      return;
    const current = theirs;
    const at = generation.current;
    setTheirs({ ...current, more: "loading" });
    try {
      const page = await getTraderTradeList(traderId, {
        q: current.q,
        page: current.nextPage!,
      });
      if (generation.current !== at) return;
      setTheirs({
        kind: "ready",
        q: current.q,
        cards: [...current.cards, ...page.cards],
        nextPage: page.next_page,
        more: "idle",
      });
    } catch (cause) {
      if (generation.current !== at) return;
      if (cause instanceof SocialError && cause.status === 404) {
        setTheirs({ kind: "missing" });
        return;
      }
      setTheirs({ ...current, more: "failed" });
    }
  }

  // Any change makes a new send key: a send is the same only when the proposal is.
  function change(next: (p: Proposal) => Proposal) {
    edited.current = true;
    setProposal(next);
    key.current = null;
  }

  // A cash change is an edit like a card: it makes a new send key.
  function editCash(next: CashDraft) {
    edited.current = true;
    key.current = null;
    setCash(next);
  }

  // The same words twice are announced twice: the line is cleared first, then set a moment later.
  const announceTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);
  function say(text: string) {
    window.clearTimeout(announceTimer.current);
    setAnnounce("");
    announceTimer.current = window.setTimeout(() => setAnnounce(text), 60);
  }

  function add(side: ProposalSide, libraryCard: LibraryCard) {
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

  async function sendCounter(
    target: TradeView,
    current: Proposal,
    name: string,
    cashBody: { cents: string; payer: "you" | "them" } | null
  ) {
    try {
      key.current ??= crypto.randomUUID();
      const trade = await counterTrade(target.id, {
        revision: revision.current,
        idempotency_key: key.current,
        you_give: requestLines(current.give),
        you_get: requestLines(current.get),
        cash: cashBody,
      });
      sent.current = true;
      toast.show({ message: `Counter sent to ${name}` });
      refreshInbox();
      if (mounted.current) onNavigate(tradePath(trade.id));
    } catch (cause) {
      if (!tradeOutcomeUnknown(cause)) key.current = null;
      const other = () =>
        setMessage(
          sendTradeMessage(cause, name, current.give, current.get, "counter")
        );
      if (!(
        cause instanceof TradesError &&
        ["TRADE_CHANGED", "STEP_NOT_ALLOWED", "TRADE_NOT_FOUND"].includes(
          cause.code
        )
      )) {
        other();
        return;
      }
      refreshInbox();
      const settleGone = () => {
        goneRef.current = true;
        setGone(true);
        setMessage(COUNTER_GONE_TEXT);
      };
      try {
        const fresh = await getTrade(target.id);
        if (fresh.state === "proposed" && fresh.actions.includes("counter")) {
          revision.current = fresh.revision;
          setAnswered(fresh);
          setMessage(COUNTER_CHANGED_TEXT);
        } else settleGone();
      } catch (readCause) {
        if (readCause instanceof SocialError && readCause.status === 404)
          settleGone();
        else other();
      }
    }
  }

  async function send() {
    if (busy || !party) return;
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
        await sendCounter(counter, current, name, cashBody);
      } finally {
        sending.current = false;
        setBusy(false);
      }
      return;
    }
    try {
      key.current ??= crypto.randomUUID();
      const trade = await sendTradeProposal({
        recipient_trader_id: party.trader_id,
        you_give: requestLines(current.give),
        you_get: requestLines(current.get),
        cash: cashBody,
        idempotency_key: key.current,
      });
      sent.current = true;
      toast.show({ message: `Trade Proposal sent to ${name}` });
      // Leaving while the send was out is the collector's choice; the Trade is theirs to find in Trades.
      if (mounted.current) onNavigate(tradePath(trade.id));
    } catch (cause) {
      // A refusal is final for this key; an unknown outcome keeps it, so the retry is the same send.
      if (!tradeOutcomeUnknown(cause)) key.current = null;
      setMessage(sendTradeMessage(cause, name, current.give, current.get));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  // The leave guard reads refs only, so it is made once.
  const guard = useMemo<LeaveGuard>(
    () => ({
      blocks: () =>
        !sent.current &&
        !sending.current &&
        reachable.current &&
        !goneRef.current &&
        edited.current &&
        proposalCopies(latest.current) > 0,
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
  const dirty =
    reachable.current &&
    !gone &&
    edited.current &&
    proposalCopies(proposal) > 0;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
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
    ? tradePath(counter.id)
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
  // In counter mode, a Trade of a pair with a conversation links to it (Trading #298).
  const conversationTo = counter?.conversation_id
    ? conversationPath(counter.conversation_id)
    : null;
  const back = counter ? (
    <div className="flex flex-wrap items-center gap-2">
      {backLink}
      {conversationTo && (
        <a href={conversationTo} onClick={go(conversationTo)} className={BACK}>
          {conversationLinkText(counter.other.display_name)}
        </a>
      )}
    </div>
  ) : (
    backLink
  );
  const frameTitle = counter ? "Counter" : "Trade Proposal";
  const frame = (title: string, children: ReactNode) => (
    <main className={FRAME}>
      {back}
      <PageHeader title={title} />
      {children}
    </main>
  );

  if (theirs.kind === "missing")
    return frame(
      frameTitle,
      <p className="m-0 text-body text-text-muted">{UNAVAILABLE_NOTE}</p>
    );
  if (theirs.kind === "failed" && !party)
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
      </p>
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
  const reason = empty
    ? "Add at least one card to either side."
    : unchanged
      ? "Change a card, a quantity or the cash to send a Counter."
      : null;

  const sideSection = (side: ProposalSide) => (
    <ProposalSideSection
      key={side}
      side={side}
      lines={proposal[side]}
      heading={sideHeading[side]}
      total={sideValueText(
        value,
        side === "get" ? "you_get" : "you_give",
        proposal[side].length > 0
      )}
      onChange={(line, quantity) => {
        if (quantity === 0) refocus.current = side;
        change((p) => setQuantity(p, side, line, quantity));
      }}
    />
  );
  const proposalPane = (
    <section aria-label="Proposal" className="flex min-w-0 flex-col gap-4">
      {sideSection("get")}
      {sideSection("give")}
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
            value={cash.amount}
            onChange={(event) =>
              editCash({ ...cash, amount: event.currentTarget.value })
            }
          />
        )}
      </section>
      {cash.payer !== "none" && <LiabilityNotice />}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          className="disabled:opacity-45"
          disabled={empty || gone || unchanged}
          aria-disabled={busy || undefined}
          aria-describedby={reason ? reasonId : undefined}
          onClick={() => void send()}
        >
          {counter ? "Send Counter" : "Send Trade Proposal"}
        </Button>
        {reason && (
          <p id={reasonId} className="m-0 text-meta text-text-muted">
            {reason}
          </p>
        )}
      </div>
      <p role="alert" className="m-0 text-meta text-danger empty:hidden">
        {message}
      </p>
    </section>
  );
  const library = (
    <ProposalLibrary
      headingId={libraryId}
      ownScroll={!phone}
      friendName={name}
      theirs={libraryTheirs}
      mine={mine}
      match={libraryMatch}
      onTheirSearch={setTheirQ}
      onShowMore={() => void showMore()}
      onRetry={(which) => {
        if (which === "theirs") setAttempt((n) => n + 1);
        else if (which === "mine") setMineAttempt((n) => n + 1);
        else setMatchAttempt((n) => n + 1);
      }}
      proposal={proposal}
      onAdd={add}
      announce={announce}
    />
  );

  return (
    <main className={FRAME}>
      {back}
      <PageHeader
        title={counter ? `Counter to ${name}` : `Trade Proposal to ${name}`}
        headingRef={headingRef}
      />
      {phone ? (
        <>
          <Segmented
            label="Proposal builder"
            idBase={idBase}
            panelId={`${idBase}-panel`}
            value={pane}
            onChange={setPane}
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
              : "The cards you added aren't kept."}
          </p>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setAsking(null)}>
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
  onChange,
}: {
  side: ProposalSide;
  lines: ProposalLine[];
  heading: React.RefObject<HTMLHeadingElement | null>;
  /** The side's estimated total, or null when it has no lines. */
  total: string | null;
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
              <li
                key={line.edition_id}
                className="grid grid-cols-[3.5rem_minmax(0,1fr)] phone:grid-cols-[3rem_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
              >
                <CardImage url={line.image_url} />
                <span className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="flex min-w-0 flex-col">
                    <span className="text-body font-semibold wrap-anywhere">
                      {line.name}
                    </span>
                    <span className="text-meta text-text-muted tabular-nums wrap-anywhere">
                      {lineEdition(line)}
                    </span>
                    <span className="text-meta text-text-subtle tabular-nums">
                      Up to {cap}
                    </span>
                  </span>
                  <Stepper
                    label={`${tradeCardName(line)} ${side === "get" ? "you get" : "you give"}`}
                    value={line.quantity}
                    min={0}
                    max={cap}
                    onChange={(value) => onChange(line, value)}
                  />
                </span>
              </li>
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
