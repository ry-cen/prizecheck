import { useFirstReadSettled, useReadOnShow } from "../shell/keptRead";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  getMyMissingCardReports,
  respondToMissingCardReview,
  submitMissingCardReport,
  type ReportView,
} from "../generated";
import { PageHeader } from "../shell/PageHeader";
import { Segmented, segmentId } from "../ui/Segmented";
import { MyReports } from "./MyReports";
import { clearMissingCardLink, readMissingCardLink } from "./missingCardLink";
import { EMPTY_DRAFT, ReportForm, type ReportDraft } from "./ReportForm";

type Section = "mine" | "report";

const LOAD_FAILED = "Unable to load your reports.";

const SECTIONS = [
  { value: "mine", label: "My reports" },
  { value: "report", label: "Report a card" },
] as const;

type Props = {
  /** False while the shell keeps the page mounted but hidden. */
  active: boolean;
  /** The app's last service message. */
  message: string;
};

/**
 * Card reports (#169, variant A of the Missing cards and Owner controls decision): sub-tabs for My reports
 * and Report a card. The page stays mounted when the collector leaves it, so the sub-tab, the form and
 * reply drafts are kept; the reports are read again each time the page is shown, as they were when it
 * remounted on every visit. Only missing-card reports are listed: metadata reports stay in Catalog. A report link
 * (missingCardLink.ts, from Decklist Import's Not found lines, #213) opens Report a card with the form filled in.
 */
export function MissingCardsPage({ active, message }: Props) {
  const idBase = useId();
  const [section, setSection] = useState<Section>("mine");
  const [reports, setReports] = useState<ReportView[] | null>(null);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<ReportDraft>(EMPTY_DRAFT);
  const [submitting, setSubmitting] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [sendingId, setSendingId] = useState<string | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  // Reply bumps this count so the reply box takes focus only when a row is opened, not when My reports
  // is shown again with a row already open. A row claims each count once.
  const [focusReply, setFocusReply] = useState(0);
  const claimedReply = useRef(0);
  const shown = useRef(active);
  shown.current = active;
  const claimReplyFocus = useCallback((count: number) => {
    if (!shown.current || !count || count === claimedReply.current)
      return false;
    claimedReply.current = count;
    return true;
  }, []);
  // Focus moves to the status line after a send, once it holds the new message.
  const [focusStatus, setFocusStatus] = useState(0);
  useEffect(() => {
    if (active && focusStatus) statusLine.current?.focus();
  }, [focusStatus]);

  // Only the latest read may set the list, so a slow earlier read can't overwrite a newer one.
  const latestRead = useRef(0);
  const load = useCallback(async (quiet = false) => {
    const mine = ++latestRead.current;
    try {
      const rows = await getMyMissingCardReports();
      if (mine !== latestRead.current) return;
      setReports(rows);
      // A report the owner has since answered no longer has a Reply row to keep open.
      setOpenId((open) =>
        open &&
        rows.some((row) => row.id === open && row.status === "needs_info")
          ? open
          : null
      );
      setStatus((current) => (current === LOAD_FAILED ? "" : current));
    } catch {
      if (!quiet && mine === latestRead.current) setStatus(LOAD_FAILED);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useFirstReadSettled(reports !== null || status === LOAD_FAILED);
  useReadOnShow(active, status === LOAD_FAILED, (quiet) => void load(quiet));

  // A report link opens Report a card with a new draft from the link, whenever the page is shown with one; the link
  // then leaves the address.
  useEffect(() => {
    if (!active) return;
    const link = readMissingCardLink();
    clearMissingCardLink();
    if (!link) return;
    setDraft({ ...EMPTY_DRAFT, kind: "printing", ...link });
    setSection("report");
  }, [active]);

  async function submit() {
    setStatus("");
    setSubmitting(true);
    const printing = draft.kind === "printing";
    try {
      const row = await submitMissingCardReport({
        kind: draft.kind,
        set_id: printing ? draft.setId : null,
        set_name: printing ? draft.setName : null,
        collector_number: printing ? draft.number : null,
        english_name: printing ? draft.englishName : null,
        printing_id: printing ? null : draft.printingId,
        descriptor:
          !printing && draft.descriptor.trim()
            ? { label: draft.descriptor.trim() }
            : null,
        evidence_url: draft.evidence || null,
        note: draft.note,
      });
      latestRead.current++;
      setReports((previous) => [row, ...(previous ?? [])]);
      // As before, the card's identity stays filled in for a next report; the evidence and note don't.
      setDraft((previous) => ({
        ...previous,
        evidence: "",
        note: "",
        descriptor: "",
      }));
      setSection("mine");
      setStatus("Report sent privately to the owner.");
      setFocusStatus((count) => count + 1);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Unable to submit report."
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function sendReply(id: string) {
    setStatus("");
    setSendingId(id);
    try {
      const updated = await respondToMissingCardReview(id, {
        note: replies[id] ?? "",
      });
      latestRead.current++;
      setReports((previous) =>
        (previous ?? []).map((row) => (row.id === id ? updated : row))
      );
      setReplies(({ [id]: _sent, ...rest }) => rest);
      setOpenId(null);
      setStatus("Information sent to the owner.");
      setFocusStatus((count) => count + 1);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Unable to send information."
      );
    } finally {
      setSendingId(null);
    }
  }

  const panelId = `${idBase}-panel-${section}`;
  return (
    <main className="mx-auto box-border flex max-w-7xl flex-col gap-4 px-7 py-7 phone:px-4 phone:py-5">
      <PageHeader title="Card reports" />
      <Segmented
        label="Card reports sections"
        idBase={idBase}
        panelId={panelId}
        value={section}
        onChange={setSection}
        options={SECTIONS}
      />
      <p
        ref={statusLine}
        role="status"
        tabIndex={-1}
        className="m-0 text-body text-text-muted"
      >
        {status}
      </p>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={segmentId(idBase, section)}
        className="flex min-w-0 flex-col gap-4"
      >
        {section === "mine" ? (
          <MyReports
            reports={reports}
            openId={openId}
            loadFailed={status === LOAD_FAILED}
            focusReply={focusReply}
            claimReplyFocus={claimReplyFocus}
            onToggle={(id) => {
              if (openId !== id) setFocusReply((count) => count + 1);
              setOpenId(openId === id ? null : id);
            }}
            replies={replies}
            onReply={(id, text) =>
              setReplies((previous) => ({ ...previous, [id]: text }))
            }
            sendingId={sendingId}
            onSend={(id) => void sendReply(id)}
          />
        ) : (
          <ReportForm
            draft={draft}
            onDraft={(change) =>
              setDraft((previous) => ({ ...previous, ...change }))
            }
            busy={submitting}
            onSubmit={() => void submit()}
          />
        )}
      </div>
      <p role="alert" className="m-0 text-body text-danger">
        {message}
      </p>
    </main>
  );
}
