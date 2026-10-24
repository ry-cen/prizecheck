import { useEffect, useId, useRef, useState } from "react";
import {
  SocialError,
  getNearbyMatches,
  getTraderMatch,
  setDiscovery,
  type NearbyMatches,
} from "../social_generated";
import {
  ACCOUNT_SUSPENDED_NOTE,
  DISCOVERY_REMOVED,
  DISCOVERY_SAVE_FAILED,
  discoveryMessage,
} from "../settings/discoveryMessages";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";
import { RETRY } from "./conversationMessages";
import { MatchRow } from "./MatchRow";
import {
  NEAR_EMPTY,
  NEAR_FAILED,
  NEAR_HEADING,
  NEAR_INTRO,
  NEAR_LIST_LABEL,
  NEAR_LOADING,
  NEAR_OFF,
  OPEN_SETTINGS,
  RADIUS_LABEL,
  RADIUS_OPTIONS,
  TURN_ON,
} from "./nearYouMessages";
import { NearRowMenu } from "./NearRowMenu";
import { traderTradeListPath } from "./tradeListModel";

type Load =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "ready"; near: NearbyMatches };

type Radius = 5 | 10 | 25 | 50;

const LINK =
  "inline-flex h-control items-center rounded-control px-2 text-control font-medium text-accent-strong no-underline hover:bg-surface-raised phone:h-control-phone";

/**
 * Near you (Trading #300), the second section of Find trades: nearby collectors who are not Friends and match the
 * collector's Trade List and wants, sorted by match kind, band and name. With open discovery on it shows a radius
 * choice (5, 10, 25 or 50 mi, stored in the discovery setting) and the rows; with it off it shows a prompt and Turn on.
 * Removed and suspended accounts get their own sentence and nothing else. A row shows the band, never a Handle, zip
 * code or distance. `onDiscoveryChanged` runs after every saved radius or Turn on, so card search reads again.
 */
export function NearYou({
  onNavigate,
  onDiscoveryChanged,
}: {
  onNavigate: (to: string) => void;
  onDiscoveryChanged: () => void;
}) {
  const headingId = useId();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [radius, setRadius] = useState<Radius>(25);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [needsZip, setNeedsZip] = useState(false);
  // A Block removes its row, so its status lives here, where it stays mounted, and focus goes to the heading.
  const [blocked, setBlocked] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoad((current) =>
      current.kind === "ready" ? current : { kind: "loading" }
    );
    getNearbyMatches(controller.signal)
      .then((near) => {
        if (controller.signal.aborted) return;
        setRadius(near.radius_mi);
        setLoad({ kind: "ready", near });
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ kind: "failed" });
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = () => setAttempt((n) => n + 1);
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function chooseRadius(value: string) {
    if (pending) return;
    const before = radius;
    const chosen = Number(value) as Radius;
    setRadius(chosen);
    setPending(true);
    setNotice("");
    try {
      await setDiscovery({ radius_mi: chosen });
      reload();
      onDiscoveryChanged();
    } catch {
      setRadius(before);
      setNotice(DISCOVERY_SAVE_FAILED);
    } finally {
      setPending(false);
    }
  }

  async function turnOn() {
    if (pending) return;
    setPending(true);
    setNotice("");
    setNeedsZip(false);
    try {
      await setDiscovery({ enabled: true });
      reload();
      onDiscoveryChanged();
    } catch (cause) {
      if (
        cause instanceof SocialError &&
        cause.code === "DISCOVERY_UNAVAILABLE"
      )
        reload();
      else {
        setNotice(discoveryMessage(cause));
        setNeedsZip(
          cause instanceof SocialError && cause.code === "ZIP_REQUIRED"
        );
      }
    } finally {
      setPending(false);
    }
  }

  function body() {
    if (load.kind === "loading")
      return (
        <p role="status" className="m-0 text-body text-text-muted">
          {NEAR_LOADING}
        </p>
      );
    if (load.kind === "failed")
      return (
        <div className="flex flex-wrap items-center gap-3">
          <p role="status" className="m-0 text-body text-text-muted">
            {NEAR_FAILED}
          </p>
          <Button onClick={reload}>{RETRY}</Button>
        </div>
      );
    const { near } = load;
    if (near.status === "removed")
      return (
        <p className="m-0 text-body text-text-muted">{DISCOVERY_REMOVED}</p>
      );
    if (near.status === "suspended")
      return (
        <p className="m-0 text-body text-text-muted">
          {ACCOUNT_SUSPENDED_NOTE}
        </p>
      );
    if (near.status === "off")
      return (
        <>
          <p className="m-0 text-body text-text-muted">{NEAR_OFF}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              aria-busy={pending || undefined}
              onClick={() => void turnOn()}
            >
              {TURN_ON}
            </Button>
          </div>
          <p role="alert" className="m-0 text-meta text-danger empty:hidden">
            {notice}
          </p>
          {needsZip && (
            <a
              href="/settings"
              className={LINK}
              onClick={(event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onNavigate("/settings");
              }}
            >
              {OPEN_SETTINGS}
            </a>
          )}
        </>
      );
    return (
      <>
        <div aria-busy={pending || undefined}>
          <Segmented
            mode="choice"
            label={RADIUS_LABEL}
            options={RADIUS_OPTIONS}
            value={String(radius) as "5" | "10" | "25" | "50"}
            onChange={(value) => void chooseRadius(value)}
          />
        </div>
        <p role="alert" className="m-0 text-meta text-danger empty:hidden">
          {notice}
        </p>
        <p className="m-0 text-body text-text-muted">{NEAR_INTRO}</p>
        {near.rows.length === 0 ? (
          <p role="status" className="m-0 text-body text-text-muted">
            {NEAR_EMPTY}
          </p>
        ) : (
          <ul
            aria-label={NEAR_LIST_LABEL}
            className="m-0 flex list-none flex-col gap-3 p-0"
          >
            {near.rows.map((row) => (
              <MatchRow
                key={row.trader_id}
                row={row}
                handle={null}
                band={row.band}
                tradeListPath={traderTradeListPath(row.trader_id)}
                loadAll={(signal) => getTraderMatch(row.trader_id, signal)}
                menu={
                  <NearRowMenu
                    row={row}
                    onChanged={reload}
                    onBlocked={(status) => {
                      setBlocked(status);
                      heading.current?.focus();
                    }}
                  />
                }
                open={open.has(row.trader_id)}
                onToggle={() => toggle(row.trader_id)}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2
        ref={heading}
        id={headingId}
        tabIndex={-1}
        className="m-0 text-heading font-semibold"
      >
        {NEAR_HEADING}
      </h2>
      <p
        role="status"
        className={blocked ? "m-0 text-meta text-text-muted" : "sr-only"}
      >
        {blocked}
      </p>
      {body()}
    </section>
  );
}
