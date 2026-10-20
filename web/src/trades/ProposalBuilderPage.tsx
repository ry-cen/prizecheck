import { ChevronLeft } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { lineEdition } from "../loans/loanText";
import { PageHeader } from "../shell/PageHeader";
import { useLeaveGuard, type LeaveGuard } from "../shell/useRoute";
import { CardImage } from "../social/FriendCollectionPage";
import {
  getFriendTradeList,
  getTradeMatch,
  SocialError,
} from "../social_generated";
import { getTradeList, sendTradeProposal } from "../trades_generated";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";
import { Segmented, segmentId } from "../ui/Segmented";
import { Stepper } from "../ui/Stepper";
import { useToast } from "../ui/Toast";
import { MOBILE_QUERY, useMediaQuery } from "../workspace/media";
import { takeFromTradeList, takeProposalSeed } from "./openProposal";
import {
  EMPTY_PROPOSAL,
  proposalCopies,
  quantityIn,
  requestLines,
  seededProposal,
  setQuantity,
  toProposalCard,
  type LibraryCard,
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
import {
  friendTradeListPath,
  TRADE_FIND_PATH,
  tradePath,
} from "./tradeListModel";
import {
  sendTradeMessage,
  tradeCardName,
  tradeOutcomeUnknown,
} from "./tradeText";

type Friend = { collector_id: string; handle: string; display_name: string };

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
 * A Friend's proposal builder (Trading #284), at /trades/new/<Handle>, laid out like the Deck builder. The proposal is
 * the wide left column: **You get** and **You give**, each line with a stepper up to the copies the library offered,
 * and **Send Trade Proposal**. The card library (ProposalLibrary) is the narrow right column. On a phone a Proposal
 * and Cards switch shows one pane at a time, Cards first; both stay mounted.
 *
 * The proposal starts empty (or, from Ask to trade, with one copy of that card in You get) and lives only in this
 * page: nothing is kept, so leaving ends it. Once the collector has changed it, leaving through the shell, a link,
 * the back link or the browser's Back and Forward asks "Discard this proposal to <name>?" (the router's leave guard),
 * and a reload or close shows the browser's own warning. Nothing is asked for a proposal that holds no cards, for one
 * left as it opened, when the Friend didn't load, or after a successful send. A card can't be on both sides; a
 * refused send keeps the proposal and says which card and how many are on the Trade List now. The back link returns
 * to the Friend's Trade List when the builder was opened from it, and to Find trades otherwise.
 */
