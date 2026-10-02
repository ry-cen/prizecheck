import { useState, type FormEvent } from 'react';
import { createLocation, deleteLocation, editLocation, LocationError, type TreeNode } from './location_generated';

export type SafetyIntent =
  | { action: 'create'; name: string; parent: TreeNode }
  | { action: 'move'; location: TreeNode; parent: TreeNode }
  | { action: 'delete'; location: TreeNode };

type Props = { intent: SafetyIntent; onDone: (locationId?: string) => void | Promise<void>; onCancel: () => void; onStale: () => void | Promise<void> };

export function LocationSafetyDialog({ intent, onDone, onCancel, onStale }: Props) {
  const [choice, setChoice] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const idempotency_key = crypto.randomUUID();
      if (intent.action === 'create') {
        const result = await createLocation({ name: intent.name, parent_id: intent.parent.id, parent_version: intent.parent.version,
          conversion: choice, idempotency_key });
        await onDone(result.location.id);
      } else if (intent.action === 'move') {
        const result = await editLocation(intent.location.id, { parent_id: intent.parent.id, parent_version: intent.parent.version,
          version: intent.location.version, conversion: 'create_unsorted_child', idempotency_key });
        await onDone(result.location.id);
      } else {
        if (confirmation !== intent.location.name) { setMessage('Enter the exact Location name to confirm.'); return; }
        await deleteLocation(intent.location.id, { name: confirmation, version: intent.location.version, idempotency_key });
        await onDone();
      }
    } catch (cause) {
      const code = cause instanceof LocationError ? cause.code : '';
      if (code === 'STALE_LOCATION' || code === 'LOCATION_NOT_FOUND') {
        setMessage('This Location changed. The tree has been refreshed; review it and try again.');
        await onStale();
      } else if (code === 'LOCATION_NOT_EMPTY') {
        setMessage('Delete is available only for a Location without cards or children.');
      } else if (code === 'LOCATION_NAME_CONFIRMATION_MISMATCH') {
        setMessage('Enter the exact Location name to confirm.');
      } else {
        setMessage('Unable to save this change. Please retry.');
      }
    } finally { setBusy(false); }
  }

  const deleting = intent.action === 'delete';
  return <form className="location-form" onSubmit={submit} aria-label={deleting ? 'Delete Location' : 'Convert Storage Leaf'}>
    <h3>{deleting ? 'Delete Location' : 'Convert Storage Leaf'}</h3>
    {intent.action === 'create' && <>
      <p>{intent.parent.name} contains cards. Choose where to keep them when creating {intent.name}.</p>
      <label><input type="radio" name="conversion" value="move_holdings_to_child" checked={choice === 'move_holdings_to_child'} onChange={event => setChoice(event.target.value)} /> Move cards into {intent.name}</label>
      <label><input type="radio" name="conversion" value="create_unsorted_child" checked={choice === 'create_unsorted_child'} onChange={event => setChoice(event.target.value)} /> Create a separate Unsorted child for cards</label>
    </>}
    {intent.action === 'move' && <p>{intent.parent.name} contains cards. Moving {intent.location.name} here creates an Unsorted child for those cards.</p>}
    {deleting && <><p>Delete {intent.location.name} only if it has no cards or child Locations.</p>
      <label>Type {intent.location.name} to confirm <input value={confirmation} onChange={event => setConfirmation(event.target.value)} autoFocus /></label></>}
    <div className="form-actions"><button disabled={busy || (intent.action === 'create' && !choice) || (deleting && confirmation !== intent.location.name)}>{busy ? 'Saving…' : deleting ? 'Delete Location' : 'Continue'}</button><button type="button" onClick={onCancel}>Cancel</button></div>
    <p role="alert">{message}</p>
  </form>;
}
