import { useEffect, useState, type FormEvent } from 'react';
import { createDeck, getDeck, getDecks, DeckError, type DeckDetail, type TreeNode } from './decks_generated';
import { getLocationTree } from './location_generated';
import { Holdings } from './Holdings';
import { PublishDeck } from './PublishDeck';

export function Decks() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [decks, setDecks] = useState<TreeNode[]>([]);
  const [leaves, setLeaves] = useState<TreeNode[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeckDetail | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<{ name: string; key: string } | null>(null);

  async function loadIndex() {
    const [index, tree] = await Promise.all([getDecks(), getLocationTree()]);
    setDecks(index.decks); setCursor(index.next_cursor); setLeaves(tree.locations.filter(item => item.kind !== 'organization'));
  }
  async function moreDecks() {
    if (!cursor) return;
    try {
      const index = await getDecks(cursor); setDecks(previous => [...previous, ...index.decks]); setCursor(index.next_cursor);
    } catch (cause) {
      if (cause instanceof DeckError && cause.code === 'INVENTORY_CHANGED') {
        await loadIndex(); setMessage('Decks changed. Showing the first page.');
      } else setMessage('Decks are temporarily unavailable. Please retry.');
    }
  }
  async function refreshChecks(id: string) {
    try { setDetail(await getDeck(id)); }
    catch { setMessage('Deck checks are temporarily unavailable. Refresh checks to retry.'); }
  }
  useEffect(() => { void loadIndex().catch(() => setMessage('Decks are temporarily unavailable. Please retry.')); }, []);
  useEffect(() => { setDetail(null); if (selected) void refreshChecks(selected); }, [selected]);

  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage('');
    const attempt = pending ?? { name, key: crypto.randomUUID() }; setPending(attempt);
    try {
      const result = await createDeck({ name: attempt.name, idempotency_key: attempt.key });
      setPending(null); setName(''); await loadIndex(); setSelected(result.location.id);
    } catch (cause) {
      if (cause instanceof DeckError && cause.status < 500) {
        setPending(null); setMessage(cause.code === 'LOCATION_NAME_CONFLICT' ? 'Choose a different Deck name.' : 'Enter a valid Deck name.');
      } else setMessage('Creation may have completed. Retry to check safely.');
    } finally { setBusy(false); }
  }
  const labels: Record<string, string> = { basic_energy_exempt: 'Basic Energy exemption supported', unresolved: 'Basic Energy classification unresolved; exemption not established', over_limit: 'Over four-copy limit', within_limit: 'Within four-copy limit' };
  return <section aria-label="Physical Decks">
    <h2>Physical Decks</h2>
    <p>Decks contain the cards physically stored in them. Incomplete Decks remain usable.</p>
    <form onSubmit={create}><label>Deck name <input required maxLength={120} value={name} onChange={event => { setName(event.target.value); setPending(null); }} /></label><button disabled={busy}>Create Deck</button></form>
    <nav aria-label="Deck index">{decks.map(deck => <button type="button" key={deck.id} onClick={() => setSelected(deck.id)} aria-current={selected === deck.id ? 'page' : undefined}>{deck.name}</button>)}</nav>
    {cursor && <button type="button" onClick={() => void moreDecks()}>More Decks</button>}
    {!decks.length && <p>No Decks yet.</p>}
    {detail && <section aria-label={`Checks for ${detail.deck.name}`}><h3>{detail.deck.name}</h3>
      <p>{detail.checks.total} cards · {detail.checks.size_status === 'complete' ? 'Exactly 60 cards' : detail.checks.size_status === 'shortage' ? `${detail.checks.shortage} cards short of 60` : `${detail.checks.excess} cards over 60`}</p>
      <ul>{detail.checks.identities.map(identity => <li key={identity.identity_id}>{identity.name} · {identity.quantity} copies · {labels[identity.status] ?? 'Check unresolved'}</li>)}</ul>
      <p>{detail.checks.disclaimer}</p><button type="button" onClick={() => void refreshChecks(detail.deck.id)}>Refresh checks</button>
      <Holdings key={detail.deck.id} locationId={detail.deck.id} locationName={detail.deck.name} destinations={leaves} onInventoryChanged={() => refreshChecks(detail.deck.id)} />
      <PublishDeck key={detail.deck.id} deckId={detail.deck.id} />
    </section>}
    {message && <p role="status">{message}</p>}
  </section>;
}
