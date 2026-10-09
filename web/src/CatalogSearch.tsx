import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  getPrinting,
  searchCatalog,
  type PrintingView,
  type SearchResponse,
} from "./generated";
import { MissingCardReports } from "./MissingCardReports";
import { MetadataReport, MyMetadataReports } from "./MetadataReport";
import "./CatalogSearch.css";

function CardArt({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed)
    return (
      <div
        className="catalog-art-placeholder"
        role="img"
        aria-label={`Artwork unavailable for ${name}`}
      >
        Artwork unavailable
      </div>
    );
  return (
    <img
      className="catalog-art"
      src={url}
      alt={`${name} card art`}
      onError={() => setFailed(true)}
    />
  );
}

function descriptorLabel(descriptor: Record<string, unknown>) {
  if (typeof descriptor.label === "string") return descriptor.label;
  const parts = Object.entries(descriptor).map(
    ([key, value]) =>
      `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`
  );
  return parts.join(" · ") || "Unspecified Variant";
}

export function CatalogSearch() {
  const [mode, setMode] = useState<"name" | "set">("name");
  const [name, setName] = useState("");
  const [setId, setSetId] = useState("");
  const [number, setNumber] = useState("");
  const [filters, setFilters] = useState<{
    name?: string;
    set_id?: string;
    number?: string;
  } | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [detail, setDetail] = useState<PrintingView | null>(null);
  const [selectedEdition, setSelectedEdition] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportEdition, setReportEdition] = useState(false);
  const [metadataReport, setMetadataReport] = useState<{
    editionId: string | null;
  } | null>(null);
  const [reportsKey, setReportsKey] = useState(0);
  const request = useRef(0);

  async function search(
    nextFilters: { name?: string; set_id?: string; number?: string },
    cursor?: string
  ) {
    const id = ++request.current;
    setLoading(true);
    setMessage("");
    try {
      const page = await searchCatalog(nextFilters, cursor);
      if (id !== request.current) return;
      setResult(page);
      setFilters(nextFilters);
      setDetail(null);
      setSelectedEdition(null);
      if (!page.available)
        setMessage("Catalog unavailable until the first complete import.");
    } catch (error) {
      if (id !== request.current) return;
      if (error instanceof Error && error.message === "CATALOG_CHANGED") {
        try {
          const first = await searchCatalog(nextFilters);
          if (id !== request.current) return;
          setResult(first);
          setDetail(null);
          setSelectedEdition(null);
          setMessage("Catalog changed. Results refreshed from page one.");
        } catch {
          if (id === request.current) {
            setResult(null);
            setMessage("Catalog changed. Search again from page one.");
          }
        }
      } else
        setMessage("Catalog search is temporarily unavailable. Please retry.");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next =
      mode === "name"
        ? { name: name.trim() }
        : { set_id: setId.trim(), number: number.trim() };
    void search(next);
  }

  async function openDetail(id: string) {
    setMessage("");
    try {
      const response = await getPrinting(id);
      if (result && response.revision !== result.revision) {
        if (filters) await search(filters);
        setMessage("Catalog changed. Results refreshed from page one.");
        return;
      }
      setDetail(response.printing);
      setSelectedEdition(null);
      setReportEdition(false);
      setMetadataReport(null);
    } catch {
      setMessage("Printing details are unavailable. Please retry.");
    }
  }

  return (
    <section className="catalog-search" aria-label="Collector catalog search">
      <h2>English card catalog</h2>
      <p>Find a Card Printing, then choose its exact Edition.</p>
      <form onSubmit={submit}>
        <fieldset>
          <legend>Search by</legend>
          <label>
            <input
              type="radio"
              checked={mode === "name"}
              onChange={() => setMode("name")}
            />{" "}
            Name prefix
          </label>
          <label>
            <input
              type="radio"
              checked={mode === "set"}
              onChange={() => setMode("set")}
            />{" "}
            Set and collector number
          </label>
        </fieldset>
        {mode === "name" ? (
          <label>
            English name{" "}
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
            />
          </label>
        ) : (
          <div className="catalog-search-fields">
            <label>
              Set ID{" "}
              <input
                value={setId}
                onChange={(event) => setSetId(event.target.value)}
                required
                maxLength={80}
              />
            </label>
            <label>
              Collector number{" "}
              <input
                value={number}
                onChange={(event) => setNumber(event.target.value)}
                required
                maxLength={80}
              />
            </label>
          </div>
        )}
        <button type="submit" disabled={loading}>
          Search
        </button>
      </form>
      {message && <p role="status">{message}</p>}
      {result?.available && (
        <p>
          Last successful TCGdex pull:{" "}
          {result.last_success
            ? new Date(result.last_success).toLocaleString()
            : "Unknown"}
          . Source: TCGdex English catalog.
        </p>
      )}
      {detail ? (
        <article aria-label="Printing detail" className="catalog-detail">
          <button
            type="button"
            onClick={() => {
              setDetail(null);
              setSelectedEdition(null);
            }}
          >
            Back to results
          </button>
          <h3>{detail.name}</h3>
          <CardArt url={detail.high_image_url} name={detail.name} />
          <p>
            {detail.set_name} ({detail.set_id}) · #{detail.collector_number}
          </p>
          <p>Card Identity: {detail.identity_name}</p>
          <p>
            Source:{" "}
            {detail.source === "tcgdex"
              ? "TCGdex"
              : "Owner reviewed manual record"}
            {detail.source_id ? ` · ${detail.source_id}` : ""}
          </p>
          {detail.evidence_url && (
            <p>
              Printing evidence:{" "}
              <a href={detail.evidence_url} target="_blank" rel="noreferrer">
                Open reviewed evidence
              </a>
            </p>
          )}
          <p>
            Artwork belongs to the Printing and does not prove an Edition
            finish.
          </p>
          <h4>Card Editions</h4>
          <ul>
            {detail.editions.map((edition) => (
              <li key={edition.id}>
                <button
                  type="button"
                  id={`edition-${edition.id}`}
                  disabled={!edition.active}
                  aria-pressed={selectedEdition === edition.id}
                  onClick={() => setSelectedEdition(edition.id)}
                >
                  {descriptorLabel(edition.descriptor)}
                </button>
                {" · "}
                {edition.source === "manual"
                  ? "Owner reviewed manual Edition"
                  : "TCGdex Edition"}
                {edition.evidence_url && (
                  <>
                    {" "}
                    ·{" "}
                    <a
                      href={edition.evidence_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Reviewed evidence
                    </a>
                  </>
                )}
                {!edition.active && " Unavailable"}{" "}
                <button
                  type="button"
                  aria-describedby={`edition-${edition.id}`}
                  onClick={() => setMetadataReport({ editionId: edition.id })}
                >
                  Report metadata
                </button>
              </li>
            ))}
          </ul>
          {selectedEdition && (
            <p role="status">
              Selected Edition:{" "}
              {descriptorLabel(
                detail.editions.find((item) => item.id === selectedEdition)!
                  .descriptor
              )}{" "}
              · {selectedEdition}
            </p>
          )}
          <button
            type="button"
            onClick={() => setReportEdition((value) => !value)}
          >
            Report missing Edition
          </button>
          {reportEdition && <MissingCardReports printingId={detail.id} />}
          <button
            type="button"
            onClick={() => setMetadataReport({ editionId: null })}
          >
            Report Printing metadata
          </button>
          {metadataReport && (
            <MetadataReport
              key={metadataReport.editionId ?? "printing"}
              printingId={detail.id}
              printingName={detail.name}
              editions={detail.editions.map((edition) => ({
                id: edition.id,
                label: descriptorLabel(edition.descriptor),
              }))}
              initialEditionId={metadataReport.editionId}
              onSubmitted={() => setReportsKey((value) => value + 1)}
            />
          )}
        </article>
      ) : (
        result?.available && (
          <div aria-label="Catalog results">
            {result.printings.length === 0 ? (
              <p>No matching Printings.</p>
            ) : (
              <ul className="catalog-results">
                {result.printings.map((printing) => (
                  <li key={printing.id}>
                    <CardArt
                      url={printing.low_image_url}
                      name={printing.name}
                    />
                    <div>
                      <h3>{printing.name}</h3>
                      <p>
                        {printing.set_name} ({printing.set_id}) · #
                        {printing.collector_number}
                      </p>
                      <p>Card Identity: {printing.identity_name}</p>
                      <p>
                        Available Editions:{" "}
                        {printing.editions
                          .filter((edition) => edition.active)
                          .map(
                            (edition) =>
                              `${descriptorLabel(edition.descriptor)} (${edition.source === "manual" ? "owner reviewed" : "TCGdex"})`
                          )
                          .join(", ") || "None"}
                      </p>
                      <p>
                        Source:{" "}
                        {printing.source === "tcgdex"
                          ? "TCGdex"
                          : "Owner reviewed manual record"}
                      </p>
                      <button
                        type="button"
                        onClick={() => void openDetail(printing.id)}
                      >
                        View Editions
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {result.next_cursor && filters && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void search(filters, result.next_cursor!)}
              >
                Next page
              </button>
            )}
          </div>
        )
      )}
      <MyMetadataReports refreshKey={reportsKey} />
    </section>
  );
}
