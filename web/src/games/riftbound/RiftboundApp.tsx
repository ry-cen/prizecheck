import { DecksView } from "./DecksView";
import type { DeckReader, DeckWriter } from "./decks";
import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, LayoutGrid, Layers } from "lucide-react";
import { Button } from "../../ui/Button";
import { SearchField } from "../../ui/SearchField";
import { Chip, PickerChip } from "../../ui/Chip";
import { Dialog } from "../../ui/Dialog";
import { CardPopup } from "../../ui/CardPopup";
import { Icon } from "../../ui/Icon";
import { ROOT, ART, LINE } from "../../ui/CopyTile";
import { PageHeader } from "../../shell/PageHeader";
import { ScrollArea } from "../../ui/ScrollArea";
import {
  listKey,
  type CatalogReader,
  type Edition,
  type Query,
} from "./catalog";
import { parseView, viewHash, type View } from "./navigation";
import { CollectionView } from "./CollectionView";
import { emptyCollectionQuery, type CollectionReader } from "./collection";
import { ToastProvider } from "../../ui/Toast";
import {
  CollectionWriteDialog,
  useCollectionFeedback,
} from "./CollectionWrites";
import type { CollectionWriter } from "./collection";
import { useRead } from "./read";

export function RiftboundApp(props: {
  reader: CatalogReader;
  collection?: CollectionReader;
  writer?: CollectionWriter;
  decks?: DeckReader & DeckWriter;
}) {
  return (
    <ToastProvider key={props.collection?.owner ?? "catalog"}>
      <RiftboundComposition
        key={props.collection?.owner ?? "catalog"}
        {...props}
      />
    </ToastProvider>
  );
}
function RiftboundComposition({
  reader,
  collection,
  writer,
  decks,
}: {
  reader: CatalogReader;
  collection?: CollectionReader;
  writer?: CollectionWriter;
  decks?: DeckReader & DeckWriter;
}) {
  const [view, setView] = useState(() => parseView(location.hash));
  const [revision, setRevision] = useState(1);
  const [adding, setAdding] = useState<string | null>(null);
  const feedback = useCollectionFeedback(writer, (next) =>
    setRevision((previous) => Math.max(previous, next))
  );
  const addOpener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setAdding(null);
  }, [view]);
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLButtonElement>(null);
  const catalogHeading = useRef<HTMLHeadingElement>(null);
  const homeHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const stepped = useRef(false);
  const pendingDismissal = useRef(false);
  const tiles = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!view.edition) pendingDismissal.current = false;
    if (view.edition || !stepped.current) return;
    stepped.current = false;
    if (opener.current?.isConnected) opener.current.focus();
  }, [view.edition]);

  useEffect(() => {
    const update = () => {
      pendingDismissal.current = false;
      setView(parseView(location.hash));
    };
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  function navigate(next: View, replace = false, detail = false) {
    if (viewHash(next) === viewHash(view)) return;
    history[replace ? "replaceState" : "pushState"](
      { game: reader.scope, ...(detail ? { detail: true } : {}) },
      "",
      viewHash(next)
    );
    setView(next);
  }
  const active =
    !view.home && view.section !== "collection" && view.section !== "decks";
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.scrollPaddingBottom;
    root.style.scrollPaddingBottom =
      "calc(var(--layout-tabbar-height) + var(--target-touch))";
    return () => {
      root.style.scrollPaddingBottom = previous;
    };
  }, []);
  const sets = useRead(
    "riftbound:sets",
    useCallback((signal) => reader.sets(signal), [reader]),
    active
  );
  const listing = useRead(
    listKey(view.query),
    useCallback(
      (signal) => reader.list(view.query, signal),
      [reader, view.query]
    ),
    active
  );
  const detail = useRead(
    "riftbound:edition:" + view.edition,
    useCallback(
      (signal) => reader.detail(view.edition, signal),
      [reader, view.edition]
    ),
    active && !!view.edition
  );
  const rows = listing.value?.editions ?? [];
  const index = rows.findIndex((e) => e.id === view.edition);
  function filter(patch: Partial<Query>) {
    navigate(
      { ...view, query: { ...view.query, ...patch, page: 1 }, edition: "" },
      true
    );
  }
  function open(id: string, element?: HTMLElement) {
    if (element) opener.current = element;
    navigate({ ...view, edition: id }, false, true);
  }
  function step(id: string) {
    const tile = tiles.current?.querySelector<HTMLElement>(
      `[data-edition-id="${CSS.escape(id)}"] button`
    );
    if (tile) opener.current = tile;
    stepped.current = true;
    navigate(
      { ...view, edition: id },
      true,
      history.state?.game === reader.scope && history.state?.detail === true
    );
  }
  function close() {
    if (pendingDismissal.current) return;
    if (
      history.state?.game === reader.scope &&
      history.state?.detail === true
    ) {
      pendingDismissal.current = true;
      history.back();
    } else {
      navigate({ ...view, edition: "" }, true);
    }
  }
  const edition = detail.value;
  return (
    <div className="min-h-dvh bg-bg font-sans text-text phone:pb-[calc(var(--layout-tabbar-height)+var(--target-touch))]">
      <a
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          if (view.section === "decks" && !view.home)
            document
              .querySelector<HTMLElement>("[data-decks-content] h1")
              ?.focus();
          else if (view.section === "collection" && !view.home)
            document
              .querySelector<HTMLElement>("[data-collection-content] h1")
              ?.focus();
          else (view.home ? homeHeading : catalogHeading).current?.focus();
        }}
        className="fixed left-2 top-2 z-(--layer-modal) inline-flex min-h-tap -translate-y-[calc(100%+var(--space-4))] items-center rounded-control border border-control-outline bg-surface-raised px-3 text-body font-semibold text-text no-underline focus:translate-y-0"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-(--layer-sticky) box-border flex h-header items-center gap-6 border-b border-border bg-bg px-7 compact:gap-3 compact:px-4 phone:px-3">
        <Button
          variant="quiet"
          onClick={() => {
            navigate({ ...view, home: true, edition: "" });
          }}
        >
          <span className="whitespace-nowrap text-meta font-bold uppercase tracking-[2px]">
            <span aria-hidden="true" className="mr-2 text-accent">
              ✦
            </span>
            PrizeCheck
          </span>
        </Button>
        <span className="text-meta font-semibold">Riftbound</span>
        <nav aria-label="Main navigation" className="phone:hidden">
          {collection && (
            <Button
              icon={LayoutGrid}
              variant="quiet"
              aria-current={
                !view.home && view.section === "collection" ? "page" : undefined
              }
              onClick={() =>
                navigate({
                  ...view,
                  home: false,
                  section: "collection",
                  edition: "",
                  collection: view.collection ?? emptyCollectionQuery,
                })
              }
            >
              Collection
            </Button>
          )}
          {decks && (
            <Button
              icon={Layers}
              variant="quiet"
              aria-current={
                !view.home && view.section === "decks" ? "page" : undefined
              }
              onClick={() =>
                navigate({
                  ...view,
                  home: false,
                  section: "decks",
                  deck: "",
                  edition: "",
                })
              }
            >
              Decks
            </Button>
          )}
          <Button
            icon={BookOpen}
            variant="quiet"
            aria-current={active ? "page" : undefined}
            onClick={() =>
              navigate({
                ...view,
                home: false,
                section: view.section ? "catalog" : undefined,
              })
            }
          >
            Catalog
          </Button>
        </nav>
      </header>
      {view.home && (
        <main className="px-7 py-7 phone:px-4">
          <PageHeader title="Riftbound" headingRef={homeHeading} />
          <Button
            onClick={() =>
              navigate({
                ...view,
                home: false,
                section: view.section ? "catalog" : undefined,
              })
            }
          >
            Browse Catalog
          </Button>
        </main>
      )}
      <main
        id="content"
        hidden={!active}
        className="mx-auto box-border w-full max-w-7xl min-w-0 px-7 py-7 phone:px-4 phone:py-5 phone:[&_h1]:text-heading"
      >
        <PageHeader title="Catalog" headingRef={catalogHeading} />
        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <SearchField
              label="Search cards"
              placeholder="Search by name or collector number"
              value={view.query.search}
              onChange={(e) => filter({ search: e.target.value })}
            />
            <p className="m-0 text-meta text-text-muted">
              Search by card name or collector number.
            </p>
          </div>
          <ScrollArea
            orientation="x"
            viewportClassName="flex min-w-0 items-center gap-1.5"
            viewportProps={{ role: "group", "aria-label": "Filters" }}
          >
            <Chip
              selected={!view.query.domain}
              onChange={() => filter({ domain: "" })}
            >
              Any domain
            </Chip>
            {["Fury", "Calm"].map((domain) => (
              <Chip
                key={domain}
                selected={view.query.domain === domain}
                onChange={(on) => filter({ domain: on ? domain : "" })}
              >
                {domain}
              </Chip>
            ))}
            <span
              aria-hidden="true"
              className="mx-1 h-4 w-px shrink-0 bg-border"
            />
            {["Unit", "Spell", "Battlefield"].map((type) => (
              <Chip
                key={type}
                selected={view.query.type === type}
                onChange={(on) => filter({ type: on ? type : "" })}
              >
                {type}
              </Chip>
            ))}
            <PickerChip
              active={!!view.query.set}
              buttonRef={picker}
              onClick={() => setPicking(true)}
            >
              {sets.value?.find((s) => s.id === view.query.set)?.name ??
                "Any set"}
            </PickerChip>
          </ScrollArea>
          {listing.failed ? (
            <Failure retry={listing.retry}>Cards couldn't be loaded.</Failure>
          ) : !listing.value ? (
            <p role="status">Loading cards…</p>
          ) : listing.value.catalogEmpty ? (
            <p role="status">No cards in this catalog yet.</p>
          ) : !rows.length ? (
            <div role="status">
              <p>No cards match your search.</p>
              <Button
                onClick={() =>
                  filter({ search: "", set: "", domain: "", type: "" })
                }
              >
                Clear filters
              </Button>
            </div>
          ) : (
            <section
              aria-label="Catalog results"
              className="flex flex-col gap-3"
            >
              <p className="m-0 text-meta text-text-subtle">
                {listing.value.total} Editions · Page {view.query.page} of{" "}
                {listing.value.pages}
              </p>
              <ul
                ref={tiles}
                className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-medium),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0"
              >
                {rows.map((e) => (
                  <li
                    key={`riftbound:edition:${e.id}`}
                    data-edition-id={e.id}
                    className="min-w-0"
                  >
                    <button
                      type="button"
                      className={`${ROOT} w-full`}
                      aria-label={`${e.name}, ${e.set.code} ${e.number}, ${e.finish}`}
                      onClick={(event) => open(e.id, event.currentTarget)}
                    >
                      <span aria-hidden="true" className={`${ART} relative`}>
                        <Art key={e.id} edition={e} />
                      </span>
                      <span
                        aria-hidden="true"
                        className="box-border block h-(--tile-names-height) overflow-hidden pt-1"
                      >
                        <span className={`${LINE} text-caption leading-4`}>
                          {e.name}
                        </span>
                        <span
                          className={`${LINE} text-micro leading-3.5 text-text-subtle`}
                        >
                          {e.set.code} {e.number} · {e.finish}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-3">
                <Button
                  disabled={view.query.page <= 1}
                  onClick={() =>
                    navigate({
                      ...view,
                      query: { ...view.query, page: view.query.page - 1 },
                    })
                  }
                >
                  Previous page
                </Button>
                <Button
                  disabled={view.query.page >= listing.value.pages}
                  onClick={() =>
                    navigate({
                      ...view,
                      query: { ...view.query, page: view.query.page + 1 },
                    })
                  }
                >
                  Next page
                </Button>
              </div>
            </section>
          )}
        </div>
      </main>
      {collection && (
        <CollectionView
          key={collection.owner}
          reader={collection}
          writer={writer}
          revision={revision}
          onConfirmed={feedback}
          active={!view.home && view.section === "collection"}
          query={view.collection ?? emptyCollectionQuery}
          onQuery={(query, replace) =>
            navigate({ ...view, collection: query }, replace)
          }
          onCatalog={() =>
            navigate({ ...view, section: "catalog", home: false })
          }
        />
      )}
      {decks && collection && !view.home && view.section === "decks" && (
        <DecksView
          reader={decks}
          writer={decks}
          catalog={reader}
          collection={collection}
          id={view.deck ?? ""}
          tab={view.deckTab ?? "deck"}
          navigate={(deck, deckTab = "deck") =>
            navigate({ ...view, deck, deckTab })
          }
          confirmed={(next) => setRevision((n) => Math.max(n, next))}
        />
      )}
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-(--layer-sticky) hidden h-tabbar border-t border-border bg-surface phone:flex"
      >
        {collection && (
          <button
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 text-caption font-medium text-text-muted aria-[current=page]:text-accent-strong"
            aria-current={
              !view.home && view.section === "collection" ? "page" : undefined
            }
            onClick={() =>
              navigate({
                ...view,
                home: false,
                section: "collection",
                edition: "",
                collection: view.collection ?? emptyCollectionQuery,
              })
            }
          >
            <Icon icon={LayoutGrid} />
            Collection
          </button>
        )}
        {decks && (
          <button
            className="flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 text-caption font-medium text-text-muted aria-[current=page]:text-accent-strong"
            aria-current={
              !view.home && view.section === "decks" ? "page" : undefined
            }
            onClick={() =>
              navigate({
                ...view,
                home: false,
                section: "decks",
                deck: "",
                edition: "",
              })
            }
          >
            <Icon icon={Layers} />
            Decks
          </button>
        )}
        <button
          className="flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 text-caption font-medium text-text-muted aria-[current=page]:text-accent-strong"
          aria-current={active ? "page" : undefined}
          onClick={() =>
            navigate({
              ...view,
              home: false,
              section: view.section ? "catalog" : undefined,
            })
          }
        >
          <Icon icon={BookOpen} />
          Catalog
        </button>
      </nav>
      <Dialog
        open={picking && active}
        title="Choose a set"
        onClose={() => setPicking(false)}
        returnFocus={picker}
      >
        {sets.failed ? (
          <Failure retry={sets.retry}>Sets couldn't be loaded.</Failure>
        ) : !sets.value ? (
          <p role="status">Loading sets…</p>
        ) : (
          <div className="flex flex-col gap-2">
            <Button
              onClick={() => {
                filter({ set: "" });
                setPicking(false);
              }}
            >
              Any set
            </Button>
            {sets.value.map((s) => (
              <Button
                key={s.id}
                aria-pressed={view.query.set === s.id}
                onClick={() => {
                  filter({ set: s.id });
                  setPicking(false);
                }}
              >
                {s.name}
              </Button>
            ))}
          </div>
        )}
      </Dialog>
      <CardPopup
        open={active && !!view.edition && !adding && !pendingDismissal.current}
        title={edition?.name ?? "Card details"}
        onClose={close}
        returnFocus={opener}
        cardKey={`riftbound:${view.edition}`}
        position={index >= 0 ? { index, total: rows.length } : null}
        canPrevious={index > 0}
        canNext={index >= 0 && index < rows.length - 1}
        onPrevious={() => step(rows[index - 1].id)}
        onNext={() => step(rows[index + 1].id)}
        footer={
          writer && edition ? (
            <Button ref={addOpener} onClick={() => setAdding(viewHash(view))}>
              Add to Collection
            </Button>
          ) : undefined
        }
        art={edition ? <Art key={edition.id} edition={edition} /> : null}
      >
        {detail.failed ? (
          <Failure retry={detail.retry}>
            Card details couldn't be loaded.
          </Failure>
        ) : detail.value === undefined ? (
          <p role="status">Loading card details…</p>
        ) : !edition ? (
          <p role="status">This Edition isn't available.</p>
        ) : (
          <div className="flex flex-col gap-3 text-body">
            <p>
              {edition.set.name} · {edition.number}
            </p>
            <p>{[edition.domain, edition.type].filter(Boolean).join(" · ")}</p>
            <p>{edition.finish}</p>
          </div>
        )}
      </CardPopup>
      {writer &&
        collection &&
        edition &&
        active &&
        adding === viewHash(view) && (
          <CollectionWriteDialog
            key={adding}
            mode="add"
            writer={writer}
            reader={collection}
            edition={edition}
            onClose={() => setAdding(null)}
            onConfirmed={(result, message, undo) => {
              feedback(result, message, undo);
              close();
            }}
            returnFocus={opener}
          />
        )}
    </div>
  );
}
function Failure({
  children,
  retry,
}: {
  children: React.ReactNode;
  retry: () => void;
}) {
  return (
    <div role="alert" className="flex items-center gap-3 text-body">
      <p>{children}</p>
      <Button onClick={retry}>Retry</Button>
    </div>
  );
}
function Art({ edition }: { edition: Edition }) {
  const [broken, setBroken] = useState(false);
  return edition.art && !broken ? (
    <img
      src={edition.art}
      alt={`${edition.name} card art`}
      onError={() => setBroken(true)}
      className={`block w-full rounded-card object-contain ${edition.orientation === "landscape" ? "aspect-[7/5]" : "aspect-(--tile-aspect)"}`}
    />
  ) : (
    <span
      role="img"
      aria-label={`Artwork unavailable for ${edition.name}`}
      className="flex aspect-(--tile-aspect) w-full items-center justify-center rounded-card bg-surface-raised p-2 text-center text-caption text-text-muted"
    >
      Artwork unavailable
    </span>
  );
}
