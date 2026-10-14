import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getPublication, publishDeck, republishDeck, revokeDeck, PublicationError, setPublicationVisibility, type PublicationStatus } from './publications_generated';

export function PublishDeck({ deckId }: { deckId: string }) {
  const [publication, setPublication] = useState<PublicationStatus | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef<{ action: string; title: string; key: string; visibility?: 'listed' | 'unlisted' } | null>(null);
  async function load() {
    const status = await getPublication(deckId);
    setPublication(status); setTitle(status.title ?? '');
  }
  useEffect(() => { setPublication(null); setTitle(''); setMessage(''); pending.current = null;
    void load().catch(() => setMessage('Publication status unavailable. Retry loading it.')); }, [deckId]);

  async function act(action: 'publish' | 'republish' | 'revoke' | 'visibility', visibility?: 'listed' | 'unlisted') {
    setBusy(true); setMessage('');
    const retry = pending.current?.action === action && pending.current.visibility === visibility;
    const attempt = retry ? pending.current! : { action, title, key: crypto.randomUUID(), visibility };
    pending.current = attempt;
    try {
      if (attempt.action === 'visibility') await setPublicationVisibility(deckId, { visibility: attempt.visibility!, idempotency_key: attempt.key });
      else if (attempt.action === 'revoke') await revokeDeck(deckId, { idempotency_key: attempt.key });
      else {
        const command = { title: attempt.title, idempotency_key: attempt.key };
        await (attempt.action === 'publish' ? publishDeck : republishDeck)(deckId, command);
      }
      pending.current = null; await load();
      setMessage(attempt.action === 'revoke' ? 'Public link revoked permanently.' : attempt.action === 'visibility' ? 'Public visibility updated.' : 'Published snapshot updated.');
    } catch (cause) {
      if (cause instanceof PublicationError && cause.status < 500) {
        pending.current = null; setMessage(cause.status === 422 ? 'Use a plain-text public title of at most 120 characters, without markup or links.' : cause.code === 'TARGET_FORMAT_NOT_LEGAL' ? 'Publishing needs a legal result in this Deck\'s Target Format. Open the result next to the Target Format to see the issues.' : 'Publication changed. Refresh its status before continuing.');
      } else setMessage('Publication has not been confirmed. Retry the same action to recover safely.');
    } finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void act(publication?.token ? 'republish' : 'publish'); }
  return <section aria-label="Publish Deck"><h3>Publish a snapshot</h3>
    <p>Anyone with an Unlisted link can view the snapshot. Your private Deck name and other Locations stay private. Private edits appear only after you republish.</p>
    {publication ? <><form onSubmit={submit}><label>Public title <input required maxLength={120} value={title} disabled={busy || !!pending.current} onChange={event => setTitle(event.target.value)} /></label>
      <button disabled={busy}>{pending.current && ['publish','republish'].includes(pending.current.action) ? 'Retry publication' : publication.token ? 'Republish snapshot' : 'Publish Unlisted snapshot'}</button></form>
      {publication.token && <><p>Snapshot version {publication.version} · {publication.visibility}</p>
        <a href={`/published/${publication.token}`} target="_blank" rel="noreferrer">View public snapshot</a>
        <p>Listed snapshots appear in public discovery and sitemaps. Changing visibility preserves this snapshot and its version.</p>
        <button type="button" disabled={busy} onClick={() => void act('visibility', publication.visibility === 'listed' ? 'unlisted' : 'listed')}>{publication.visibility === 'listed' ? 'Make Unlisted' : 'List in public discovery'}</button>
        <p>Revoking burns this link permanently. Copies already saved by recipients cannot be recalled.</p>
        <button type="button" disabled={busy} onClick={() => void act('revoke')}>Revoke public link</button></>}
      {publication.projection_pending && <p role="status">The public projection needs recovery. Retry the last action.</p>}
    </> : <button type="button" onClick={() => void load().catch(() => setMessage('Publication status unavailable.'))}>Load publication status</button>}
    {message && <p role="status">{message}</p>}
  </section>;
}
