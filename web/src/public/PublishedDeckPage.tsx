import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, CopyPlus, Link2, ShoppingCart } from "lucide-react";
import { publishedDate } from "../discover/discoverText";
import type { DeckView } from "../decks/deckListModel";
import { copyPath } from "../decks/import/copyModel";
import { FormatResultsDialog } from "../decks/FormatResultsDialog";
import {
  flaggedLines,
  formatLabel,
  issueCount,
  statusOf,
} from "../decks/targetFormat";
import {
  FormatCheckError,
  getPublishedFormatChecks,
  type PublishedFormatCheck,
} from "../format_checks_generated";
import {
  getPublishedDeckCost,
  PriceError,
  type PublishedDeckCost,
} from "../prices_generated";
import {
  getPublicDeckPage,
  PublicationError,
  type PublicSnapshot,
} from "../publications_generated";
import { PageHeader } from "../shell/PageHeader";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { MOBILE_QUERY } from "../workspace/media";
import { OwnerBar } from "./OwnerBar";
import { PublishedCardPopup } from "./PublishedCardPopup";
import { PublishedDeckPanel } from "./PublishedDeckPanel";
import {
  PublishedExportDialog,
  type PublishedExport,
} from "./PublishedExportDialog";
import {
  cardCount,
  costText,
  pricesOf,
  publishedGroups,
  publishedLargeArt,
  publishedLines,
} from "./publishedDeckModel";

type Props = {
  token: string;
  /** Signed in: the page sits inside the shell, and the deck's owner gets the owner bar. */
  signedIn: boolean;
  onNavigate: (to: string) => void;
  /** An unknown or revoked token: the caller shows the unavailable card instead of this page (#163). */
  onUnavailable: () => void;
};

const VIEWS = [
  { value: "spread", label: "Spread" },
  { value: "stacked", label: "Stacked" },
  { value: "list", label: "List" },
] as const;

// The cost route answers within the gateway's three-second budget; a slower answer becomes "unavailable".
const CLIENT_TIMEOUT_MS = 3_500;

type Checks =
  | { kind: "loading" }
  | { kind: "ready"; result: PublishedFormatCheck; disclaimer: string }
  | { kind: "failed" };

// The result as a pill that opens the results dialog: drawn 24 px tall, with a 44 px tap area on a phone (the button
// is the tap area, the inner span the drawn pill), like the kit's chips.
const PILL_BUTTON =
  "group m-0 box-border inline-flex h-chip shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 font-sans disabled:cursor-progress phone:h-tap";
const PILL_FACE: Record<PublishedFormatCheck["status"], string> = {
  legal: "border-accent-border text-accent-strong",
  not_legal: "border-danger-border text-danger",
  unknown: "border-dashed border-control-outline text-text-muted",
};
const PILL =
  "box-border inline-flex h-chip items-center gap-1 whitespace-nowrap rounded-round border px-2.5 text-meta font-medium group-hover:bg-surface-raised";

/**
 * A Published Deck (`/published/:token`, #183), the same under the public header and inside the shell:
 *
 * - the header: the title, "The card list is a snapshot from [date]; format results update automatically", the
 *   Target Format result as a pill that opens the results dialog, the total and how many copies are priced, and Copy
 *   for TCG Live, Copy to my Decks (decklist import #216: the import page with this snapshot; signed out, the sign-in
 *   screen first, which continues there), Buy on TCGplayer and Share;
 * - the deck builder's deck panel, read-only, in Spread, Stacked and List (Spread on a desktop, Stacked on a phone),
 *   with one card's price on tiles and that many copies' price on List lines; a card-level issue outlines its tiles;
 * - the read-only card popup, stepping through the deck;
 * - for the signed-in owner, the owner bar.
 *
 * Everything comes from the public snapshot and its public cost and format result routes, which take only the token
 * and the snapshot version. A 409 (republished) or 404 (revoked) from any of them reads the snapshot again without
 * blanking the page.
 */
