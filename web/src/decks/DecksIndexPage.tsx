import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  createDeck,
  DeckError,
  getDecks,
  type DeckIndexEntry,
} from "../decks_generated";
import { getDeckFormatChecks } from "../format_checks_generated";
import type { FormatCheck } from "../format_checks_generated";
import { getDeckCost } from "../prices_generated";
import type { DeckCostFigures } from "../prices_generated";
import {
  getOwnedPublications,
  PublicationError,
  revokePublication,
  setPublishedDeckVisibility,
  type OwnedPublication,
} from "../publications_generated";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { TextField } from "../ui/TextField";
import { getWantList } from "../want_list_generated";
import { figureText } from "./DeckCostLine";
import { visibilityText } from "./publication";
import { RevokeControl } from "./RevokeControl";
import { formatLabel, statusOf } from "./targetFormat";
import { cards } from "./wantListModel";
import { costText } from "./WantListCost";

type Props = {
  /** Opens a Deck in the deck builder (/decks/<id>). */
  onOpenDeck: (id: string) => void;
  /** Goes to another address in the app (Import a list). */
  onNavigate: (to: string) => void;
  /** Opens the Want List scoped to one Deck (/decks/want-list?deck=<id>). */
  onWantList: (id: string) => void;
};

/** What a row reads on its own: the Target Format result and the cost to complete. */
type Facts = {
  result?: FormatCheck | "unavailable";
  toComplete?: DeckCostFigures | "unavailable";
};

// The cost route is a price access with an interactive cap of two per caller (docs/price-refresh.md), so rows read
// their facts two at a time, top first.
const AT_ONCE = 2;
const COST_TIMEOUT_MS = 3_500;

