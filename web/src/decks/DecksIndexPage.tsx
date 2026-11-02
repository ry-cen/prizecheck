import { timedRead } from "./timedRead";
import { getSettings } from "../settings_generated";
import { useFirstReadSettled, useReadOnShow } from "../shell/keptRead";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
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
import { CopyArt } from "../ui/CopyTile";
import { Pill } from "../ui/Pill";
import { TextField } from "../ui/TextField";
import { figureText } from "./DeckCostLine";
import { visibilityText } from "./publication";
import { RevokeControl } from "./RevokeControl";
import { formatLabel, statusOf } from "./targetFormat";

type Props = {
  active: boolean;
  /** Opens a Deck in the deck builder (/decks/<id>). */
  onOpenDeck: (id: string) => void;
  /** Goes to another address in the app (Import a list). */
  onNavigate: (to: string) => void;
};

/** What a tile reads on its own: the Target Format result and the cost to complete. */
type Facts = {
  result?: FormatCheck | "unavailable";
  toComplete?: DeckCostFigures | "unavailable";
};

// Tiles read their facts AT_ONCE Decks at a time, top first, one request at a
// time per Deck. Each request has its own deadline from when it is sent (timedRead).
const AT_ONCE = 2;

const UNAVAILABLE = "Decks are temporarily unavailable. Please retry.";
const LINK =
  "inline-flex h-control items-center gap-1 rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * The Decks index, the My Decks view of the Decks page (/decks, DecksPage) on the kit (#181): create a Deck, and every
 * Deck as a tile led by its cover card (the collector's pick in the deck builder, or else the line with the most
 * copies) with how many of its Deck List's copies it holds ("41/60 in Deck"), its cost to complete and one Target
 * Format Pill. Each tile reads its result and its cost on its own (the Deck's format-checks and cost routes), two
 * tiles at a time. Below, **Published Decks** lists every publication, those whose Deck was
 * deleted included, with Make Listed or Unlisted and Revoke. Import a list, beside Create Deck, opens /decks/import
 * (#212). Opening a Deck shows the deck builder at /decks/<id> (#176).
 */
export function DecksIndexPage({ active, onOpenDeck, onNavigate }: Props) {
  const idBase = useId();
  const [decks, setDecks] = useState<DeckIndexEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [notice, setNotice] = useState("");
  const [facts, setFacts] = useState<Record<string, Facts>>({});
  const queued = useRef(new Set<string>());
  const quietFacts = useRef(new Set<string>());
  const costRevisions = useRef(
    new Map<
      string,
      { list: number | null; owner: number | null; settings: number | null }
    >()
  );
  const failedCosts = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const listRevisions = useRef(new Map<string, number>());
  const inputs = useRef<{ owner: number | null; settings: number | null }>({
    owner: null,
    settings: null,
  });
  const mounted = useRef(true);
  const refresh = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      mounted.current = false;
      refresh.current?.abort();
    },
    []
  );
  const factGenerations = useRef(new Map<string, number>());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [formMessage, setFormMessage] = useState("");
  const pending = useRef<{ name: string; key: string } | null>(null);

  const generation = useRef(0);
  const paged = useRef(false);
  async function loadIndex(quiet = false) {
    refresh.current?.abort();
    const controller = new AbortController();
    refresh.current = controller;
    const mine = ++generation.current;
    try {
      const [index, settings] = await Promise.all([
        getDecks(),
        quiet ? getSettings() : Promise.resolve(null),
      ]);
      if (mine !== generation.current || controller.signal.aborted) return;
      inputs.current = {
        owner: index.owner_revision,
        settings: settings?.revision ?? inputs.current.settings,
      };
      if (quiet) {
        const waiting = [...index.decks];
        async function check() {
          for (let deck = waiting.shift(); deck; deck = waiting.shift()) {
            try {
              const checks = await timedRead(
                (signal) => getDeckFormatChecks(deck.id, {}, signal),
                controller.signal
              );
              if (mine !== generation.current || controller.signal.aborted)
                return;
              listRevisions.current.set(
                deck.id,
                Math.max(
                  listRevisions.current.get(deck.id) ?? 0,
                  checks.deck_list_revision
                )
              );
              const result =
                checks.results.find(
                  (result) => result.format === deck.target_format
                ) ?? "unavailable";
              setFacts((previous) => ({
                ...previous,
                [deck.id]: { ...previous[deck.id], result },
              }));
            } catch {
              /* A quiet check leaves the previous facts intact. */
            }
            if (mine !== generation.current || controller.signal.aborted)
              return;
            const previous = costRevisions.current.get(deck.id);
            const changed =
              previous &&
              (previous.list !== listRevisions.current.get(deck.id) ||
                previous.owner !== index.owner_revision ||
                previous.settings !== settings?.revision);
            if (
              !inFlight.current.has(deck.id) &&
              (failedCosts.current.has(deck.id) || changed)
            ) {
              queued.current.delete(deck.id);
              quietFacts.current.add(deck.id);
              factGenerations.current.set(
                deck.id,
                (factGenerations.current.get(deck.id) ?? 0) + 1
              );
            }
          }
        }
        await Promise.all(Array.from({ length: AT_ONCE }, check));
        if (mine !== generation.current || controller.signal.aborted) return;
      }
      setDecks(index.decks);
      setCursor(index.next_cursor);
      setLoaded(true);
      setNotice("");
    } catch {
      if (!quiet && mine === generation.current) setNotice(UNAVAILABLE);
    }
  }
  useEffect(() => {
    void loadIndex();
  }, []);
  useFirstReadSettled(loaded || notice === UNAVAILABLE);
  useReadOnShow(
    active,
    !loaded && notice === UNAVAILABLE,
    (quiet) => void loadIndex(quiet),
    paged.current
  );

  // A failed warm tile is independent of the successful index read. First activation retries just those tiles.
  useEffect(() => {
    if (!active || failedCosts.current.size === 0) return;
    for (const id of failedCosts.current) {
      queued.current.delete(id);
      quietFacts.current.add(id);
    }
    setDecks((previous) => [...previous]);
  }, [active]);

  async function moreDecks() {
    if (!cursor) return;
    paged.current = true;
    const mine = ++generation.current;
    try {
      const index = await getDecks(cursor);
      if (mine !== generation.current) return;
      setDecks((previous) => [...previous, ...index.decks]);
      setCursor(index.next_cursor);
    } catch (cause) {
      if (cause instanceof DeckError && cause.code === "INVENTORY_CHANGED") {
        await loadIndex().catch(() => setNotice(UNAVAILABLE));
        setNotice("Decks changed. Showing the first page.");
      } else setNotice(UNAVAILABLE);
    }
  }

  // Cache successful costs by list, inventory and settings revisions; retry failed reads on activation.
  useEffect(() => {
    let live = true;
    const waiting = decks.filter((deck) => !queued.current.has(deck.id));
    for (const deck of waiting) queued.current.add(deck.id);
    // A running read can finish across pagination; a newer facts read supersedes it.
    const put = (id: string, token: number, next: Facts) => {
      if (
        factGenerations.current.get(id) !== token ||
        refresh.current?.signal.aborted
      )
        return;
      setFacts((previous) => ({
        ...previous,
        [id]: { ...previous[id], ...next },
      }));
    };
    async function readOne(deck: DeckIndexEntry) {
      failedCosts.current.delete(deck.id);
      inFlight.current.add(deck.id);
      let stale = false;
      const quiet = quietFacts.current.delete(deck.id);
      const token = (factGenerations.current.get(deck.id) ?? 0) + 1;
      factGenerations.current.set(deck.id, token);
      const activation = refresh.current?.signal;
      try {
        await timedRead(
          (signal) => getDeckFormatChecks(deck.id, {}, signal),
          activation
        )
          .then((checks) => {
            if (factGenerations.current.get(deck.id) !== token) return;
            listRevisions.current.set(
              deck.id,
              Math.max(
                listRevisions.current.get(deck.id) ?? 0,
                checks.deck_list_revision
              )
            );
            put(deck.id, token, {
              result:
                checks.results.find(
                  (result) => result.format === deck.target_format
                ) ?? "unavailable",
            });
          })
          .catch(() => {
            if (!activation?.aborted && !quiet)
              put(deck.id, token, { result: "unavailable" });
          });
        // A format timeout belongs to that request; only supersession or unmount skips the cost.
        if (activation?.aborted) return;
        await timedRead((signal) => getDeckCost(deck.id, signal), activation)
          .then((cost) => {
            if (
              factGenerations.current.get(deck.id) !== token ||
              activation?.aborted
            )
              return;
            if (cost.reason !== null || cost.cost_to_complete.reason !== null) {
              failedCosts.current.add(deck.id);
              if (!quiet)
                put(deck.id, token, { toComplete: cost.cost_to_complete });
              return;
            }
            // Null revisions are permitted by the cost contract. They cannot prove an answer stale;
            // the next activation's input comparison will refresh an unversioned answer once.
            stale =
              (typeof cost.deck_list_revision === "number" &&
                cost.deck_list_revision <
                  (listRevisions.current.get(deck.id) ?? 0)) ||
              (typeof cost.owner_revision === "number" &&
                inputs.current.owner !== null &&
                cost.owner_revision < inputs.current.owner) ||
              (typeof cost.settings_revision === "number" &&
                inputs.current.settings !== null &&
                cost.settings_revision < inputs.current.settings);
            if (stale) return;
            failedCosts.current.delete(deck.id);
            costRevisions.current.set(deck.id, {
              list: cost.deck_list_revision,
              owner: cost.owner_revision,
              settings: cost.settings_revision,
            });
            put(deck.id, token, { toComplete: cost.cost_to_complete });
          })
          .catch(() => {
            if (
              factGenerations.current.get(deck.id) !== token ||
              activation?.aborted
            )
              return;
            failedCosts.current.add(deck.id);
            if (!quiet) put(deck.id, token, { toComplete: "unavailable" });
          });
      } finally {
        if (factGenerations.current.get(deck.id) !== token) return;
        inFlight.current.delete(deck.id);
        if (activation?.aborted && mounted.current) {
          queued.current.delete(deck.id);
          failedCosts.current.add(deck.id);
        }
        if (stale && mounted.current) {
          queued.current.delete(deck.id);
          quietFacts.current.add(deck.id);
          setDecks((previous) => [...previous]);
        }
      }
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
    generation.current++;
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
      <section
        aria-labelledby={`${idBase}-decks`}
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${idBase}-decks`} className="m-0 text-heading font-semibold">
            Your Decks
          </h2>
          <form
            onSubmit={create}
            className="flex min-w-0 flex-wrap items-center gap-2"
            aria-label="New Deck"
          >
            <div className="w-64 max-w-full phone:w-full [&>label]:flex-row [&>label]:items-center [&>label>span]:shrink-0 [&_input]:min-w-0 [&_input]:flex-1">
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
              <p
                role="status"
                className="m-0 basis-full text-body text-warning"
              >
                {formMessage}
              </p>
            )}
          </form>
        </div>
        {loaded && decks.length === 0 ? (
          <p className="m-0 text-body text-text-muted">
            No Decks yet. Name one above to start its Deck List.
          </p>
        ) : (
          <nav aria-label="Deck index">
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(224px,1fr))] gap-4 p-0 phone:grid-cols-2">
              {decks.map((deck) => (
                <DeckTile
                  key={deck.id}
                  deck={deck}
                  facts={facts[deck.id] ?? {}}
                  onOpen={() => onOpenDeck(deck.id)}
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
      <PublishedDecks
        active={active}
        deckNames={names}
        onOpenDeck={onOpenDeck}
      />
    </>
  );
}

function DeckTile({
  deck,
  facts,
  onOpen,
}: {
  deck: DeckIndexEntry;
  facts: Facts;
  onOpen: () => void;
}) {
  const format = formatLabel(deck.target_format);
  const cover = deck.cover ?? null;
  const result = facts.result;
  const status =
    result && result !== "unavailable" ? statusOf(result.status) : null;
  const factsId = useId();
  return (
    // One 12 px step for the tile's inset and between its parts.
    <li className="relative grid min-w-0 grid-cols-[64px_minmax(0,1fr)] content-start gap-3 rounded-card border border-border bg-surface p-3 hover:border-control-outline phone:flex phone:flex-col">
      <CopyArt
        name={cover?.name ?? ""}
        imageUrl={cover?.image_url ?? null}
        className="row-span-3 self-start phone:self-stretch"
      />
      <a
        href={`/decks/${encodeURIComponent(deck.id)}`}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          onOpen();
        }}
        aria-describedby={factsId}
        // The whole tile is the link's tap area, the cover included (decorative). The facts sit inside the link so its
        // phone tap height spans the name and the facts rather than padding the name alone; its accessible name stays
        // the Deck's name and the facts are its description.
        className="group flex min-w-0 flex-col gap-1 no-underline after:absolute after:inset-0 after:rounded-card phone:min-h-tap"
      >
        <span className="text-body font-semibold text-text wrap-anywhere group-hover:text-accent-strong">
          {deck.name}
        </span>
        <span
          id={factsId}
          aria-hidden="true"
          className="flex flex-wrap gap-x-2 gap-y-0.5 text-meta tabular-nums text-text-muted"
        >
          <span>
            {deck.deck_list_total === "0"
              ? "Empty: plan a list"
              : `${deck.in_deck}/${deck.deck_list_total} in Deck`}
          </span>
          <span>
            {facts.toComplete === undefined
              ? "Checking prices…"
              : figureText(
                  facts.toComplete === "unavailable"
                    ? undefined
                    : facts.toComplete,
                  "to complete"
                )}
          </span>
        </span>
      </a>
      <span
        aria-hidden="true"
        className="col-start-2 h-1 overflow-hidden rounded-round bg-border"
      >
        <span
          className="block h-full bg-accent"
          style={{
            width: `${Math.min(100, (Number(deck.in_deck) / Math.max(1, Number(deck.deck_list_total))) * 100)}%`,
          }}
        />
      </span>
      <span className="col-start-2 flex min-w-0 [&>span]:h-auto [&>span]:min-h-6 [&>span]:whitespace-normal [&>span>span]:overflow-visible [&>span>span]:whitespace-normal [&>span>span]:text-clip">
        <Pill tone={status?.tone === "ok" ? "ok" : "neutral"}>
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
    </li>
  );
}

type PublishedLoad =
  | { kind: "loading" }
  | { kind: "ready"; publications: OwnedPublication[] }
  | { kind: "failed" };

/** Every publication the owner has, those whose Deck was deleted included, with Make Listed or Unlisted and Revoke
 * (token routes, which work whether or not the Deck exists). */
function PublishedDecks({
  deckNames,
  active,
  onOpenDeck,
}: {
  active: boolean;
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
  const shown = useRef(active);
  shown.current = active;

  const generation = useRef(0);
  async function read() {
    const mine = ++generation.current;
    try {
      const owned = await getOwnedPublications();
      // An answer without the list is no answer: the section offers Retry.
      if (!Array.isArray(owned.publications)) throw new Error("no list");
      if (mine !== generation.current) return;
      setLoad({ kind: "ready", publications: owned.publications });
    } catch {
      if (mine !== generation.current) return;
      setLoad((previous) =>
        previous.kind === "ready" ? previous : { kind: "failed" }
      );
    }
  }
  useEffect(() => {
    void read();
  }, []);

  useReadOnShow(active, load.kind === "failed", () => void read());

  async function act(
    publication: OwnedPublication,
    action: "listed" | "unlisted" | "revoke"
  ) {
    if (busy) return;
    generation.current++;
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
      if (shown.current && action === "revoke") headingRef.current?.focus();
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
        <p className="m-0 rounded-panel border border-border bg-surface px-5 py-6 text-body text-text-muted">
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
