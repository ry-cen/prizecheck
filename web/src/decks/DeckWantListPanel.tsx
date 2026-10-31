import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { COUNTING_OPTIONS } from "../settings/wantListCounting";
import type { FriendCopy } from "../social_generated";
import { useFriendMatches } from "../social/useFriendMatches";
import { Button } from "../ui/Button";
import { Icon } from "../ui/Icon";
import { getWantList, type WantList } from "../want_list_generated";
import { announceDeckListChanged } from "./deckListChanged";
import { useTradeWants } from "./useTradeWants";
import { useWantListCost, WantListCostContext } from "./WantListCost";
import { NeededLines } from "./WantListView";
import { useWantListSwap } from "./useWantListSwap";
import { usePendingLoans } from "./usePendingLoans";

const NO_COPIES = new Map<string, FriendCopy[]>();

/**
 * The deck builder's Ways to get missing cards (finish-deck flow): this Deck's section of the Want List
 * (GET /api/want-list?deck=<id>) inside the Deck List, with the Want List's own controls reused (`NeededLines`): Swap
 * with Undo, Friend chips with Ask (a new Borrow Request draft is For this Deck), Will accept, and each line's cost.
 * Its "N of M" counts are the Want List's, under the counting setting it names, which can differ from the readiness
 * counts' "not owned". Buy missing and the Want List button stay in row 1; the panel adds no buy or export control.
 *
 * The toggle shows while any copy is missing from this Deck. Nothing is read until it first opens; from then on the
 * panel stays mounted, collapsed or not and even once the Deck is complete, so a Swap's Undo toast lives as long as the
 * builder does (the builder is keyed by Deck, so leaving it ends the Undo, as it ends the builder's own).
 *
 * It reads again whenever the builder's Deck read moves one of the pins the Want List's answer depends on (`pins`: the
 * Deck List revision, the owner revision and the settings revision), and after a Will accept change. A Swap or its
 * Undo also tells the builder (`announceDeckListChanged`), which reads the Deck again, so both follow the same state.
 * While a read is in flight the previous answer stays, marked busy; the server refuses a Swap made on an older Deck
 * List revision.
 */
export function DeckWantListPanel({
  deckId,
  pins,
  missing,
}: {
  deckId: string;
  /** The builder's Deck read pins, joined: a change reads the Want List again. */
  pins: string;
  /** Whether any copy is missing from this Deck: the toggle shows only then, unless the panel was opened. */
  missing: boolean;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  if (!missing && !opened) return null;
  return (
    // The toggle's label wraps rather than overflow on a narrow phone or with larger text: the kit's Button keeps one
    // line at a fixed height, so its height becomes a minimum here (as the Decks index does for its pills).
    <div className="flex min-w-0 flex-col gap-2 [&>button]:h-auto [&>button]:min-h-control [&>button]:max-w-full [&>button]:py-1 [&>button]:text-left [&>button]:whitespace-normal phone:[&>button]:min-h-control-phone">
      <Button
        className="self-start"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          setOpen(!open);
          setOpened(true);
        }}
      >
        Ways to get missing cards
        <Icon icon={ChevronDown} className={open ? "rotate-180" : undefined} />
      </Button>
      <div
        id={panelId}
        role="region"
        aria-label="Ways to get missing cards"
        hidden={!open}
        className="rounded-panel border border-border bg-surface"
      >
        {opened && <PanelBody deckId={deckId} pins={pins} />}
      </div>
    </div>
  );
}

/** A read's answer, tagged with the Deck it was asked for; `fresh` is false while a newer read is in flight. */
type Load =
  | { kind: "loading" }
  | { kind: "ready"; list: WantList; fresh: boolean }
  | { kind: "failed" };

function PanelBody({ deckId, pins }: { deckId: string; pins: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState("");
  const reload = () => setAttempt((n) => n + 1);
  // Only this Deck's answer is ever used.
  const list =
    load.kind === "ready" && load.list.deck_id === deckId ? load.list : null;
  const cost = useWantListCost(list, reload);
  const swap = useWantListSwap({
    list,
    failed: load.kind === "failed",
    // A Swap or its Undo changed the Deck List: read again, and the builder reads the Deck again.
    reload: () => {
      reload();
      announceDeckListChanged(deckId);
    },
    notify: setNotice,
  });
  const friends = useFriendMatches(list, attempt);
  const trade = useTradeWants(reload);
  // What this Deck is waiting on from Friends, read apart from the Want List, so a refresh reads no cost again. The
  // builder's pins (Deck List, owner and settings revisions) read it again whenever they read the Want List again.
  const pending = usePendingLoans(deckId, pins);

  useEffect(() => {
    const controller = new AbortController();
    setLoad((previous) =>
      previous.kind === "ready" && previous.list.deck_id === deckId
        ? { ...previous, fresh: false }
        : { kind: "loading" }
    );
    getWantList(deckId, controller.signal)
      .then((answer) => {
        // An aborted read's answer belongs to an older Deck or pin set.
        if (!controller.signal.aborted)
          setLoad({ kind: "ready", list: answer, fresh: true });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      });
    return () => controller.abort();
  }, [deckId, pins, attempt]);

  if (load.kind === "failed")
    return (
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <p role="status" className="m-0 text-body text-text-muted">
          What this Deck needs couldn't be loaded.
        </p>
        <Button onClick={reload}>Retry</Button>
      </div>
    );
  if (!list || load.kind !== "ready")
    return (
      <p role="status" className="m-0 px-4 py-3 text-body text-text-muted">
        Loading what this Deck needs…
      </p>
    );

  const section = list.sections.find((each) => each.deck_id === deckId);
  const names = new Map(list.decks.map((deck) => [deck.id, deck.name]));
  const deckName = (id: string) => names.get(id) ?? "another Deck";
  const counting = COUNTING_OPTIONS.find(
    (option) => option.value === list.want_list_counting
  )!;
  const byCard = friends.kind === "ready" ? friends.byCard : NO_COPIES;
  return (
    <WantListCostContext.Provider value={cost}>
      <div aria-busy={!load.fresh}>
        <p className="m-0 px-4 py-3 text-meta text-text-muted">
          Counted as{" "}
          <strong className="font-semibold text-text">{counting.label}</strong>.{" "}
          {counting.explainer}
        </p>
        <p
          role="status"
          className="m-0 px-4 pb-3 text-body text-warning empty:sr-only"
        >
          {notice}
        </p>
        {!section || section.lines.length === 0 ? (
          <p className="m-0 border-t border-border px-4 py-3 text-body text-text-muted">
            Nothing to get, counted as {counting.label}.
          </p>
        ) : (
          <NeededLines
            section={section}
            deckName={deckName}
            swap={swap}
            byCard={byCard}
            trade={trade}
            borrowFor={deckId}
            pending={pending}
          />
        )}
      </div>
    </WantListCostContext.Provider>
  );
}
