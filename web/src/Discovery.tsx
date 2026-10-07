import { useEffect, useState, type FormEvent } from 'react';
import { discoverDecks, DiscoveryError, type PublicDeckSummary } from './discovery_generated';

export function Discovery() {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('');
  const [decks, setDecks] = useState<PublicDeckSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function load(q: string, next?: string) {
    setBusy(true); setMessage('');
    try {
      const page = await discoverDecks(q, next);
      setDecks(previous => next ? [...previous,...page.decks] : page.decks); setCursor(page.next_cursor); setFilter(q);
    } catch (cause) {
      if (cause instanceof DiscoveryError && cause.code === 'DISCOVERY_CHANGED') {
        const page = await discoverDecks(q); setDecks(page.decks); setCursor(page.next_cursor);
        setMessage('Published Decks changed. Showing the first page.');
      } else setMessage('Discovery temporarily unavailable. Retry your search.');
    } finally { setBusy(false); }
  }
  useEffect(() => { void load(''); }, []);
  function search(event: FormEvent) { event.preventDefault(); void load(query.trim()); }
  return <main aria-label="Public Deck discovery"><h1>Discover Listed Decks</h1>
    <p>Snapshots published by collectors. Basic checks do not establish Standard legality.</p>
    <form onSubmit={search}><label>Public title or card name <input maxLength={120} value={query} onChange={event => setQuery(event.target.value)} /></label><button disabled={busy}>Search Published Decks</button></form>
    {decks.length ? <ul>{decks.map(deck => <li key={deck.url}><article><h2><a href={deck.url}>{deck.title}</a></h2>
      {deck.image_url && <img src={deck.image_url} alt="Card preview" loading="lazy" width="80" />}
      <p>{deck.total} cards · Published {new Date(deck.published_at).toLocaleString()}</p>
      <p>{deck.checks.size_status === 'complete' ? 'Exactly 60 cards' : deck.checks.size_status === 'shortage' ? `${deck.checks.shortage} cards short of 60` : `${deck.checks.excess} cards over 60`} · {deck.checks.over_limit_groups} over-limit groups · {deck.checks.unresolved_groups} unresolved groups</p>
    </article></li>)}</ul> : !busy && <p>No matching Listed Decks.</p>}
    {cursor && <button type="button" disabled={busy} onClick={() => void load(filter,cursor)}>More Published Decks</button>}
    {message && <p role="status">{message}</p>}
  </main>;
}
