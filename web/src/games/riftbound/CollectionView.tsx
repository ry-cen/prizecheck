import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "../../shell/PageHeader";
import { Button } from "../../ui/Button";
import { ScrollArea } from "../../ui/ScrollArea";
import { SearchField } from "../../ui/SearchField";
import { Dialog } from "../../ui/Dialog";
import { CopyTile } from "../../ui/CopyTile";
import { LocationNav } from "../../workspace/LocationNav";
import { indexLocations } from "../../workspace/locationTree";
import { MOBILE_QUERY, useMediaQuery } from "../../workspace/media";
import {
  collectionKey,
  expandCopies,
  plural,
  type CollectionQuery,
  type CollectionReader,
  type HoldingRow,
} from "./collection";
import { useRead } from "./read";
export function CollectionView({
  reader,
  active,
  query,
  onQuery,
  onCatalog,
}: {
  reader: CollectionReader;
  active: boolean;
  query: CollectionQuery;
  onQuery: (q: CollectionQuery, replace?: boolean) => void;
  onCatalog: () => void;
}) {
  const phone = useMediaQuery(MOBILE_QUERY);
  const [drawer, setDrawer] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<{
    viewKey: string;
    row: HoldingRow & { key: string };
  } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const selectedOpener = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const key = collectionKey(reader.owner, query);
  const trees = useRead(
    JSON.stringify(["riftbound", "locations", reader.owner]),
    useCallback((s) => reader.locations(s), [reader]),
    active
  );
  const listing = useRead(
    key,
    useCallback(
      (s) => reader.list(query, s),
      [reader, query.location, query.search, query.page]
    ),
    active
  );
  const pageOutOfRange = !!listing.value && query.page > listing.value.pages;
  useEffect(() => {
    if (active && listing.value && query.page > listing.value.pages)
      onQuery({ ...query, page: Math.max(1, listing.value.pages) }, true);
  }, [active, listing.value, query, onQuery]);
  const inspector = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (inspector.current) inspector.current.scrollTop = 0;
  }, [selection?.row.key]);
  const selected = active && selection?.viewKey === key ? selection.row : null;
  const holdings = useRead(
    JSON.stringify([
      "riftbound",
      "holdings",
      reader.owner,
      selected?.edition.id,
    ]),
    useCallback(
      (s) => reader.holdings(selected?.edition.id ?? "", s),
      [reader, selected?.edition.id]
    ),
    !!selected
  );
  const index = useMemo(() => indexLocations(trees.value ?? []), [trees.value]);
  useEffect(() => {
    if (active)
      setExpanded(
        (previous) => new Set([...previous, ...index.ancestors(query.location)])
      );
  }, [active, index, query.location]);
  const skipHeadingFocus = useRef(false);
  const lastKey = useRef(key);
  useEffect(() => {
    if (key !== lastKey.current) {
      lastKey.current = key;
      setSelection(null);
      if (
        active &&
        !skipHeadingFocus.current &&
        document.activeElement?.tagName !== "INPUT"
      )
        heading.current?.focus();
      skipHeadingFocus.current = false;
    }
  }, [key, active]);
  useEffect(() => {
    if (!active) {
      setSelection(null);
      setDrawer(false);
    }
  }, [active]);
  function choose(location: string) {
    skipHeadingFocus.current =
      phone && (location !== query.location || query.page !== 1);
    setSelection(null);
    onQuery({ ...query, location, page: 1 });
    setDrawer(false);
  }
  const nav = (touch = false) =>
    trees.failed ? (
      <Failure retry={trees.retry}>Locations couldn't be loaded.</Failure>
    ) : !trees.value ? (
      <p role="status">Loading Locations…</p>
    ) : (
      <LocationNav
        index={index}
        view={query.location}
        expanded={expanded}
        onToggle={(id) => {
          setExpanded((old) => {
            const next = new Set(old);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        }}
        onChoose={choose}
        idPrefix={touch ? "riftbound-drawer" : "riftbound-sidebar"}
        touch={touch}
      />
    );
  const details = selected && (
    <div className="flex min-w-0 flex-col gap-2 [&_p]:m-0 [&_p]:text-meta">
      <Art key={selected.edition.id} row={selected} />
      <h2 className="m-0 text-heading font-semibold">
        {selected.edition.name}
      </h2>
      <p>
        {selected.edition.set.code} · {selected.edition.number}
      </p>
      <p>Variant {selected.edition.finish}</p>
      <p>
        {[selected.edition.domain, selected.edition.type]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <div role="separator" className="my-2 border-t border-border" />
      {holdings.failed ? (
        <Failure retry={holdings.retry}>Locations couldn't be loaded.</Failure>
      ) : !holdings.value ? (
        <p role="status">Loading quantities…</p>
      ) : (
        holdings.value.map((row) => (
          <p key={row.locationId}>
            {index.path(row.locationId)} · {row.quantity}
          </p>
        ))
      )}
    </div>
  );
  return (
    <div hidden={!active}>
      <div className="flex min-w-0">
        <aside className="box-border w-52 shrink-0 border-r border-border p-4 phone:hidden">
          <div className="mr-2 mb-4 ml-3 flex items-center justify-between gap-2">
            <h2 className="m-0 text-micro font-semibold tracking-[1.7px] text-text-subtle uppercase">
              Locations
            </h2>
          </div>
          {nav()}
        </aside>
        <main
          data-collection-content
          className="min-w-0 flex-1 p-7 phone:p-4 phone:[&_h1]:text-heading"
        >
          <div className="mb-4 hidden phone:block">
            <Button ref={opener} onClick={() => setDrawer(true)}>
              Locations
            </Button>
          </div>
          <div className="mb-5 flex items-baseline gap-4 phone:flex-wrap phone:gap-y-2 [&>div]:mb-0">
            <PageHeader
              headingRef={heading}
              title={
                query.location === "all"
                  ? "All owned"
                  : (index.byId.get(query.location)?.name ?? "Location")
              }
            />
            {listing.value && (
              <p className="m-0 text-meta text-text-subtle tabular-nums">
                {plural(listing.value.totals.copies, "copy", "copies")} ·{" "}
                {plural(listing.value.totals.editions, "edition", "editions")}
              </p>
            )}
          </div>
          <div className="max-w-[420px]">
            <SearchField
              label="Search your cards"
              placeholder="Search your cards…"
              value={query.search}
              onChange={(e) => {
                setSelection(null);
                onQuery({ ...query, search: e.target.value, page: 1 }, true);
              }}
            />
          </div>
          <div className="mt-5 flex min-w-0 items-start gap-7">
            <section aria-label="Collection results" className="min-w-0 flex-1">
              {listing.failed ? (
                <Failure
                  retry={() => {
                    setSelection(null);
                    listing.retry();
                  }}
                >
                  Cards couldn't be loaded.
                </Failure>
              ) : !listing.value || pageOutOfRange ? (
                <p role="status">Loading Collection…</p>
              ) : listing.value.collectionEmpty ? (
                <div role="status">
                  <p>No cards in your Collection yet.</p>
                  <Button onClick={onCatalog}>Browse Catalog</Button>
                </div>
              ) : !listing.value.rows.length ? (
                <div role="status">
                  <p>
                    {query.search
                      ? "No cards match your search."
                      : "No cards in this Location."}
                  </p>
                  {query.search && (
                    <Button
                      onClick={() =>
                        onQuery({ ...query, search: "", page: 1 }, true)
                      }
                    >
                      Clear search
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(var(--tile-small),1fr))] gap-x-(--tile-gap-column) gap-y-(--tile-gap-row) p-0">
                    {expandCopies(listing.value.rows).map((row) => (
                      <li key={row.key} className="min-w-0">
                        <CopyTile
                          className="w-full [&_img]:object-contain"
                          label={`${row.edition.name}, ${row.edition.set.code} ${row.edition.number}, ${row.edition.finish}, ${index.byId.get(row.locationId)?.name ?? "Location"}`}
                          title={row.edition.name}
                          name={row.edition.name}
                          setName={row.edition.set.name}
                          setCode={row.edition.set.code}
                          collectorNumber={row.edition.number}
                          variant={row.edition.finish}
                          imageUrl={row.edition.art}
                          names={false}
                          caption={index.byId.get(row.locationId)?.name}
                          selected={selected?.key === row.key}
                          onClick={(e) => {
                            selectedOpener.current = e.currentTarget;
                            setSelection(
                              selected?.key === row.key
                                ? null
                                : { viewKey: key, row }
                            );
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <Button
                      disabled={query.page <= 1}
                      onClick={() =>
                        onQuery({ ...query, page: query.page - 1 })
                      }
                    >
                      Previous page
                    </Button>
                    <span>
                      Page {query.page} of {listing.value.pages}
                    </span>
                    <Button
                      disabled={query.page >= listing.value.pages}
                      onClick={() =>
                        onQuery({ ...query, page: query.page + 1 })
                      }
                    >
                      Next page
                    </Button>
                  </div>
                </>
              )}
            </section>
            {!phone && (
              <aside
                aria-label="Card details"
                className="sticky top-[calc(var(--layout-header-height)+var(--space-4))] w-72 shrink-0"
              >
                <ScrollArea
                  className="max-h-[calc(100dvh-var(--layout-header-height)-2*var(--space-4))]"
                  viewportRef={inspector}
                  viewportClassName="overscroll-contain"
                >
                  {details ?? <p>Select a card to see its details.</p>}
                </ScrollArea>
              </aside>
            )}
          </div>
        </main>
      </div>
      <Dialog
        open={active && drawer && phone}
        title="Locations"
        side="left"
        onClose={() => setDrawer(false)}
        returnFocus={opener}
      >
        {nav(true)}
      </Dialog>
      <Dialog
        open={!!selected && phone}
        title={selected?.edition.name ?? "Card details"}
        onClose={() => setSelection(null)}
        returnFocus={selectedOpener}
      >
        {details}
      </Dialog>
    </div>
  );
}
function Failure({
  retry,
  children,
}: {
  retry: () => void;
  children: React.ReactNode;
}) {
  return (
    <div role="alert">
      <p>{children}</p>
      <Button onClick={retry}>Retry</Button>
    </div>
  );
}
function Art({ row }: { row: HoldingRow }) {
  const [broken, setBroken] = useState(false);
  return row.edition.art && !broken ? (
    <img
      src={row.edition.art}
      onError={() => setBroken(true)}
      alt={`${row.edition.name} card art`}
      className={`w-full rounded-card object-contain ${row.edition.orientation === "landscape" ? "aspect-[7/5]" : "aspect-(--tile-aspect)"}`}
    />
  ) : (
    <div
      role="img"
      aria-label={`Artwork unavailable for ${row.edition.name}`}
      className="flex aspect-(--tile-aspect) items-center justify-center rounded-card bg-surface-raised text-meta"
    >
      Artwork unavailable
    </div>
  );
}
