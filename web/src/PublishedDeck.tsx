import { useEffect, useState } from 'react';
import { getPublicDeckPage, PublicationError, type PublicSnapshot } from './publications_generated';

const labels: Record<string, string> = { basic_energy_exempt: 'Basic Energy exemption supported', unresolved: 'Basic Energy classification unresolved', over_limit: 'Over four-copy limit', within_limit: 'Within four-copy limit' };

function EditionImage({ image, name }: { image: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return image && !failed ? <img src={image} alt={`${name} card art`} loading="lazy" width="120" onError={() => setFailed(true)} /> : <p>Artwork unavailable</p>;
}

export function PublishedDeck({ token }: { token: string }) {
  const [snapshot, setSnapshot] = useState<PublicSnapshot | null>(null);
  const [message, setMessage] = useState('Loading snapshot…');
  useEffect(() => {
    let active = true;
    setSnapshot(null); setMessage('Loading snapshot…');
    void getPublicDeckPage(token).then(result => { if (active) { setSnapshot(result.snapshot); robots.content = result.robots; setMessage(''); } }).catch(cause => {
      if (active) setMessage(cause instanceof PublicationError && cause.status === 404 ? 'Published Deck not found.' : 'Published Deck temporarily unavailable. Reload to retry.');
    });
    const robots = document.createElement('meta'); robots.name = 'robots'; robots.content = 'noindex, nofollow'; document.head.append(robots);
    return () => { active = false; robots.remove(); };
  }, [token]);
  return <main aria-label="Published Deck">{snapshot ? <><h1>{snapshot.title}</h1>
    <p>Published {new Date(snapshot.published_at).toLocaleString()} · Snapshot version {snapshot.version}</p>
    <p>{snapshot.total} cards · {snapshot.checks.size_status === 'complete' ? 'Exactly 60 cards' : snapshot.checks.size_status === 'shortage' ? `${snapshot.checks.shortage} cards short of 60` : `${snapshot.checks.excess} cards over 60`}</p>
    <p>{snapshot.checks.disclaimer}</p><ul>{snapshot.checks.identities.map((check, index) => <li key={index}>{check.name} · {check.quantity} copies · {labels[check.status] ?? 'Check unresolved'}</li>)}</ul>
    <section aria-label="Published cards">{snapshot.identities.map((identity, index) => <details key={index}><summary>{identity.name} · {identity.quantity} copies</summary>
      <ul>{identity.editions.map((edition, editionIndex) => <li key={editionIndex}><EditionImage image={edition.image_url} name={identity.name} />
        <p>{edition.set_name} ({edition.set_id}) · #{edition.collector_number} · {edition.quantity} copies</p>
        <p>{Object.entries(edition.variant).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' · ') || 'Unspecified Variant'}</p>
      </li>)}</ul></details>)}</section>
    <p>Card metadata and images from TCGdex. Not endorsed by Nintendo, The Pokémon Company, or TCGdex.</p>
  </> : <p role="status">{message}</p>}</main>;
}
