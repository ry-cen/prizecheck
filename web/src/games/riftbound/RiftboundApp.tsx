import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen } from "lucide-react";
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
import { useRead } from "./read";

export function RiftboundApp({ reader }: { reader: CatalogReader }) {
  const [view, setView] = useState(() => parseView(location.hash));
  const [picking, setPicking] = useState(false);
  const picker = useRef<HTMLButtonElement>(null);
  const catalogHeading = useRef<HTMLHeadingElement>(null);
  const homeHeading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const update = () => setView(parseView(location.hash));
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);
  function navigate(next: View, replace = false) {
    if (viewHash(next) === viewHash(view)) return;
    history[replace ? "replaceState" : "pushState"](
      { game: reader.scope },
      "",
      viewHash(next)
    );
    setView(next);
  }
  const active = !view.home;
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
    navigate({ ...view, edition: id });
  }
  function close() {
    // Local dismissal replaces only the detail entry. Browser Back/Forward entries remain ordinary history.
    navigate({ ...view, edition: "" }, true);
  }
  const edition = detail.value;
  return (
    <div className="min-h-dvh bg-bg font-sans text-text phone:pb-[calc(var(--layout-tabbar-height)+var(--target-touch))]">
      <a
        href="#content"
        onClick={(event) => {
          event.preventDefault();
          (view.home ? homeHeading : catalogHeading).current?.focus();
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
          <Button
            icon={BookOpen}
            variant="quiet"
            aria-current={active ? "page" : undefined}
            aria-pressed={active}
            onClick={() => navigate({ ...view, home: false })}
          >
            Catalog
          </Button>
        </nav>
      </header>
      {view.home && (
        <main className="px-7 py-7 phone:px-4">
          <PageHeader title="Riftbound" headingRef={homeHeading} />
          <Button onClick={() => navigate({ ...view, home: false })}>
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
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-medium),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0">
                {rows.map((e) => (
                  <li key={`riftbound:edition:${e.id}`} className="min-w-0">
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
      <nav
        aria-label="Mobile navigation"
        className="fixed inset-x-0 bottom-0 z-(--layer-sticky) hidden h-tabbar border-t border-border bg-surface phone:flex"
      >
        <button
          className="flex min-w-0 flex-1 cursor-pointer flex-col items-center justify-center gap-1 border-0 bg-transparent p-0 text-caption font-medium text-text-muted aria-[current=page]:text-accent-strong"
          aria-current={active ? "page" : undefined}
          onClick={() => navigate({ ...view, home: false })}
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
        open={active && !!view.edition}
        title={edition?.name ?? "Card details"}
        onClose={close}
        returnFocus={opener}
        cardKey={`riftbound:${view.edition}`}
        position={index >= 0 ? { index, total: rows.length } : null}
        canPrevious={index > 0}
        canNext={index >= 0 && index < rows.length - 1}
        onPrevious={() => open(rows[index - 1].id)}
        onNext={() => open(rows[index + 1].id)}
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
