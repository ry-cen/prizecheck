import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SocialError,
  decideTradeReport,
  getOwnerTradeReport,
  restoreCollector,
  type SnapshotCard,
  type SnapshotTrade,
  type TradeReportDetail,
  type TradeReportRow,
} from "../social_generated";
import { when } from "../MetadataReview";
import { REASONS } from "../trades/reportMessages";
import { formatCents } from "../trades/tradeText";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { TextArea } from "../ui/TextField";
import { useToast } from "../ui/Toast";
import { CARD_HEADING, ReviewCard } from "./ReviewQueue";

type Action = "dismiss" | "remove_from_discovery" | "suspend";
type Restore = "discovery" | "suspension";

const SOURCES = {
  conversation: "Conversation",
  discovery: "Near you",
  trade: "Trade",
} as const;

const ACTIONS: Record<Exclude<Action, "dismiss">, string> = {
  remove_from_discovery: "Removed from open discovery",
  suspend: "Suspended",
};

const STATUSES: Record<TradeReportRow["status"], string> = {
  open: "Open",
  dismissed: "Dismissed",
  actioned: "Actioned",
};

const EVENTS = {
  ...ACTIONS,
  dismiss: "Dismissed",
  restore_discovery: "Open discovery restored",
  lift_suspension: "Suspension lifted",
} as const;

const DONE: Record<Action, string> = {
  dismiss: "Report dismissed.",
  remove_from_discovery: "Removed from open discovery.",
  suspend: "Account suspended.",
};

const reasonLabel = (value: string) =>
  REASONS.find((reason) => reason.value === value)?.label ?? value;

const cards = (list: SnapshotCard[]) =>
  list.length
    ? list
        .map(
          (card) =>
            `${card.quantity} × ${card.name} · ${card.set_code} ${card.number}`
        )
        .join(", ")
    : "nothing";

function failure(error: unknown): string {
  const code = error instanceof SocialError ? error.code : "";
  if (code === "REPORT_DECIDED") return "Someone already decided this report.";
  if (code === "REPORTED_ACCOUNT_GONE") return "That account was deleted.";
  if (code === "NOTHING_TO_RESTORE") return "There's nothing to restore.";
  if (code === "INVENTORY_TEMPORARILY_UNAVAILABLE")
    return "Try again in a moment.";
  return "Couldn't save. Try again.";
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className={CARD_HEADING}>{title}</h4>
      {children}
    </section>
  );
}

function TradeFacts({
  trade,
  reporter,
  reported,
}: {
  trade: SnapshotTrade;
  reporter: string;
  reported: string;
}) {
  const name = (side: "reporter" | "reported" | null) =>
    side === "reporter" ? reporter : side === "reported" ? reported : "";
  return (
    <li className="flex flex-col gap-1">
      <span>
        {trade.state === "closed"
          ? `Closed (${trade.closed_reason ?? "unknown"}${trade.closed_by ? ` by ${name(trade.closed_by)}` : ""})`
          : trade.state === "accepted"
            ? "Accepted"
            : "Proposed"}{" "}
        · proposed by {name(trade.proposed_by)}{" "}
        {trade.ended_by_report && (
          <Pill tone="warn">Cancelled by this Report</Pill>
        )}
      </span>
      <span>
        {reporter} gives: {cards(trade.reporter_gives)}
      </span>
      <span>
        {reported} gives: {cards(trade.reported_gives)}
      </span>
      {trade.cash_cents !== null && (
        <span>
          Cash: {formatCents(String(trade.cash_cents))}
          {trade.cash_paid_by ? `, paid by ${name(trade.cash_paid_by)}` : ""}
        </span>
      )}
      <span className="text-meta text-text-muted">
        Proposed {when(trade.proposed_at)}
        {trade.accepted_at && ` · accepted ${when(trade.accepted_at)}`}
        {trade.reporter_confirmed_at &&
          ` · ${reporter} confirmed ${when(trade.reporter_confirmed_at)}`}
        {trade.reported_confirmed_at &&
          ` · ${reported} confirmed ${when(trade.reported_confirmed_at)}`}
        {trade.closed_at && ` · closed ${when(trade.closed_at)}`}
      </span>
    </li>
  );
}

/**
 * The inline review card of a Trade report (#303, owner screen: Handles, ids and times are shown). It reads
 * the snapshot only. Dismiss, Remove from open discovery and Suspend account decide an open report with an
 * optional note; Restore open discovery and Lift suspension reverse an earlier decision on any report.
 */
