import { useEffect, useRef, useState } from "react";
import { getOwnerTradeReports, type TradeReportRow } from "../social_generated";
import { REASONS } from "../trades/reportMessages";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { ReviewQueue } from "./ReviewQueue";
import { TradeReportReview } from "./TradeReportReview";

type Status = TradeReportRow["status"];

const SOURCES = {
  conversation: "Conversation",
  discovery: "Near you",
  trade: "Trade",
} as const;

/**
 * Owner controls' Trade reports queue (#303): Reports collectors made from a conversation, a Near you row or a
 * Trade, filtered by status so a decided report can be reached and reversed. Review opens the snapshot inline.
 */
export function TradeReportsQueue({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<Status>("open");
  const [reports, setReports] = useState<TradeReportRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  // Each read drops the earlier one's answer, so a slow answer for another status never replaces the list.
  const reading = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => () => reading.current?.abort(), []);

  async function load(more = false) {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    setLoading(true);
    try {
      const list = await getOwnerTradeReports(
        { status, before: more ? next : null },
        controller.signal
      );
      if (controller.signal.aborted) return;
      setReports((previous) =>
        more ? [...previous, ...list.reports] : list.reports
      );
      setNext(list.next_before);
      if (!more)
        setOpen((current) =>
          current && list.reports.some((row) => row.id === current)
            ? current
            : null
        );
      setMessage("");
    } catch {
      if (controller.signal.aborted) return;
      setMessage("Unable to load review queue.");
    } finally {
      if (reading.current === controller) setLoading(false);
    }
  }
  useEffect(() => {
    setOpen(null);
    setReports([]);
    setNext(null);
    void load();
  }, [status]);

  return (
    <ReviewQueue
      title="Trade reports"
      intro="Reports collectors made from a conversation, Near you or a Trade. Each shows what was in the conversation and the pair's Trades at the time of the Report."
      tableLabel="Trade reports table"
      columns={["Reported", "Reason", "From", "Reports"]}
      rows={reports.map((report) => ({
        key: report.id,
        label: `report on ${report.reported.display_name}`,
        card: `${report.reported.display_name} @${report.reported.handle}`,
        setNumber:
          REASONS.find((reason) => reason.value === report.reason)?.label ??
          report.reason,
        kind: SOURCES[report.source],
        reports: String(report.reported_count),
        opened: report.created_at,
      }))}
      emptyText={status === "open" ? "No open Trade reports." : "None."}
      open={open}
      onOpen={setOpen}
      renderCard={(key, close) => (
        <TradeReportReview
          key={key}
          reportId={key}
          close={close}
          onDecided={() => {
            void load();
            onChanged();
          }}
        />
      )}
      onRefresh={() => void load()}
      status={message}
      before={
        <Select
          label="Status"
          value={status}
          onChange={(event) => setStatus(event.target.value as Status)}
        >
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
          <option value="actioned">Actioned</option>
        </Select>
      }
      after={
        next ? (
          <Button disabled={loading} onClick={() => void load(true)}>
            Load more
          </Button>
        ) : null
      }
    />
  );
}
