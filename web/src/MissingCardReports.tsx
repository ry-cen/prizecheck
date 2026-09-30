import { useEffect, useState, type FormEvent } from 'react';
import { beginOwnerMissingCardReport, decideMissingCardReport, getMyMissingCardReports,
  getOwnerMissingCardReports, respondToMissingCardReview, submitMissingCardReport,
  type ReportView } from './generated';

type Kind = 'printing' | 'edition';

function label(report: ReportView) {
  return report.kind === 'printing'
    ? `${report.english_name || 'Unnamed Printing'} · ${report.set_name || report.set_id || 'Unknown set'} #${report.collector_number || '?'}`
    : `Edition of Printing ${report.printing_id || '?'}`;
}

export function MissingCardReports({ printingId }: { printingId?: string }) {
  const [reports, setReports] = useState<ReportView[]>([]);
  const [kind, setKind] = useState<Kind>(printingId ? 'edition' : 'printing');
  const [setId, setSetId] = useState('');
  const [setName, setSetName] = useState('');
  const [number, setNumber] = useState('');
  const [name, setEnglishName] = useState('');
  const [target, setTarget] = useState(printingId || '');
  const [descriptor, setDescriptor] = useState('');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [responses, setResponses] = useState<Record<string, string>>({});
  useEffect(() => { void getMyMissingCardReports().then(setReports).catch(() => setMessage('Unable to load your reports.')); }, []);

  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage('');
    try {
      const row = await submitMissingCardReport({
        kind, set_id: kind === 'printing' ? setId : null, set_name: kind === 'printing' ? setName : null,
        collector_number: kind === 'printing' ? number : null, english_name: kind === 'printing' ? name : null,
        printing_id: kind === 'edition' ? target : null,
        descriptor: kind === 'edition' && descriptor.trim() ? { label: descriptor.trim() } : null,
        evidence_url: evidence || null, note,
      });
      setReports(previous => [row, ...previous]); setMessage('Report sent privately to the owner.');
      setEvidence(''); setNote(''); setDescriptor('');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to submit report.'); }
  }
  async function respond(id: string) {
    try {
      const updated = await respondToMissingCardReview(id, { note: responses[id] });
      setReports(previous => previous.map(row => row.id === id ? updated : row));
      setMessage('Information sent to the owner.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to send information.'); }
  }
  return <section aria-label="Missing-card reports">
    <h2>Report a missing English card</h2>
    <p>Reports are private to you and the owner. They do not add a catalog record.</p>
    <form onSubmit={submit}>
      <label>Report type <select value={kind} onChange={event => setKind(event.target.value as Kind)}>
        <option value="printing">Missing Printing</option><option value="edition">Missing Edition</option>
      </select></label>
      {kind === 'printing' ? <>
        <label>Set ID <input value={setId} onChange={event => setSetId(event.target.value)} maxLength={80} /></label>
        <label>Set name <input value={setName} onChange={event => setSetName(event.target.value)} maxLength={160} /></label>
        <label>Collector number <input value={number} onChange={event => setNumber(event.target.value)} maxLength={80} /></label>
        <label>English name <input value={name} onChange={event => setEnglishName(event.target.value)} maxLength={160} /></label>
      </> : <>
        <label>Printing ID <input value={target} onChange={event => setTarget(event.target.value)} required /></label>
        <label>Physical variant details <input value={descriptor} onChange={event => setDescriptor(event.target.value)} placeholder="Finish, foil pattern, stamp, size…" /></label>
      </>}
      <label>Evidence link <input type="url" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      <label>What is missing? <textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} /></label>
      <button type="submit">Send private report</button>
    </form>
    <p role="status">{message}</p>
    <h3>Your reports</h3>
    {reports.length ? <ul>{reports.map(report => <li key={report.id}>
      <strong>{label(report)}</strong> · {report.status.replace('_', ' ')}
      {report.review_reason && <p>Owner response: {report.review_reason}</p>}
      {report.status === 'needs_info' && <div><label>Additional information <textarea value={responses[report.id] || ''} onChange={event => setResponses(previous => ({ ...previous, [report.id]: event.target.value }))} /></label>
        <button type="button" disabled={!responses[report.id]?.trim()} onClick={() => void respond(report.id)}>Send information</button></div>}
      {report.approved_printing_id && <p>Approved Printing: {report.approved_printing_id}</p>}
    </li>)}</ul> : <p>No reports yet.</p>}
  </section>;
}