export function TradeReportReview({
  reportId,
  onDecided,
  close,
}: {
  reportId: string;
  onDecided: () => void;
  close: () => void;
}) {
  const [detail, setDetail] = useState<TradeReportDetail | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();

  async function load() {
    try {
      setDetail(await getOwnerTradeReport(reportId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }
  useEffect(() => {
    void load();
  }, [reportId]);

  async function run(work: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await work();
      setNote("");
      toast.show({ message: done });
      onDecided();
      await load();
    } catch (error) {
      toast.show({ message: failure(error) });
      if (error instanceof SocialError && error.code === "REPORT_DECIDED")
        onDecided();
      await load();
    } finally {
      setBusy(false);
      // The pressed button may be gone now (a decided report, a lifted suspension): the note field takes focus, if the
      // card is still open.
      noteField.current?.focus({ preventScroll: true });
    }
  }
  const decide = (action: Action) =>
    run(
      () => decideTradeReport(reportId, { action, note: note.trim() || null }),
      DONE[action]
    );
  const restore = (what: Restore) =>
    run(
      () =>
        restoreCollector(detail?.report.reported.user_id ?? "", {
          what,
          note: note.trim() || null,
        }),
      what === "discovery" ? "Open discovery restored." : "Suspension lifted."
    );

  const title = detail
    ? `Report on ${detail.report.reported.display_name}`
    : "Trade report";
  if (!detail)
    return (
      <ReviewCard
        key="loading"
        title={title}
        onClose={close}
        focusRef={noteField}
      >
        <p className="m-0 text-body">
          {loadFailed ? "Couldn't load this report." : "Loading…"}
        </p>
      </ReviewCard>
    );

  const { report, account } = detail;
  const open = report.status === "open";
  const reporter = report.reporter.display_name;
  const reported = report.reported.display_name;
  const party = (value: typeof report.reporter) =>
    `${value.display_name} @${value.handle} · ${value.user_id ?? "Account deleted"}`;
  return (
    <ReviewCard key="ready" title={title} onClose={close} focusRef={noteField}>
      <Section title="Report">
        <p className="m-0">Reporter: {party(report.reporter)}</p>
        <p className="m-0">Reported: {party(report.reported)}</p>
        <p className="m-0">
          {reasonLabel(report.reason)} · {SOURCES[report.source]} ·{" "}
          {when(report.created_at)}
        </p>
        <p className="m-0">{detail.note ?? "No note"}</p>
        <p className="m-0 flex flex-wrap gap-2">
          {account.suspended && <Pill tone="bad">Suspended</Pill>}
          {account.removed && (
            <Pill tone="warn">Removed from open discovery</Pill>
          )}
          {!account.exists && <Pill tone="neutral">Account deleted</Pill>}
        </p>
      </Section>
      <Section title="Conversation at the time of the Report">
        {detail.messages.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.messages.map((message) => (
              <li key={message.message_id}>
                {message.sender === "reporter" ? reporter : reported} ·{" "}
                {when(message.at)}: {message.body}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">No messages</p>
        )}
      </Section>
      <Section title="Trades at the time of the Report">
        {detail.trades.length ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {detail.trades.map((trade) => (
              <TradeFacts
                key={trade.trade_id}
                trade={trade}
                reporter={reporter}
                reported={reported}
              />
            ))}
          </ul>
        ) : (
          <p className="m-0">No Trades</p>
        )}
      </Section>
      <Section title="Earlier reports on this collector">
        {detail.other_reports.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.other_reports.map((other) => (
              <li key={other.id}>
                {new Date(other.created_at).toLocaleDateString()} ·{" "}
                {reasonLabel(other.reason)} · {STATUSES[other.status]}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">None</p>
        )}
      </Section>
      <Section title="Moderation history">
        {detail.events.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {detail.events.map((event) => (
              <li key={event.id}>
                {new Date(event.created_at).toLocaleDateString()} ·{" "}
                {EVENTS[event.action]}
                {event.note ? ` · ${event.note}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0">None</p>
        )}
      </Section>
      <Section title="Decide">
        <TextArea
          ref={noteField}
          label="Note (optional)"
          maxLength={1000}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {open && (
            <>
              <Button disabled={busy} onClick={() => void decide("dismiss")}>
                Dismiss
              </Button>
              <Button
                disabled={busy || !account.exists}
                onClick={() => void decide("remove_from_discovery")}
              >
                Remove from open discovery
              </Button>
              <Button
                variant="primary"
                disabled={busy || !account.exists}
                onClick={() => void decide("suspend")}
              >
                Suspend account
              </Button>
            </>
          )}
          {account.exists && account.removed && (
            <Button disabled={busy} onClick={() => void restore("discovery")}>
              Restore open discovery
            </Button>
          )}
          {account.exists && account.suspended && (
            <Button disabled={busy} onClick={() => void restore("suspension")}>
              Lift suspension
            </Button>
          )}
        </div>
      </Section>
    </ReviewCard>
  );
}
