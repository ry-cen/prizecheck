import { useEffect, useRef, useState, type FormEvent } from 'react';
import { searchCatalog, type PrintingView } from './generated';
import { addHolding, getLeafHoldings, HoldingError, type HoldingView } from './holdings_generated';
import { MoveHoldings, type MoveDestination } from './MoveHoldings';
import './Holdings.css';

function descriptorText(descriptor: Record<string, unknown>) {
  if (typeof descriptor.label === 'string') return descriptor.label;
  return Object.entries(descriptor).map(([key, value]) => `${key}: ${String(value)}`).join(' · ') || 'Unspecified Variant';
}

function HoldingArt({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (!url || failed) return <div role="img" aria-label={`Artwork unavailable for ${name}`} className="holding-placeholder">Artwork unavailable</div>;
  return <img src={url} alt={`${name} card art`} onError={() => setFailed(true)} />;
}

/** Mount inside the selected Storage Leaf's contents area. */
export function Holdings({ locationId, locationName, destinations, onMoveReady, onInventoryChanged }: { locationId: string; locationName: string; destinations: MoveDestination[]; onMoveReady?: (move: ((destinationId: string) => void) | null) => void; onInventoryChanged?: () => Promise<void> | void }) {
  const [holdings, setHoldings] = useState<HoldingView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<PrintingView[]>([]);
  const [editionId, setEditionId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pendingKey = useRef<string | null>(null);

  async function load(next?: string) {
    try {
      const result = await getLeafHoldings(locationId, next);
      setHoldings(previous => next ? [...previous, ...result.holdings] : result.holdings);
      setCursor(result.next_cursor);
      await onInventoryChanged?.();
    } catch (cause) {
      if (cause instanceof HoldingError && (cause.code === 'INVENTORY_CHANGED' || cause.code === 'CATALOG_CHANGED')) {
        const first = await getLeafHoldings(locationId);
        setHoldings(first.holdings); setCursor(first.next_cursor);
        setMessage('Cards changed. Showing the latest page.');
      } else setMessage('Cards are temporarily unavailable. Please retry.');
    }
  }
  useEffect(() => { setHoldings([]); setCursor(null); setMatches([]); setEditionId(''); setMessage(''); void load(); }, [locationId]);

  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true); setMessage('');
    try {
      const result = await searchCatalog({ name: query.trim() });
      setMatches(result.printings); setEditionId('');
      if (!result.available) setMessage('The catalog is unavailable until its first pull.');
      else if (!result.printings.length) setMessage('No matching Printings.');
    } catch { setMessage('Search is temporarily unavailable. Please retry.'); }
    finally { setBusy(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!editionId || !/^[0-9]+$/.test(quantity) || BigInt(quantity) < 1n || BigInt(quantity) > 9223372036854775807n) {
      setMessage('Choose an Edition and enter a positive whole quantity.'); return;
    }
    setBusy(true); setMessage('');
    const key = pendingKey.current ?? crypto.randomUUID();
    pendingKey.current = key;
    try {
      const result = await addHolding({ location_id: locationId, edition_id: editionId, quantity, idempotency_key: key });
      pendingKey.current = null;
      await load();
      setMessage(`Added. This stack now has ${result.quantity} copies in ${locationName}.`);
      setAdding(false); setMatches([]); setEditionId(''); setQuantity('1');
    } catch (cause) {
      const code = cause instanceof HoldingError ? cause.code : '';
      if (code === 'EDITION_UNAVAILABLE') { pendingKey.current = null; setMessage('That Edition is no longer available to Add. Search again.'); }
      else if (code === 'QUANTITY_OVERFLOW' || code === 'INVALID_QUANTITY') { pendingKey.current = null; setMessage('The quantity is invalid or too large.'); }
      else if (code === 'LOCATION_NOT_FOUND') { pendingKey.current = null; setMessage('This Storage Leaf is unavailable. Refresh Locations.'); }
      else setMessage('Add may have completed. Retry to check safely.');
    } finally { setBusy(false); }
  }

  return <section className="holdings-panel" aria-label={`Cards in ${locationName}`}>
    <div className="holdings-heading"><h3>Cards in this Location</h3><button type="button" onClick={() => { setAdding(value => !value); setMessage(''); }}>Add cards</button></div>
    {holdings.length ? <ul className="holding-grid">{holdings.map(item => <li key={item.edition_id}>
      <article className="holding-stack" tabIndex={0} aria-label={`${item.printing_name}, ${item.set_name} number ${item.collector_number}, ${descriptorText(item.descriptor)}, ${item.quantity} copies in ${item.location_name}`}>
        <HoldingArt url={item.image_url} name={item.printing_name} />
        <strong className="holding-count">×{item.quantity}</strong>
        <div className="holding-details"><strong>{item.printing_name}</strong><span>{item.set_name} ({item.set_id}) · #{item.collector_number}</span><span>{descriptorText(item.descriptor)}</span><span>{item.location_name}</span></div>
      </article>
    </li>)}</ul> : <p>No cards here yet.</p>}
    {cursor && <button type="button" onClick={() => void load(cursor)}>More cards</button>}
    <MoveHoldings locationId={locationId} holdings={holdings} destinations={destinations} onMoved={() => load()} onMoveReady={onMoveReady} />
    {adding && <div className="holding-add"><h4>Add a Card Edition to {locationName}</h4>
      <form onSubmit={search}><label>Search English card name <input value={query} onChange={event => { setQuery(event.target.value); pendingKey.current = null; }} required maxLength={120} /></label><button disabled={busy}>Search</button></form>
      {matches.length > 0 && <form onSubmit={add}><label>Card Edition <select required value={editionId} onChange={event => { setEditionId(event.target.value); pendingKey.current = null; }}><option value="">Choose a Printing and Edition</option>{matches.flatMap(printing => printing.editions.filter(edition => edition.active).map(edition => <option key={edition.id} value={edition.id}>{printing.name} · {printing.set_name} #{printing.collector_number} · {descriptorText(edition.descriptor)}</option>))}</select></label>
        <label>Quantity <input inputMode="numeric" pattern="[0-9]+" required value={quantity} onChange={event => { setQuantity(event.target.value); pendingKey.current = null; }} /></label>
        <button disabled={busy || !editionId}>{busy ? 'Adding…' : 'Add to Location'}</button></form>}
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