export function ProposalBuilderPage({
  handle,
  onNavigate,
}: {
  handle: string;
  onNavigate: (to: string) => void;
}) {
  const toast = useToast();
  const idBase = useId();
  const libraryId = useId();
  const phone = useMediaQuery(MOBILE_QUERY);
  const [proposal, setProposal] = useState<Proposal>(() => {
    const card = takeProposalSeed(handle);
    return card ? seededProposal(card) : EMPTY_PROPOSAL;
  });
  const [fromTradeList] = useState(() => takeFromTradeList(handle));
  const [friend, setFriend] = useState<Friend | null>(null);
  const [theirs, setTheirs] = useState<Theirs>({ kind: "loading" });
  const [match, setMatch] = useState<MatchLoad>({ kind: "loading" });
  const [mine, setMine] = useState<MineLoad>({ kind: "loading" });
  const [theirQ, setTheirQ] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [matchAttempt, setMatchAttempt] = useState(0);
  const [mineAttempt, setMineAttempt] = useState(0);
  const [pane, setPane] = useState<Pane>("cards");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [announce, setAnnounce] = useState("");
  const [asking, setAsking] = useState<{ leave: () => void } | null>(null);

  const key = useRef<string | null>(null);
  const sent = useRef(false);
  const edited = useRef(false);
  const latest = useRef(proposal);
  latest.current = proposal;
  // The guard reads these: it is made once. A Friend who is gone (a 404 after load) can't be sent to, so nothing asks.
  const reachable = useRef(false);
  reachable.current = friend !== null && theirs.kind !== "missing";
  const sending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
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

  // The Friend's Trade List, searched on the server; the first answer names the Friend.
  useEffect(() => {
    const controller = new AbortController();
    generation.current++;
    setTheirs((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getFriendTradeList(handle, { q: theirQ }, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setFriend(
          (current) =>
            current ?? {
              collector_id: page.collector_id,
              handle: page.handle,
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
  }, [handle, theirQ, attempt]);

  // The matches with this Friend, listed first in the library.
  const friendId = friend?.collector_id ?? null;
  useEffect(() => {
    if (!friendId) return;
    const controller = new AbortController();
    setMatch({ kind: "loading" });
    getTradeMatch(friendId, controller.signal).then(
      (row) => {
        if (!controller.signal.aborted) setMatch({ kind: "ready", row });
      },
      () => {
        if (!controller.signal.aborted) setMatch({ kind: "failed" });
      }
    );
    return () => controller.abort();
  }, [friendId, matchAttempt]);

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
      const page = await getFriendTradeList(handle, {
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

  async function send() {
    if (busy || !friend) return;
    const current = proposal;
    const name = friend.display_name;
    setBusy(true);
    sending.current = true;
    setMessage("");
    try {
      key.current ??= crypto.randomUUID();
      const trade = await sendTradeProposal({
        recipient_id: friend.collector_id,
        you_give: requestLines(current.give),
        you_get: requestLines(current.get),
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
    reachable.current && edited.current && proposalCopies(proposal) > 0;
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
  const backTo = fromTradeList ? friendTradeListPath(handle) : TRADE_FIND_PATH;
  const back = (
    <a href={backTo} onClick={go(backTo)} className={BACK}>
      <Icon icon={ChevronLeft} />
      {fromTradeList
        ? `${friend?.display_name ?? "Friend"}'s Trade List`
        : "Find trades"}
    </a>
  );
  const frame = (title: string, children: ReactNode) => (
    <main className={FRAME}>
      {back}
      <PageHeader title={title} />
      {children}
    </main>
  );

  if (theirs.kind === "missing")
    return frame(
      "Trade Proposal",
      <p className="m-0 text-body text-text-muted">
        This collector isn't one of your Friends.
      </p>
    );
  if (theirs.kind === "failed" && !friend)
    return frame(
      "Trade Proposal",
      <div className="flex flex-wrap items-center gap-3">
        <p role="alert" className="m-0 text-body text-danger">
          This proposal couldn't be opened. Please retry.
        </p>
        <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
      </div>
    );
  if (!friend)
    return frame(
      "Trade Proposal",
      <p role="status" className="m-0 text-body text-text-muted">
        Loading…
      </p>
    );

  const name = friend.display_name;
  const copies = proposalCopies(proposal);
  const empty = copies === 0;
  const reasonId = `${idBase}-reason`;

  const sideSection = (side: ProposalSide) => (
    <ProposalSideSection
      key={side}
      side={side}
      lines={proposal[side]}
      heading={sideHeading[side]}
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
      {/* #277 adds each side's estimated total and cash here. */}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          disabled={empty}
          aria-disabled={busy || undefined}
          aria-describedby={empty ? reasonId : undefined}
          onClick={() => void send()}
        >
          Send Trade Proposal
        </Button>
        {empty && (
          <p id={reasonId} className="m-0 text-meta text-text-muted">
            Add at least one card to either side.
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
      theirs={theirs.kind === "ready" ? theirs : { kind: theirs.kind }}
      mine={mine}
      match={match}
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
      <PageHeader title={`Trade Proposal to ${name}`} headingRef={headingRef} />
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
        title={`Discard this proposal to ${name}?`}
        closeLabel="Back to the proposal"
        returnFocus={returnTo}
      >
        <div className="flex flex-col gap-4">
          <p className="m-0 text-body">The cards you added aren't kept.</p>
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
  onChange,
}: {
  side: ProposalSide;
  lines: ProposalLine[];
  heading: React.RefObject<HTMLHeadingElement | null>;
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
          <li className="px-4 py-3 text-body text-text-muted">Nothing yet</li>
        ) : (
          lines.map((line) => {
            const cap = Number(line.copies);
            return (
              <li
                key={line.edition_id}
                className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
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
    </section>
  );
}
