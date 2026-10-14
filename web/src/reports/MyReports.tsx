import { Fragment, useEffect, useId, useRef } from "react";
import type { ReportView } from "../generated";
import { Button } from "../ui/Button";
import { Pill } from "../ui/Pill";
import { ScrollTable } from "../ui/ScrollTable";
import { TextArea } from "../ui/TextField";
import {
  reportDate,
  reportKind,
  reportLabel,
  reportStatus,
} from "./reportText";

type Props = {
  /** The collector's reports, newest first; null until the first read finishes. */
  reports: ReportView[] | null;
  /** The report whose Reply row is open; one at a time. */
  openId: string | null;
  onToggle: (id: string) => void;
  /** True when the first read failed, so there is nothing to wait for. */
  loadFailed: boolean;
  /** Counts Reply openings; a row focuses its reply box once per count. */
  focusReply: number;
  claimReplyFocus: (count: number) => boolean;
  /** Reply drafts by report id, kept while a row is closed. */
  replies: Record<string, string>;
  onReply: (id: string, text: string) => void;
  /** The report whose reply is being sent. */
  sendingId: string | null;
  onSend: (id: string) => void;
};

const COLUMNS = 6;

/**
 * My reports (#169): a ScrollTable of card, kind, status, sent date and the owner's latest response. A
 * report that needs information has Reply, which opens a row under it with the conversation and a reply
 * box. The API keeps only the collector's latest note and the owner's latest reason, so that is the
 * conversation. The row is as wide as the table's visible area and stays at its left edge while the
 * table scrolls sideways. Metadata reports are filed and followed from the card in Catalog.
 */
export function MyReports(props: Props) {
  const { reports } = props;
  return (
    <>
      <p className="m-0 text-meta text-text-muted">
        These are your missing-card reports. To report a wrong detail on a card
        that exists, open the card in Catalog.
      </p>
      {reports === null ? (
        props.loadFailed ? null : (
          <p className="m-0 text-body text-text-muted">Loading your reports…</p>
        )
      ) : reports.length === 0 ? (
        <p className="m-0 text-body text-text-muted">No reports yet.</p>
      ) : (
        <ScrollTable label="Reports you sent">
          <thead>
            <tr>
              <th scope="col">Card</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Sent</th>
              <th scope="col">Owner response</th>
              <th scope="col">
                <span className="sr-only">Reply</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <ReportRow key={report.id} report={report} {...props} />
            ))}
          </tbody>
        </ScrollTable>
      )}
    </>
  );
}

function ReportRow({
  report,
  openId,
  onToggle,
  replies,
  onReply,
  sendingId,
  onSend,
  focusReply,
  claimReplyFocus,
}: Props & { report: ReportView }) {
  const rowId = useId();
  const status = reportStatus(report.status);
  const canReply = report.status === "needs_info";
  const open = canReply && openId === report.id;
  const label = reportLabel(report);
  return (
    <Fragment>
      <tr>
        <td className="font-semibold">{label}</td>
        <td>{reportKind(report)}</td>
        <td>
          <Pill tone={status.tone}>{status.label}</Pill>
        </td>
        <td>
          <time dateTime={report.created_at}>
            {reportDate(report.created_at)}
          </time>
        </td>
        <td>
          {/* A fixed width that wraps, so a long response makes the row taller, not the table wider. */}
          <span className="block w-64 whitespace-normal break-words">
            {report.review_reason || "—"}
            {report.approved_printing_id && (
              <span className="block text-text-muted">
                Approved Printing: {report.approved_printing_id}
              </span>
            )}
          </span>
        </td>
        <td>
          {canReply && (
            <Button
              aria-expanded={open}
              aria-controls={open ? rowId : undefined}
              onClick={() => onToggle(report.id)}
            >
              {open ? "Close" : "Reply"}
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={COLUMNS} className="p-0">
            <ReplyCard
              id={rowId}
              report={report}
              label={label}
              text={replies[report.id] ?? ""}
              onText={(text) => onReply(report.id, text)}
              sending={sendingId === report.id}
              onSend={() => onSend(report.id)}
              focusReply={focusReply}
              claimReplyFocus={claimReplyFocus}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

function ReplyCard({
  id,
  report,
  label,
  text,
  onText,
  sending,
  onSend,
  focusReply,
  claimReplyFocus,
}: {
  id: string;
  report: ReportView;
  label: string;
  text: string;
  onText: (text: string) => void;
  sending: boolean;
  onSend: () => void;
  focusReply: number;
  claimReplyFocus: (count: number) => boolean;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // Reply moves focus to the reply box; Close keeps it on the button, which stays where it was.
  useEffect(() => {
    if (claimReplyFocus(focusReply)) box.current?.focus();
  }, [focusReply, claimReplyFocus]);
  return (
    <div
      id={id}
      role="group"
      aria-label={`Conversation about ${label}`}
      className="sticky left-0 box-border flex w-[100cqw] flex-col gap-3 whitespace-normal break-words bg-surface p-4"
    >
      <ol
        aria-label="Conversation"
        className="m-0 flex list-none flex-col gap-2 p-0"
      >
        <li className="flex flex-col gap-0.5">
          <span className="text-caption text-text-muted">You</span>
          <p className="m-0 text-body">{report.note || "No note."}</p>
        </li>
        <li className="flex flex-col gap-0.5">
          <span className="text-caption text-text-muted">
            Owner · {reportDate(report.updated_at)}
          </span>
          <p className="m-0 text-body">{report.review_reason || "—"}</p>
        </li>
      </ol>
      <TextArea
        ref={box}
        label="Additional information"
        value={text}
        onChange={(event) => onText(event.target.value)}
        maxLength={2000}
        rows={3}
      />
      <div>
        <Button
          variant="primary"
          disabled={sending || !text.trim()}
          onClick={onSend}
        >
          Send information
        </Button>
      </div>
    </div>
  );
}