function ReviewItem({ report, refresh }: { report: ReportView; refresh: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [setId, setSetId] = useState(report.set_id || '');
  const [setName, setSetName] = useState(report.set_name || '');
  const [number, setNumber] = useState(report.collector_number || '');
  const [name, setEnglishName] = useState(report.english_name || '');
  const [descriptor, setDescriptor] = useState(typeof report.descriptor?.label === 'string' ? report.descriptor.label : '');
  const [evidence, setEvidence] = useState(report.evidence_url || '');
  async function decision(value: 'needs_info' | 'reject' | 'approve') {
    setBusy(true); setMessage('');
    try {
      await decideMissingCardReport(report.id, {
        decision: value, reason, code: value === 'approve' ? code : null,
        set_id: setId, set_name: setName, collector_number: number, english_name: name,
        printing_id: report.printing_id, descriptor: report.kind === 'edition' ? { label: descriptor } : null,
        evidence_url: evidence || null,
      });
      setMessage('Review saved.'); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Review failed.'); }
    finally { setBusy(false); }
  }
  async function requestCode() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/auth/approval-code', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reportId: report.id, action: `approve_${report.kind}` }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(error.error || `Approval-code request failed (${response.status})`);
      }
      setMessage('Fresh approval code sent to your email.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to send code.'); }
    finally { setBusy(false); }
  }
  return <article>
    <h4>{label(report)} · {report.status.replace('_', ' ')}</h4>
    {report.note && <p>Reporter note: {report.note}</p>}
    {report.evidence_url && <p>Submitted evidence: <a href={report.evidence_url} target="_blank" rel="noreferrer">Open link</a></p>}
    {report.status === 'pending' || report.status === 'needs_info' ? <>
      {report.kind === 'printing' ? <>
        <label>Verified set ID <input value={setId} onChange={event => setSetId(event.target.value)} /></label>
        <label>Verified set name <input value={setName} onChange={event => setSetName(event.target.value)} /></label>
        <label>Verified collector number <input value={number} onChange={event => setNumber(event.target.value)} /></label>
        <label>Exact English name <input value={name} onChange={event => setEnglishName(event.target.value)} /></label>
      </> : <label>Distinct physical Variant Descriptor <input value={descriptor} onChange={event => setDescriptor(event.target.value)} /></label>}
      <label>Evidence link <input type="url" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      <label>Review reason <textarea value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button type="button" disabled={busy || !reason.trim()} onClick={() => void decision('needs_info')}>Request information</button>
      <button type="button" disabled={busy || !reason.trim()} onClick={() => void decision('reject')}>Reject</button>
      <button type="button" disabled={busy} onClick={() => void requestCode()}>Send approval code</button>
      <label>Fresh six-digit code <input value={code} onChange={event => setCode(event.target.value)} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} /></label>
      <button type="button" disabled={busy || !reason.trim() || !/^[0-9]{6}$/.test(code)} onClick={() => void decision('approve')}>Approve shared record</button>
    </> : <p>Owner response: {report.review_reason}</p>}
    <p role="status">{message}</p>
  </article>;
}

export function OwnerMissingCardReview() {
  const [reports, setReports] = useState<ReportView[]>([]);
  const [message, setMessage] = useState('');
  const [kind, setKind] = useState<Kind>('printing');
  const [setId, setSetId] = useState('');
  const [setName, setSetName] = useState('');
  const [number, setNumber] = useState('');
  const [englishName, setEnglishName] = useState('');
  const [printingId, setPrintingId] = useState('');
  const [descriptor, setDescriptor] = useState('');
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  async function refresh() {
    try { setReports(await getOwnerMissingCardReports()); setMessage(''); }
    catch { setMessage('Unable to load review queue.'); }
  }
  useEffect(() => { void refresh(); }, []);
  async function begin(event: FormEvent) {
    event.preventDefault();
    try {
      await beginOwnerMissingCardReport({
        kind, set_id: setId || null, set_name: setName || null,
        collector_number: number || null, english_name: englishName || null,
        printing_id: kind === 'edition' ? printingId : null,
        descriptor: kind === 'edition' && descriptor.trim() ? { label: descriptor.trim() } : null,
        evidence_url: evidence || null, note,
      });
      setMessage('Owner record draft started. Review it below.'); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Unable to begin record.'); }
  }
  return <section aria-label="Missing-card review queue"><h2>Missing-card review</h2>
    <form onSubmit={begin}><h3>Begin a record directly</h3>
      <label>Record type <select value={kind} onChange={event => setKind(event.target.value as Kind)}><option value="printing">Printing</option><option value="edition">Edition</option></select></label>
      {kind === 'printing' ? <>
        <label>Set ID <input value={setId} onChange={event => setSetId(event.target.value)} /></label>
        <label>Set name <input value={setName} onChange={event => setSetName(event.target.value)} /></label>
        <label>Collector number <input value={number} onChange={event => setNumber(event.target.value)} /></label>
        <label>Exact English name <input value={englishName} onChange={event => setEnglishName(event.target.value)} /></label>
      </> : <>
        <label>Printing ID <input value={printingId} onChange={event => setPrintingId(event.target.value)} required /></label>
        <label>Physical Variant Descriptor <input value={descriptor} onChange={event => setDescriptor(event.target.value)} /></label>
      </>}
      <label>Evidence link <input type="url" value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
      <label>Note <textarea value={note} onChange={event => setNote(event.target.value)} /></label>
      <button type="submit">Begin record</button>
    </form>
    <button type="button" onClick={() => void refresh()}>Refresh reports</button>
    <p role="status">{message}</p>
    {reports.length ? reports.map(report => <ReviewItem key={report.id} report={report} refresh={refresh} />) : <p>No reports.</p>}
  </section>;
}