const UNAVAILABLE = "Decks are temporarily unavailable. Please retry.";
const LINK =
  "inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * The Decks index, the My Decks view of the Decks page (/decks, DecksPage) on the kit (#181): create a Deck, and every
 * Deck with how many of its Deck List's copies it holds ("41/60 in Deck"), its cost to complete and one Target Format
 * Pill. Each row reads its result and its cost on its own (the Deck's format-checks and cost routes), two rows at a
 * time. Each row also has "Want List: N cards", which opens the Want List scoped to that Deck, or "Nothing to get"; N
 * comes from one Want List read for the whole page (#209), the same allocation as the cost to complete, and a row
 * shows neither until that read answers. Below, **Published Decks** lists every publication, those whose Deck was
 * deleted included, with Make Listed or Unlisted and Revoke. Import a list, beside Create Deck, opens /decks/import
 * (#212). Opening a Deck shows the deck builder at /decks/<id> (#176).
 */
export function DecksIndexPage({ onOpenDeck, onNavigate, onWantList }: Props) {
  const idBase = useId();
  const [decks, setDecks] = useState<DeckIndexEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [facts, setFacts] = useState<Record<string, Facts>>({});
  // Each Deck's need, by Deck id, from one Want List read; null until it answers, and for good if it fails.
  const [needs, setNeeds] = useState<Map<string, string> | null>(null);
  const queued = useRef(new Set<string>());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formMessage, setFormMessage] = useState("");
  const pending = useRef<{ name: string; key: string } | null>(null);

  // Back from a Deck's builder (/decks/<id>), the index starts at the top: the shell keeps one page's scroll position
  // across its own addresses.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  async function loadIndex() {
    const index = await getDecks();
    setDecks(index.decks);
    setCursor(index.next_cursor);
    setLoaded(true);
  }
  useEffect(() => {
    void loadIndex().catch(() => setNotice(UNAVAILABLE));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    getWantList(null, controller.signal)
      .then((list) =>
        setNeeds(
          new Map(
            list.sections.map((section) => [section.deck_id, section.to_get])
          )
        )
      )
      // Without it the rows still show; only the Want List buttons are missing.
      .catch(() => {});
    return () => controller.abort();
  }, []);

  async function moreDecks() {
    if (!cursor) return;
    try {
      const index = await getDecks(cursor);
      setDecks((previous) => [...previous, ...index.decks]);
      setCursor(index.next_cursor);
    } catch (cause) {
      if (cause instanceof DeckError && cause.code === "INVENTORY_CHANGED") {
        await loadIndex().catch(() => setNotice(UNAVAILABLE));
        setNotice("Decks changed. Showing the first page.");
      } else setNotice(UNAVAILABLE);
    }
  }

  // Each Deck's result and cost to complete, read once per Deck, AT_ONCE Decks at a time in list order.
  useEffect(() => {
    let live = true;
    const waiting = decks.filter((deck) => !queued.current.has(deck.id));
    for (const deck of waiting) queued.current.add(deck.id);
    // A read already started always lands, even after this run is replaced (More Decks): its Deck is never queued again.
    const put = (id: string, next: Facts) =>
      setFacts((previous) => ({
        ...previous,
        [id]: { ...previous[id], ...next },
      }));
    async function readOne(deck: DeckIndexEntry) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COST_TIMEOUT_MS);
      await Promise.all([
        getDeckFormatChecks(deck.id, {}, controller.signal)
          .then((checks) =>
            put(deck.id, {
              result:
                checks.results.find(
                  (result) => result.format === deck.target_format
                ) ?? "unavailable",
            })
          )
          .catch(() => put(deck.id, { result: "unavailable" })),
        getDeckCost(deck.id, controller.signal)
          .then((cost) => put(deck.id, { toComplete: cost.cost_to_complete }))
          .catch(() => put(deck.id, { toComplete: "unavailable" })),
      ]).finally(() => clearTimeout(timer));
    }
    async function worker() {
      for (let next = waiting.shift(); next && live; next = waiting.shift())
        await readOne(next);
    }
    for (let n = 0; n < AT_ONCE; n++) void worker();
    return () => {
      live = false;
      // Decks a cancelled worker never reached are read by the next run.
      for (const deck of waiting) queued.current.delete(deck.id);
    };
  }, [decks]);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setFormMessage("");
    const attempt = pending.current ?? { name, key: crypto.randomUUID() };
    pending.current = attempt;
    try {
      const result = await createDeck({
        name: attempt.name,
        idempotency_key: attempt.key,
      });
      pending.current = null;
      setName("");
      onOpenDeck(result.location.id);
    } catch (cause) {
      if (cause instanceof DeckError && cause.status < 500) {
        pending.current = null;
        setFormMessage(
          cause.code === "LOCATION_NAME_CONFLICT"
            ? "Choose a different Deck name."
            : "Enter a valid Deck name."
        );
      } else
        setFormMessage("Creation may have completed. Retry to check safely.");
    } finally {
      setBusy(false);
    }
  }

  const names = new Map(decks.map((deck) => [deck.id, deck.name]));
  return (
    <>
      <form
        onSubmit={create}
        className="flex flex-wrap items-end gap-2"
        aria-label="New Deck"
      >
        <div className="w-80 max-w-full">
          <TextField
            label="Deck name"
            required
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              pending.current = null;
            }}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          aria-disabled={busy || undefined}
        >
          Create Deck
        </Button>
        <Button onClick={() => onNavigate("/decks/import")}>
          Import a list
        </Button>
        {formMessage && (
          <p role="status" className="m-0 basis-full text-body text-warning">
            {formMessage}
          </p>
        )}
      </form>
      <section
        aria-labelledby={`${idBase}-decks`}
        className="flex flex-col gap-3"
      >
        <h2 id={`${idBase}-decks`} className="m-0 text-heading font-semibold">
          Your Decks
        </h2>
        {loaded && decks.length === 0 ? (
          <p className="m-0 text-body text-text-muted">
            No Decks yet. Name one above to start its Deck List.
          </p>
        ) : (
          <nav aria-label="Deck index">
            <ul className="m-0 flex list-none flex-col p-0">
              {decks.map((deck) => (
                <DeckRow
                  key={deck.id}
                  deck={deck}
                  facts={facts[deck.id] ?? {}}
                  need={needs?.get(deck.id)}
                  onOpen={() => onOpenDeck(deck.id)}
                  onWantList={() => onWantList(deck.id)}
                />
              ))}
            </ul>
          </nav>
        )}
        {cursor && (
          <Button className="self-start" onClick={() => void moreDecks()}>
            More Decks
          </Button>
        )}
        {notice && (
          <p role="status" className="m-0 text-body text-warning">
            {notice}
          </p>
        )}
      </section>
      <PublishedDecks deckNames={names} onOpenDeck={onOpenDeck} />
    </>
  );
}

