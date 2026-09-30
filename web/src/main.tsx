import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getLocations, getCatalogStatus, getOwnerCatalogStatus, startCatalogRun, type Location, type CatalogStatus, type OwnerCatalogStatus } from './generated';
import { LocationTree } from './LocationTree';
import { CatalogSearch } from './CatalogSearch';
import { MissingCardReports, OwnerMissingCardReview } from './MissingCardReports';
import './style.css';

type Session = { signedIn: boolean; userId: string | null };
function safeDestination(): string {
  const value = new URLSearchParams(location.search).get('next');
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/locations';
  const url = new URL(value, location.origin);
  return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : '/locations';
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [catalog, setCatalog] = useState<CatalogStatus | null>(null);
  const [ownerCatalog, setOwnerCatalog] = useState<OwnerCatalogStatus | null>(null);
  const [showOwner, setShowOwner] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    try {
      const response = await fetch('/auth/session', { credentials: 'same-origin' });
      const result = await response.json() as Session;
      setSession(result);
      if (result.signedIn) {
        setLocations((await getLocations()).locations);
        setCatalog(await getCatalogStatus());
        setOwnerCatalog(await getOwnerCatalogStatus());
      }
    } catch {
      setMessage('Service temporarily unavailable. Please retry.');
    }
  }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!showOwner || !ownerCatalog?.run || ownerCatalog.run.outcome) return;
    const timer = window.setInterval(() => { void getOwnerCatalogStatus().then(result => { setOwnerCatalog(result); if (result) setCatalog(result.catalog); }).catch(() => setMessage('Catalog status temporarily unavailable.')); }, 5000);
    return () => window.clearInterval(timer);
  }, [showOwner, ownerCatalog?.run?.outcome]);

  async function beginCatalogRun() {
    setMessage('');
    try { setOwnerCatalog(await startCatalogRun()); }
    catch { setMessage('Unable to start catalog pull. Please retry.'); }
  }

  async function requestCode(event: React.FormEvent) {
    event.preventDefault(); setMessage('');
    const response = await fetch('/auth/request-code', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
    if (!response.ok) { setMessage('Unable to request a code. Please retry.'); return; }
    setSent(true);
    setMessage('If this account can sign in, a code has been sent.');
  }

  async function verifyCode(event: React.FormEvent) {
    event.preventDefault(); setMessage('');
    const response = await fetch('/auth/verify-code', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, code }) });
    if (!response.ok) { setMessage('Invalid or expired code. Request a new code.'); return; }
    history.replaceState(null, '', safeDestination());
    await refresh();
  }

  async function signOut() {
    const response = await fetch('/auth/sign-out', { method: 'POST', credentials: 'same-origin' });
    if (response.ok) { setSession({ signedIn: false, userId: null }); setLocations([]); setCatalog(null); setOwnerCatalog(null); setShowOwner(false); setShowCatalog(false); setShowReports(false); history.replaceState(null, '', '/locations'); }
  }

  if (session === null) return <main><h1>TCG Collection</h1><p>Loading…</p><p role="alert">{message}</p></main>;
  if (!session.signedIn) return <main className="auth"><h1>TCG Collection</h1><p>Sign in with a code sent to your email.</p><form onSubmit={requestCode}><label>Email <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)}/></label><button>Send code</button></form>{sent && <form onSubmit={verifyCode}><label>Six-digit code <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value)}/></label><button>Sign in</button></form>}<p role="status">{message}</p></main>;
  return <main><header><h1>{showOwner ? 'Owner controls' : showReports ? 'Missing cards' : showCatalog ? 'Catalog' : 'Locations'}</h1><button onClick={signOut}>Sign out</button></header>
    <nav><button onClick={() => { setShowOwner(false); setShowCatalog(false); setShowReports(false); }}>Locations</button><button onClick={() => { setShowOwner(false); setShowCatalog(true); setShowReports(false); }}>Catalog</button><button onClick={() => { setShowOwner(false); setShowCatalog(false); setShowReports(true); }}>Missing cards</button>{ownerCatalog && <button onClick={() => { setShowOwner(true); setShowCatalog(false); setShowReports(false); }}>Owner controls</button>}</nav>
    {showOwner && ownerCatalog ? <section aria-label="Catalog pull">
      <h2>English catalog pull</h2>
      <p>{ownerCatalog.catalog.available ? `Last successful pull: ${new Date(ownerCatalog.catalog.last_success!).toLocaleString()}` : 'Catalog unavailable until the first complete import.'}</p>
      <button disabled={!!ownerCatalog.run && !ownerCatalog.run.outcome} onClick={() => void beginCatalogRun()}>Start full English pull</button>
      <button onClick={() => void getOwnerCatalogStatus().then(result => { setOwnerCatalog(result); if (result) setCatalog(result.catalog); }).catch(() => setMessage('Catalog status temporarily unavailable.'))}>Refresh status</button>
      {ownerCatalog.run && <article><h3>Run {ownerCatalog.run.id}</h3><p>Phase: {ownerCatalog.run.phase}</p><p>Enumerated: {ownerCatalog.run.enumerated_count} · Fetched: {ownerCatalog.run.fetched_count} · Validated: {ownerCatalog.run.validated_count}</p><p>Result: {ownerCatalog.run.outcome ?? 'In progress'}</p>{ownerCatalog.run.error && <p role="alert">{ownerCatalog.run.error}</p>}</article>}
      <h3>Pending review ({ownerCatalog.pending_reviews.length})</h3>
      {ownerCatalog.pending_reviews.map(item => <article key={item.id}><strong>{item.kind}</strong> · {item.source_id}<p>{item.detail}</p></article>)}
      <OwnerMissingCardReview />
    </section> : showReports ? <MissingCardReports /> : showCatalog ? <CatalogSearch /> : <><p>Your private physical storage.</p><p>{catalog?.available ? `English catalog last pulled ${new Date(catalog.last_success!).toLocaleString()}.` : 'Catalog unavailable until the first complete import.'}</p><LocationTree /></>}
    <p role="alert">{message}</p></main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