export function PublishedDeckPage({
  token,
  signedIn,
  onNavigate,
  onUnavailable,
}: Props) {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [message, setMessage] = useState("Loading Published Deck…");
  const [reload, setReload] = useState(0);
  const [cost, setCost] = useState<PublishedDeckCost | null | "unavailable">(
    null
  );
  const [checks, setChecks] = useState<Checks>({ kind: "loading" });
  const [view, setView] = useState<DeckView>(() =>
    window.matchMedia(MOBILE_QUERY).matches ? "stacked" : "spread"
  );
  const [card, setCard] = useState<number | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [exporting, setExporting] = useState<PublishedExport | null>(null);
  const [shared, setShared] = useState("");
  const cardOpener = useRef<HTMLElement | null>(null);
  const resultButton = useRef<HTMLButtonElement | null>(null);
  const exportOpener = useRef<HTMLElement | null>(null);
  const reRead = () => setReload((count) => count + 1);

  // The snapshot, and the robots answer its read carries (Listed snapshots are indexed, Unlisted ones never).
  useEffect(() => {
    let active = true;
    // A re-read after a changed answer keeps the page in place instead of blanking it.
    if (reload === 0) {
      setSnapshot(null);
      setMessage("Loading Published Deck…");
    }
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(robots);
    void getPublicDeckPage(token)
      .then((result) => {
        if (!active) return;
        setSnapshot(result.snapshot);
        robots.content = result.robots;
        setMessage("");
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof PublicationError && cause.status === 404) {
          onUnavailable();
          return;
        }
        setSnapshot(null);
        setMessage(
          "This Published Deck is temporarily unavailable. Reload to try again."
        );
      });
    return () => {
      active = false;
      robots.remove();
    };
  }, [token, reload]);

  const version = snapshot?.version ?? null;
  const target = snapshot?.target_format ?? "standard";

  // One cost access per snapshot version: the header's total and every tile's price come from it.
  useEffect(() => {
    setCost(null);
    if (version === null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    let live = true;
    getPublishedDeckCost(token, version, controller.signal)
      .then((answer) => {
        if (live) setCost(answer.version === version ? answer : "unavailable");
      })
      .catch((error) => {
        if (!live) return;
        setCost("unavailable");
        if (
          error instanceof PriceError &&
          (error.status === 409 || error.status === 404)
        )
          reRead();
      })
      .finally(() => clearTimeout(timer));
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [token, version]);

  // Today's result in the snapshot's Target Format, recomputed by the server from current card facts.
  useEffect(() => {
    setChecks({ kind: "loading" });
    if (version === null) return;
    const controller = new AbortController();
    getPublishedFormatChecks(token, version, {}, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        const result = answer.results.find((entry) => entry.format === target);
        setChecks(
          answer.version === version && result
            ? { kind: "ready", result, disclaimer: answer.disclaimer }
            : { kind: "failed" }
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setChecks({ kind: "failed" });
        if (
          error instanceof FormatCheckError &&
          (error.status === 409 || error.status === 404)
        )
          reRead();
      });
    return () => controller.abort();
  }, [token, version, target]);

  const lines = useMemo(
    () => (snapshot ? publishedLines(snapshot) : []),
    [snapshot]
  );
  const largeArt = useMemo(
    () =>
      snapshot ? publishedLargeArt(snapshot) : new Map<string, string | null>(),
    [snapshot]
  );
  const groups = useMemo(() => publishedGroups(lines), [lines]);
  // The popup steps through the lines in the order the panel draws them.
  const ordered = useMemo(
    () => groups.flatMap((group) => group.lines),
    [groups]
  );
  const prices = useMemo(
    () =>
      cost === null
        ? null
        : cost === "unavailable" || cost.status === "incomplete"
          ? ("unavailable" as const)
          : pricesOf(cost),
    [cost]
  );
  const result = checks.kind === "ready" ? checks.result : null;
  const flagged = useMemo(() => flaggedLines(result), [result]);
  const format = formatLabel(target);

  async function share() {
    const url = `${window.location.origin}/published/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setShared("Link copied.");
    } catch {
      setShared(`Copy this link: ${url}`);
    }
  }

  if (!snapshot)
    return (
      <main className="mx-auto box-border flex w-full max-w-7xl min-w-0 flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
        <p role="status" className="m-0 text-body text-text-muted">
          {message}
        </p>
      </main>
    );

  const status = result ? statusOf(result.status) : null;
  return (
    <main className="mx-auto box-border flex w-full max-w-7xl min-w-0 flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      {signedIn && (
        <OwnerBar
          token={token}
          targetFormat={target}
          result={result}
          onNavigate={onNavigate}
          onChanged={reRead}
        />
      )}
      <div className="flex flex-col gap-2">
        <PageHeader
          title={snapshot.title}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                icon={Copy}
                onClick={(event) => {
                  exportOpener.current = event.currentTarget;
                  setExporting("live");
                }}
              >
                Copy for TCG Live
              </Button>
              <Button
                icon={CopyPlus}
                onClick={() => onNavigate(copyPath(token))}
              >
                Copy to my Decks
              </Button>
              <Button
                icon={ShoppingCart}
                onClick={(event) => {
                  exportOpener.current = event.currentTarget;
                  setExporting("mass");
                }}
              >
                Buy on TCGplayer
              </Button>
              <Button icon={Link2} onClick={() => void share()}>
                Share
              </Button>
            </div>
          }
        />
        <p className="m-0 text-meta text-text-muted">
          The card list is a snapshot from{" "}
          {publishedDate(snapshot.published_at)}; format results update
          automatically
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {checks.kind === "failed" ? (
            <span className="text-meta text-text-muted">
              {format} result unavailable
            </span>
          ) : (
            <button
              ref={resultButton}
              type="button"
              disabled={!result}
              aria-haspopup="dialog"
              aria-label={
                result && status
                  ? `${format}: ${status.text}${result.status === "legal" ? "" : `, ${issueCount(result)}`}. Show the ${format} result`
                  : `Checking the ${format} result`
              }
              onClick={() => setResultsOpen(true)}
              className={PILL_BUTTON}
            >
              <span
                className={`${PILL} ${result ? PILL_FACE[result.status] : "border-border-strong text-text-muted"}`}
              >
                {result && status ? (
                  <>
                    {format} · <span aria-hidden="true">{status.mark}</span>
                    {status.text}
                  </>
                ) : (
                  `Checking ${format}…`
                )}
              </span>
            </button>
          )}
          <p className="m-0 text-body tabular-nums">
            <strong className="font-semibold">
              {cardCount(snapshot.total)}
            </strong>
            <span className="text-text-muted">
              {" · "}
              <span role="status">{costText(cost)}</span>
            </span>
          </p>
        </div>
        <p
          role="status"
          className="m-0 text-meta text-text-muted wrap-anywhere"
        >
          {shared}
        </p>
      </div>
      <section aria-label="Deck List" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Segmented
            mode="choice"
            label="Deck List view"
            options={VIEWS}
            value={view}
            onChange={setView}
          />
        </div>
        <PublishedDeckPanel
          view={view}
          groups={groups}
          prices={prices}
          flagged={flagged}
          formatName={format}
          onOpen={(line, opener) => {
            cardOpener.current = opener;
            setCard(ordered.indexOf(line));
          }}
        />
      </section>
      <p className="m-0 border-t border-border pt-2 text-caption text-text-subtle">
        Card metadata and images from TCGdex. Not endorsed by Nintendo, The
        Pokémon Company, or TCGdex.
      </p>
      <PublishedCardPopup
        lines={ordered}
        largeArt={largeArt}
        index={card}
        onIndex={setCard}
        onClose={() => setCard(null)}
        returnFocus={cardOpener}
        prices={prices}
        targetFormat={target}
        result={result}
        resultFailed={checks.kind === "failed"}
      />
      {checks.kind === "ready" && (
        <FormatResultsDialog
          open={resultsOpen}
          onClose={() => setResultsOpen(false)}
          returnFocus={resultButton}
          resultOn={(asOf, signal) =>
            getPublishedFormatChecks(
              token,
              snapshot.version,
              { asOf },
              signal
            ).then(
              (answer) =>
                answer.results.find((entry) => entry.format === target) ?? null
            )
          }
          targetFormat={target}
          today={checks.result}
          disclaimer={checks.disclaimer}
          lines={ordered}
        />
      )}
      <PublishedExportDialog
        open={exporting}
        onClose={() => setExporting(null)}
        returnFocus={exportOpener}
        token={token}
        snapshot={snapshot}
        onChanged={reRead}
      />
    </main>
  );
}