function DeckRow({
  deck,
  facts,
  need,
  onOpen,
  onWantList,
}: {
  deck: DeckIndexEntry;
  facts: Facts;
  /** The Deck's need on the Want List, or undefined before (or without) the Want List read. */
  need: string | undefined;
  onOpen: () => void;
  onWantList: () => void;
}) {
  const format = formatLabel(deck.target_format);
  const result = facts.result;
  const status =
    result && result !== "unavailable" ? statusOf(result.status) : null;
  return (
    <li className="relative flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-3 last:border-b-0">
      <a
        href={`/decks/${encodeURIComponent(deck.id)}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onOpen();
        }}
        // The whole row is the link's tap area; its accessible name stays the Deck's name.
        className="inline-flex min-h-control min-w-0 items-center text-body font-semibold text-text no-underline wrap-anywhere after:absolute after:inset-0 hover:text-accent-strong phone:min-h-tap"
      >
        {deck.name}
      </a>
      <span className="text-meta tabular-nums text-text-muted">
        {deck.deck_list_total === "0"
          ? "Empty: plan a list"
          : `${deck.in_deck}/${deck.deck_list_total} in Deck`}
      </span>
      <span className="text-meta tabular-nums text-text-muted">
        {facts.toComplete === undefined
          ? "Checking prices…"
          : figureText(
              facts.toComplete === "unavailable" ? undefined : facts.toComplete,
              "to complete"
            )}
      </span>
      <span className="ml-auto">
        <Pill tone={status ? status.tone : "neutral"}>
          {status ? (
            <>
              {format} · <span aria-hidden="true">{status.mark}</span>{" "}
              {status.text}
            </>
          ) : result === "unavailable" ? (
            `${format} · Result unavailable`
          ) : (
            `${format} · Checking…`
          )}
        </Pill>
      </span>
      {need === "0" ? (
        <span className="text-meta text-text-muted">
          <span aria-hidden="true">✓ </span>Nothing to get
        </span>
      ) : need !== undefined ? (
        // Above the row link's full-row tap area.
        <Button className="relative" onClick={onWantList}>
          {`Want List: ${cards(need)}${wantListCost(facts.toComplete, need)}`}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * " · $X" for a Deck card's Want List button (#210): the row's own cost to complete, which is the Deck's Want List section
 * under the same counting (one allocation), so the index reads no other price. Shown only when it counts the same copies
 * as the button and has a price; an unpriced copy reads " + N unpriced", never $0.
 */
function wantListCost(figure: Facts["toComplete"], need: string): string {
  if (!figure || figure === "unavailable" || figure.status !== "priced")
    return "";
  return figure.total_copies === need ? ` · ${costText(figure)}` : "";
}

type PublishedLoad =
  | { kind: "loading" }
  | { kind: "ready"; publications: OwnedPublication[] }
  | { kind: "failed" };

/** Every publication the owner has, those whose Deck was deleted included, with Make Listed or Unlisted and Revoke
 * (token routes, which work whether or not the Deck exists). */
function PublishedDecks({
  deckNames,
  onOpenDeck,
}: {
  deckNames: Map<string, string>;
  onOpenDeck: (id: string) => void;
}) {
  const idBase = useId();
  const [load, setLoad] = useState<PublishedLoad>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const pending = useRef<{ token: string; action: string; key: string } | null>(
    null
  );
  const headingRef = useRef<HTMLHeadingElement>(null);

  async function read() {
    try {
      const owned = await getOwnedPublications();
      // An answer without the list is no answer: the section offers Retry.
      if (!Array.isArray(owned.publications)) throw new Error("no list");
      setLoad({ kind: "ready", publications: owned.publications });
    } catch {
      setLoad((previous) =>
        previous.kind === "ready" ? previous : { kind: "failed" }
      );
    }
  }
  useEffect(() => {
    void read();
  }, []);

  async function act(
    publication: OwnedPublication,
    action: "listed" | "unlisted" | "revoke"
  ) {
    if (busy) return;
    setBusy(publication.token);
    setMessage("");
    const previous = pending.current;
    const attempt =
      previous &&
      previous.token === publication.token &&
      previous.action === action
        ? previous
        : { token: publication.token, action, key: crypto.randomUUID() };
    pending.current = attempt;
    try {
      if (action === "revoke")
        await revokePublication(publication.token, {
          idempotency_key: attempt.key,
        });
      else
        await setPublishedDeckVisibility(publication.token, {
          visibility: action,
          idempotency_key: attempt.key,
        });
      pending.current = null;
      await read();
      // A revoked row unmounts with the focus on it: land on the section heading instead of <body>.
      if (action === "revoke") headingRef.current?.focus();
      setMessage(
        action === "revoke"
          ? `${publication.title}: public link revoked permanently.`
          : `${publication.title} is ${action === "listed" ? "Listed" : "Unlisted"} now.`
      );
    } catch (cause) {
      if (cause instanceof PublicationError && cause.status < 500) {
        pending.current = null;
        await read();
        setMessage(
          "That publication changed somewhere else. The list is up to date now: try again."
        );
      } else
        setMessage(
          "That change hasn't been confirmed. Press the same button again to finish it safely."
        );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      aria-labelledby={`${idBase}-published`}
      className="flex flex-col gap-3"
    >
      <h2
        id={`${idBase}-published`}
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-heading font-semibold outline-none"
      >
        Published Decks
      </h2>
      {load.kind === "loading" ? (
        <p role="status" className="m-0 text-body text-text-muted">
          Loading your Published Decks…
        </p>
      ) : load.kind === "failed" ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="m-0 text-body text-text-muted">
            Your Published Decks couldn't be loaded.
          </p>
          <Button onClick={() => void read()}>Retry</Button>
        </div>
      ) : load.publications.length === 0 ? (
        <p className="m-0 text-body text-text-muted">
          Nothing published yet. Publish a Deck from its page once its Target
          Format result is legal.
        </p>
      ) : (
        <ul
          aria-label="Your Published Decks"
          className="m-0 flex list-none flex-col p-0"
        >
          {load.publications.map((publication) => {
            const deckName = publication.deck_id
              ? deckNames.get(publication.deck_id)
              : null;
            return (
              <li
                key={publication.token}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 last:border-b-0"
              >
                <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-0.5">
                  <p className="m-0 text-body wrap-anywhere">
                    <strong className="font-semibold">
                      {publication.title}
                    </strong>{" "}
                    · {visibilityText(publication.visibility)} · v
                    {publication.version}
                  </p>
                  {publication.deck_id ? (
                    <a
                      href={`/decks/${encodeURIComponent(publication.deck_id)}`}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey)
                          return;
                        event.preventDefault();
                        onOpenDeck(publication.deck_id!);
                      }}
                      className="inline-flex min-h-control items-center self-start text-meta text-text-muted underline wrap-anywhere phone:min-h-tap"
                    >
                      {deckName ? `From ${deckName}` : "Open its Deck"}
                    </a>
                  ) : (
                    <p className="m-0 text-meta text-text-muted">
                      Its Deck was deleted. It stays live until you revoke it.
                    </p>
                  )}
                  {publication.projection_pending && (
                    <p className="m-0 text-meta text-warning">
                      The public copy is catching up. Press the last button
                      again to finish it.
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={`/published/${publication.token}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`View ${publication.title}`}
                    className={LINK}
                  >
                    View
                  </a>
                  <Button
                    aria-label={`${publication.visibility === "listed" ? "Make Unlisted" : "Make Listed"}: ${publication.title}`}
                    aria-disabled={busy !== null || undefined}
                    onClick={() =>
                      void act(
                        publication,
                        publication.visibility === "listed"
                          ? "unlisted"
                          : "listed"
                      )
                    }
                  >
                    {publication.visibility === "listed"
                      ? "Make Unlisted"
                      : "Make Listed"}
                  </Button>
                  <RevokeControl
                    title={publication.title}
                    busy={busy !== null}
                    onRevoke={() => void act(publication, "revoke")}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p role="status" className="m-0 text-body text-text-muted">
        {message}
      </p>
    </section>
  );
}
