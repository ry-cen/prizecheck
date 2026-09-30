import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getLocations, type Location } from './generated';
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
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    try {
      const response = await fetch('/auth/session', { credentials: 'same-origin' });
      const result = await response.json() as Session;
      setSession(result);
      if (result.signedIn) setLocations((await getLocations()).locations);
    } catch {
      setMessage('Service temporarily unavailable. Please retry.');
    }
  }
  useEffect(() => { void refresh(); }, []);

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
    if (response.ok) { setSession({ signedIn: false, userId: null }); setLocations([]); history.replaceState(null, '', '/locations'); }
  }

  if (session === null) return <main><h1>TCG Collection</h1><p>Loading…</p><p role="alert">{message}</p></main>;
  if (!session.signedIn) return <main className="auth"><h1>TCG Collection</h1><p>Sign in with a code sent to your email.</p><form onSubmit={requestCode}><label>Email <input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)}/></label><button>Send code</button></form>{sent && <form onSubmit={verifyCode}><label>Six-digit code <input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e => setCode(e.target.value)}/></label><button>Sign in</button></form>}<p role="status">{message}</p></main>;
  return <main><header><h1>Locations</h1><button onClick={signOut}>Sign out</button></header><p>Your private physical storage.</p><section aria-label="Locations">{locations.map(item => <article key={item.id}><h2>{item.name}</h2><p>Storage Leaf</p><p>No cards here yet.</p></article>)}</section><p role="alert">{message}</p></main>;
}

createRoot(document.getElementById('root')!).render(<App/>);
