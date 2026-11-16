import { Segmented, segmentId } from "../../ui/Segmented";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../ui/Button";
import { TextField } from "../../ui/TextField";
import { Dialog } from "../../ui/Dialog";
import { ROOT, ART } from "../../ui/CopyTile";
import { type CatalogReader, type Edition, emptyQuery } from "./catalog";
import type { CollectionReader } from "./collection";
import {
  DeckError,
  deckKey,
  type DeckDetail,
  type DeckReader,
  type DeckWriter,
} from "./decks";
import { DeckEdits } from "./deckEdits";
import { useRead } from "./read";
function Art({ edition }: { edition: Edition }) {
  return (
    <span className={`${ART} relative block`}>
      {edition.art ? (
        <img
          src={edition.art}
          alt=""
          className="h-full w-full object-contain"
        />
      ) : (
        <span
          aria-label={`Artwork unavailable for ${edition.name}`}
          className="flex h-full items-center justify-center p-2 text-caption text-text-muted"
        >
          Artwork unavailable
        </span>
      )}
    </span>
  );
}
export function DecksView({
  reader,
  writer,
  catalog,
  collection,
  inventoryRevision,
  id,
  tab,
  navigate,
  confirmed,
}: {
  reader: DeckReader;
  writer: DeckWriter;
  catalog: CatalogReader;
  collection: CollectionReader;
  inventoryRevision: number;
  id: string;
  tab: string;
  navigate: (id: string, tab?: string) => void;
  confirmed: (revision: number) => void;
}) {
  const [epoch, bump] = useState(0);
  const [create, setCreate] = useState(false);
  const [name, setName] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const listing = useRead(
    deckKey(reader.owner) + epoch,
    useCallback((s) => reader.decks(s), [reader, epoch, inventoryRevision]),
    !id
  );
  const detail = useRead(
    deckKey(reader.owner, id) + epoch,
    useCallback(
      (s) => reader.deck(id, s),
      [reader, id, epoch, inventoryRevision]
    ),
    !!id
  );
  useEffect(() => {
    heading.current?.focus();
  }, [id, tab, detail.value !== undefined]);
  return (
    <main
      data-decks-content
      className="mx-auto box-border w-full max-w-7xl px-7 py-7 phone:px-4 phone:pb-24"
    >
      {id ? (
        <>
          <Button variant="quiet" onClick={() => navigate("")}>
            ‹ All Decks
          </Button>
          {detail.failed ? (
            <Failure retry={detail.retry} />
          ) : detail.value === null ? (
            <>
              <h1 ref={heading} tabIndex={-1}>
                This Deck isn't available
              </h1>
              <a
                href="#riftbound:section=decks"
                onClick={(event) => {
                  event.preventDefault();
                  navigate("");
                }}
              >
                All Decks
              </a>
            </>
          ) : !detail.value ? (
            <p role="status">Loading Deck…</p>
          ) : (
            <Editor
              key={id}
              initial={detail.value}
              reader={reader}
              writer={writer}
              catalog={catalog}
              collection={collection}
              tab={tab}
              onTab={(t) => navigate(id, t)}
              heading={heading}
              onChanged={(revision) => {
                confirmed(revision);
              }}
              onDeleted={(revision) => {
                confirmed(revision);
                navigate("");
                bump((n) => n + 1);
              }}
            />
          )}
        </>
      ) : (
        <>
          <h1
            ref={heading}
            tabIndex={-1}
            className="m-0 mb-6 text-display font-semibold"
          >
            Decks
          </h1>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
            <h2 className="m-0 text-heading font-semibold">Your Decks</h2>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setCreate(true);
              }}
            >
              <TextField
                label="Deck name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                Create Deck
              </Button>
            </form>
          </div>
          {listing.failed ? (
            <Failure retry={listing.retry} />
          ) : !listing.value ? (
            <p role="status">Loading Decks…</p>
          ) : !listing.value.length ? (
            <p>No Decks yet. Create your first Deck.</p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,232px)] gap-4 p-0 phone:grid-cols-2">
              {listing.value.map((deck) => (
                <li key={deck.id}>
                  <button
                    className="flex w-full cursor-pointer gap-3 overflow-hidden rounded-card border border-border bg-surface p-3 text-left text-text phone:flex-col"
                    onClick={() => navigate(deck.id, "deck")}
                  >
                    <span
                      aria-hidden="true"
                      className="flex h-24 w-16 shrink-0 items-center justify-center rounded-card bg-surface-raised text-text-muted phone:aspect-[5/7] phone:h-auto phone:w-full"
                    >
                      ◇
                    </span>
                    <span className="block min-w-0">
                      <strong className="block text-body">{deck.name}</strong>
                      <span className="text-meta text-text-muted">
                        {deck.cardCount} cards in this Deck
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {create && (
            <DeckCommand
              title="Create Deck"
              initialName={name}
              send={(value, options) =>
                writer.createDeck({ name: value }, options)
              }
              close={() => setCreate(false)}
              done={(result) => {
                setCreate(false);
                setName("");
                confirmed(result.ownerRevision);
                bump((n) => n + 1);
              }}
            />
          )}
        </>
      )}
    </main>
  );
}
function Failure({ retry }: { retry: () => void }) {
  return (
    <div role="alert">
      <p>Decks couldn't be loaded.</p>
      <Button onClick={retry}>Retry</Button>
    </div>
  );
}
function Editor({
  initial,
  reader,
  writer,
  catalog,
  collection,
  tab,
  onTab,
  heading,
  onChanged,
  onDeleted,
}: {
  initial: DeckDetail;
  reader: DeckReader;
  writer: DeckWriter;
  catalog: CatalogReader;
  collection: CollectionReader;
  tab: string;
  onTab: (tab: string) => void;
  heading: React.RefObject<HTMLHeadingElement | null>;
  onChanged: (revision: number) => void;
  onDeleted: (revision: number) => void;
}) {
  const [, render] = useState(0);
  const [edits] = useState(
    () => new DeckEdits(initial, writer, () => render((n) => n + 1))
  );
  useEffect(() => {
    edits.acceptRead(initial);
  }, [edits, initial]);
  useEffect(() => {
    edits.reload = (s) => reader.deck(initial.location.id, s);
    return () => edits.dispose();
  }, [edits, reader, initial.location.id]);
  const detail = edits.detail;
  const [command, setCommand] = useState<{
    kind: "rename" | "delete";
    tab: string;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setSelected(null);
    setCommand(null);
  }, [tab]);
  const opener = useRef<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const library = useRead(
    JSON.stringify(["riftbound", reader.owner, "library", search, page]),
    useCallback(
      (s) => catalog.list({ ...emptyQuery, search, page }, s),
      [catalog, search, page]
    ),
    tab === "library"
  );
  const holdings = useRead(
    JSON.stringify(["riftbound", reader.owner, "deck-copies", selected]),
    useCallback(
      (s) => collection.holdings(selected!, s),
      [collection, selected]
    ),
    !!selected
  );
  const places = useRead(
    JSON.stringify(["riftbound", reader.owner, "deck-locations"]),
    useCallback((s) => collection.locations(s), [collection])
  );
  const line =
    tab === "library"
      ? undefined
      : detail.lines.find((l) => l.edition.id === selected);
  useEffect(() => {
    if (
      selected &&
      !detail.lines.some((line) => line.edition.id === selected)
    ) {
      setSelected(null);
      heading.current?.focus();
    }
  }, [selected, detail.lines, heading]);
  const count = detail.lines.reduce(
    (n, l) => n + edits.quantity(l.edition.id),
    0
  );
  return (
    <>
      <div className="my-4 flex flex-wrap items-center justify-between gap-3">
        <h1
          ref={heading}
          tabIndex={-1}
          className="m-0 text-display font-semibold"
        >
          {detail.location.name}
        </h1>
        <div className="flex gap-2">
          <Button onClick={() => setCommand({ kind: "rename", tab })}>
            Rename
          </Button>
          <Button
            variant="danger"
            onClick={() => setCommand({ kind: "delete", tab })}
          >
            Delete
          </Button>
        </div>
      </div>
      <div className="mb-5 border-b border-border pb-3">
        <Segmented
          label="Deck editor"
          idBase="riftbound-editor"
          panelId="riftbound-editor-panel"
          value={tab === "library" ? "library" : "deck"}
          onChange={onTab}
          options={[
            { value: "library", label: "Library" },
            { value: "deck", label: "Deck", count },
          ]}
        />
      </div>
      {edits.error && !line && (
        <div role="alert" className="mb-4">
          <p>{edits.error}</p>
          {edits.canRetry && (
            <Button onClick={() => edits.retry()}>Retry</Button>
          )}
        </div>
      )}
      {edits.busy && !edits.error && !line && (
        <p role="status">Saving changes…</p>
      )}
      {tab === "library" ? (
        <section
          role="tabpanel"
          id="riftbound-editor-panel"
          aria-labelledby={segmentId("riftbound-editor", "library")}
          className="rounded-card border border-border bg-surface p-4"
        >
          <h2 className="mt-0 text-heading font-semibold">Library</h2>
          <TextField
            label="Search cards"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          {library.failed ? (
            <Failure retry={library.retry} />
          ) : !library.value ? (
            <p role="status">Loading cards…</p>
          ) : (
            <>
              <ul className="my-5 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-small),1fr))] gap-3 p-0">
                {library.value.editions.map((e) => (
                  <li key={e.id} className="min-w-0">
                    <div className={ROOT}>
                      <Art edition={e} />
                    </div>
                    <strong className="block text-caption">{e.name}</strong>
                    <p className="m-0 text-micro text-text-muted">
                      {e.set.code} {e.number} · {e.finish}
                    </p>
                    <Button
                      aria-label={`Add ${e.name} ${e.finish}`}
                      onClick={() => edits.adjust(e.id, 1)}
                    >
                      + Add
                    </Button>
                  </li>
                ))}
              </ul>
              {!library.value.editions.length && (
                <p>No cards match your search.</p>
              )}
              <div className="flex gap-2">
                <Button
                  disabled={page <= 1}
                  onClick={() => setPage((n) => n - 1)}
                >
                  Previous page
                </Button>
                <Button
                  disabled={page >= library.value.pages}
                  onClick={() => setPage((n) => n + 1)}
                >
                  Next page
                </Button>
              </div>
            </>
          )}
        </section>
      ) : (
        <section
          role="tabpanel"
          id="riftbound-editor-panel"
          aria-labelledby={segmentId("riftbound-editor", "deck")}
        >
          <p className="text-heading">{count} cards</p>
          <p className="text-meta">
            In this Deck {detail.lines.reduce((n, l) => n + l.inDeck, 0)} ·
            Owned elsewhere {detail.lines.reduce((n, l) => n + l.elsewhere, 0)}{" "}
            · Not owned {detail.lines.reduce((n, l) => n + l.notOwned, 0)}
          </p>
          <h2 className="mb-3 mt-6 text-heading font-semibold">Deck List</h2>
          <p className="text-meta text-text-muted">
            ✓ In this Deck · ↻ Owned elsewhere · ○ Not owned
          </p>
          {!detail.lines.length ? (
            <p>This Deck is empty. Add cards from the Library.</p>
          ) : (
            <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-small),1fr))] gap-3 p-0">
              {detail.lines.map((l) => (
                <li key={l.edition.id}>
                  <button
                    aria-label={`Edit ${l.edition.name} ${l.edition.finish}`}
                    className={`${ROOT} w-full cursor-pointer text-left text-text`}
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setSelected(l.edition.id);
                    }}
                  >
                    <Art edition={l.edition} />
                    <span className="block p-2 text-caption">
                      <strong>{l.edition.name}</strong>
                      <span className="block">
                        {l.edition.set.code} {l.edition.number} ·{" "}
                        {l.edition.finish}
                      </span>
                      <span className="block">
                        {edits.quantity(l.edition.id)} on Deck List
                      </span>
                      <span className="block">
                        ✓ {l.inDeck} · ↻ {l.elsewhere} · ○ {l.notOwned}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {line && (
        <Dialog
          open
          title={line.edition.name}
          onClose={() => setSelected(null)}
          returnFocus={opener}
        >
          <div className="mb-4 flex gap-4">
            <div className="w-24 shrink-0">
              <Art edition={line.edition} />
            </div>
            <p>
              {line.edition.set.name} · {line.edition.number} ·{" "}
              {line.edition.finish}
            </p>
          </div>
          {edits.error && (
            <div role="alert">
              <p>{edits.error}</p>
              {edits.canRetry && (
                <Button onClick={() => edits.retry()}>Retry</Button>
              )}
            </div>
          )}
          {edits.busy && !edits.error && <p role="status">Saving changes…</p>}
          <strong>{edits.quantity(line.edition.id)} on the Deck List</strong>
          <p>{line.inDeck} in this Deck</p>
          <p>{line.elsewhere} owned elsewhere</p>
          {holdings.failed || places.failed ? (
            <p>Locations couldn't be loaded.</p>
          ) : !holdings.value || !places.value ? (
            <p>Loading Locations…</p>
          ) : (
            holdings.value.map((r) => (
              <p key={r.locationId} className="ml-4 text-meta text-text-muted">
                {r.quantity} in{" "}
                {places.value?.find((n) => n.id === r.locationId)?.name}
              </p>
            ))
          )}
          <p>{line.notOwned} not owned</p>
          <div className="flex items-center gap-3">
            <Button
              aria-label="Decrease quantity"
              disabled={!edits.quantity(line.edition.id)}
              onClick={() => edits.adjust(line.edition.id, -1)}
            >
              −1
            </Button>
            <span>{edits.quantity(line.edition.id)} on Deck List</span>
            <Button
              aria-label="Increase quantity"
              onClick={() => edits.adjust(line.edition.id, 1)}
            >
              +1
            </Button>
          </div>
        </Dialog>
      )}
      {command && command.tab === tab && (
        <DeckCommand
          key={`${command.kind}:${detail.location.version}`}
          title={command.kind === "rename" ? "Rename Deck" : "Delete Deck"}
          initialName={command.kind === "rename" ? detail.location.name : ""}
          confirmName={
            command.kind === "delete" ? detail.location.name : undefined
          }
          close={() => setCommand(null)}
          send={(name, options) =>
            command.kind === "rename"
              ? writer.renameDeck(
                  {
                    id: detail.location.id,
                    name,
                    version: detail.location.version,
                  },
                  options
                )
              : writer.deleteDeck(
                  {
                    id: detail.location.id,
                    confirmName: name,
                    version: detail.location.version,
                  },
                  options
                )
          }
          done={(r) => {
            if (r.location) edits.acceptLocation(r.location);
            setCommand(null);
            (command.kind === "delete" ? onDeleted : onChanged)(
              r.ownerRevision
            );
          }}
        />
      )}
    </>
  );
}
function DeckCommand({
  title,
  initialName,
  confirmName,
  send,
  close,
  done,
}: {
  title: string;
  initialName: string;
  confirmName?: string;
  send: (
    name: string,
    options: { signal: AbortSignal; idempotencyKey: string }
  ) => Promise<{ ownerRevision: number; location?: DeckDetail["location"] }>;
  close: () => void;
  done: (r: {
    ownerRevision: number;
    location?: DeckDetail["location"];
  }) => void;
}) {
  const [name, setName] = useState(initialName),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const lifetime = useRef({ alive: true, controller: new AbortController() });
  const attempt = useRef<{ name: string; key: string } | null>(null);
  const guard = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const [focusName, requestNameFocus] = useState(0);
  useEffect(() => {
    if (focusName && !busy) {
      nameField.current?.focus();
      nameField.current?.select();
    }
  }, [focusName, busy]);
  useEffect(() => {
    const run = lifetime.current;
    return () => {
      run.alive = false;
      run.controller.abort();
    };
  }, []);
  async function save() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    attempt.current ??= { name, key: crypto.randomUUID() };
    try {
      const r = await send(attempt.current.name, {
        signal: lifetime.current.controller.signal,
        idempotencyKey: attempt.current.key,
      });
      if (lifetime.current.alive) done(r);
    } catch (e) {
      if (lifetime.current.alive) {
        if (
          e instanceof DeckError &&
          e.code !== "STALE_LOCATION" &&
          e.code !== "IDEMPOTENCY_KEY_REUSED"
        ) {
          attempt.current = null;
          requestNameFocus((n) => n + 1);
        }
        setError(
          e instanceof DeckError
            ? ((
                {
                  INVALID_LOCATION_NAME:
                    "Choose a name between 1 and 120 characters.",
                  LOCATION_NAME_CONFLICT:
                    "A Location with this name already exists.",
                  STALE_LOCATION:
                    "This Deck changed. Close this dialog and reload before trying again.",
                  LOCATION_NAME_CONFIRMATION_MISMATCH:
                    "Type the Deck name exactly.",
                } as Partial<Record<string, string>>
              )[e.code] ?? "Unable to save this change. Retry.")
            : "Unable to save this change. Retry."
        );
      }
    } finally {
      guard.current = false;
      if (lifetime.current.alive) setBusy(false);
    }
  }
  return (
    <Dialog open title={title} onClose={close}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        {confirmName && (
          <p>
            Its cards return to Unsorted. Type {confirmName} exactly to delete
            this Deck.
          </p>
        )}
        <TextField
          label="Deck name"
          value={name}
          disabled={busy || !!attempt.current}
          ref={nameField}
          onChange={(e) => {
            setName(e.target.value);
            setError("");
          }}
        />
        {error && <p role="alert">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button onClick={close}>Cancel</Button>
          <Button
            variant={confirmName ? "danger" : "primary"}
            type="submit"
            disabled={
              busy ||
              !name.trim() ||
              (confirmName !== undefined && name !== confirmName)
            }
          >
            {busy ? "Saving…" : error && attempt.current ? "Retry" : title}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
