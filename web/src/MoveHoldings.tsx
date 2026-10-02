import { useEffect, useMemo, useRef, useState } from 'react';
import { getLeafHoldings, type HoldingView } from './holdings_generated';
import { commitMove, MoveError, stageMove, startMove, type MoveItem } from './moves_generated';
import './MoveHoldings.css';

export type MoveDestination = { id: string; name: string };
type PendingCommit = { manifestId: string; destinationId: string; key: string };

/** Visible selection controls for a Storage Leaf. The parent supplies all owned leaves. */
export function MoveHoldings({ locationId, holdings, destinations, onMoved, onMoveReady }: {
  locationId: string;
  holdings: HoldingView[];
  destinations: MoveDestination[];
  onMoved: () => Promise<void> | void;
  onMoveReady?: (move: ((destinationId: string) => void) | null) => void;
}) {
  const [selected, setSelected] = useState<Record<string, MoveItem>>({});
  const [fan, setFan] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState('');
  const pending = useRef<PendingCommit | null>(null);
  const dragSource = useRef<string | null>(null);
  const chosen = useMemo(() => Object.values(selected), [selected]);
  const copies = chosen.reduce((sum, item) => sum + BigInt(item.quantity), 0n);
  const validDestinations = destinations.filter(destination => destination.id !== locationId);
  const moveRef = useRef<(destinationId: string) => void>(() => undefined);
  moveRef.current = destinationId => { void move(destinationId); };
  useEffect(() => {
    onMoveReady?.(destinationId => moveRef.current(destinationId));
    return () => onMoveReady?.(null);
  }, [onMoveReady]);

  function select(item: HoldingView, amount: string) {
    pending.current = null;
    setSelected(previous => {
      const next = { ...previous };
      if (!/^[0-9]+$/.test(amount) || BigInt(amount) < 1n || BigInt(amount) > BigInt(item.quantity)) delete next[item.edition_id];
      else next[item.edition_id] = { edition_id: item.edition_id, quantity: amount, expected_version: item.version };
      return next;
    });
  }

  async function selectAll() {
    setBusy(true); setMessage(''); setProgress('Loading cards…'); pending.current = null;
    try {
      const all: HoldingView[] = [];
      let cursor: string | null = null;
      do {
        const page = await getLeafHoldings(locationId, cursor ?? undefined);
        all.push(...page.holdings);
        setProgress(`Loaded ${all.length} Editions…`);
        cursor = page.next_cursor;
      } while (cursor);
      setSelected(Object.fromEntries(all.map(item => [item.edition_id,
        { edition_id: item.edition_id, quantity: item.quantity, expected_version: item.version }])));
    } catch { setMessage('Cards changed while selecting. Refresh this Location and try again.'); }
    finally { setBusy(false); setProgress(''); }
  }

  async function refreshSelection() {
    if (busy || !chosen.length) return;
    setBusy(true); setMessage(''); setProgress('Refreshing selected cards…'); pending.current = null;
    try {
      const refreshed: Record<string, MoveItem> = {};
      let cursor: string | null = null;
      let checked = 0;
      do {
        const page = await getLeafHoldings(locationId, cursor ?? undefined);
        for (const item of page.holdings) {
          const old = selected[item.edition_id];
          if (old) refreshed[item.edition_id] = { ...old,
            quantity: (BigInt(old.quantity) < BigInt(item.quantity) ? old.quantity : item.quantity),
            expected_version: item.version };
        }
        checked += page.holdings.length;
        setProgress(`Checked ${checked} Editions…`);
        cursor = page.next_cursor;
      } while (cursor);
      setSelected(refreshed);
      await onMoved();
      setMessage(`${Object.keys(refreshed).length} Editions refreshed. Review quantities before moving.`);
    } catch { setMessage('Refresh failed. Your selection is still saved; try again.'); }
    finally { setBusy(false); setProgress(''); }
  }

  async function move(destinationId: string) {
    if (!chosen.length || busy || destinationId === locationId || !validDestinations.some(item => item.id === destinationId)) return;
    setBusy(true); setMessage(''); setProgress('Starting Move…');
    try {
      let attempt = pending.current;
      if (!attempt || attempt.destinationId !== destinationId) {
        const manifest = await startMove(locationId);
        for (let index = 0; index < chosen.length; index += 500) {
          await stageMove(manifest.id, chosen.slice(index, index + 500));
          setProgress(`Staged ${Math.min(index + 500, chosen.length)} of ${chosen.length} Editions…`);
        }
        attempt = { manifestId: manifest.id, destinationId, key: crypto.randomUUID() };
        pending.current = attempt;
      }
      setProgress(`Moving ${chosen.length} Editions…`);
      const result = await commitMove(attempt.manifestId, destinationId, attempt.key);
      pending.current = null;
      setSelected({}); setFan(null); setSheet(false);
      await onMoved();
      setMessage(`Moved ${result.copy_count} copies across ${result.edition_count} Editions.`);
    } catch (cause) {
      const code = cause instanceof MoveError ? cause.code : '';
      if (['STALE_HOLDING', 'INSUFFICIENT_QUANTITY', 'SAME_LOCATION', 'LOCATION_NOT_FOUND',
           'MOVE_MANIFEST_NOT_FOUND', 'MOVE_MANIFEST_EXPIRED', 'QUANTITY_OVERFLOW'].includes(code)) pending.current = null;
      const messages: Record<string, string> = {
        STALE_HOLDING: 'Cards changed in another tab. Your selection is saved; refresh and review quantities.',
        INSUFFICIENT_QUANTITY: 'There are not enough copies in this Location. Your selection is saved.',
        SAME_LOCATION: 'Choose a different Storage Leaf.',
        LOCATION_NOT_FOUND: 'That destination is unavailable. Your selection is saved.',
        MOVE_MANIFEST_EXPIRED: 'This selection expired. Try Move again; your selection is saved.',
        QUANTITY_OVERFLOW: 'The destination quantity would be too large. Your selection is saved.',
      };
      setMessage(messages[code] ?? 'Move may have completed. Retry to check safely; your selection is saved.');
    } finally { setBusy(false); setProgress(''); }
  }

  return <section className="move-holdings" aria-label="Move cards">
    <div className="move-toolbar"><button type="button" disabled={busy || !holdings.length} onClick={() => void selectAll()}>Select all in this Location</button>
      <button type="button" disabled={busy || !chosen.length} onClick={() => { setSelected({}); setFan(null); pending.current = null; }}>Clear selection</button>
      <button type="button" disabled={busy || !chosen.length} onClick={() => void refreshSelection()}>Refresh selection</button>
      <span aria-live="polite">{copies.toString()} copies · {chosen.length} Editions selected</span>
      <button type="button" disabled={busy || !chosen.length} onClick={() => setSheet(true)}>Move selected</button></div>
    {holdings.length > 0 && <ul className="move-selection-list">{holdings.map(item => <li key={item.edition_id}>
      <span>{item.printing_name} · {item.set_name} #{item.collector_number} · ×{item.quantity}</span>
      <button type="button" onClick={() => select(item, selected[item.edition_id] ? '0' : item.quantity)}>{selected[item.edition_id] ? 'Deselect stack' : 'Select stack'}</button>
      {selected[item.edition_id] && <button type="button" draggable onDragStart={event => {
        dragSource.current = locationId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', `tcg-move:${locationId}`);
      }} onDragEnd={() => { dragSource.current = null; }}
        aria-label={`Drag selected ${item.printing_name} stack`} className="move-drag-handle">Drag selected stack</button>}
      <button type="button" onClick={() => setFan(fan === item.edition_id ? null : item.edition_id)}>{fan === item.edition_id ? 'Hide copies' : 'Fan copies'}</button>
      {fan === item.edition_id && <div className="move-fan"><label>Selected copies
        <input type="number" min="0" max={item.quantity} value={selected[item.edition_id]?.quantity ?? '0'} onChange={event => select(item, event.target.value)} /></label>
        <div aria-label="Temporary copy handles">{Array.from({ length: Number(BigInt(item.quantity) < 20n ? BigInt(item.quantity) : 20n) }, (_, index) =>
          <button type="button" key={index} aria-label={`Select ${index + 1} ${item.printing_name} copies`} onClick={() => select(item, String(index + 1))}>{index + 1}</button>)}</div>
      </div>}
    </li>)}</ul>}
    {sheet && <div className="move-sheet" role="dialog" aria-label="Choose Move destination">
      <h4>Move {copies.toString()} copies to</h4>
      {validDestinations.length ? validDestinations.map(destination => <button type="button" key={destination.id} disabled={busy}
        onClick={() => void move(destination.id)}
        onDragOver={event => { if (dragSource.current === locationId) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
        onDrop={event => { event.preventDefault(); if (dragSource.current === locationId) void move(destination.id); dragSource.current = null; }}>
        {destination.name}</button>) : <p>No other Storage Leaf is available.</p>}
      <button type="button" onClick={() => setSheet(false)}>Cancel</button>
    </div>}
    {progress && <p role="status" aria-live="polite">{progress}</p>}
    {message && <p role="status">{message}</p>}
  </section>;
}
