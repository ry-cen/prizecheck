import { useEffect, useState } from 'react';
import { getOperationsStatus, type OperationsStatus } from './generated';

export function OperationsHealth() {
  const [status, setStatus] = useState<OperationsStatus | null>(null);
  const [error, setError] = useState(false);
  async function refresh() {
    try { setStatus(await getOperationsStatus()); setError(false); }
    catch { setError(true); }
  }
  useEffect(() => { void refresh(); }, []);
  const when = (value: string | null) => value ? new Date(value).toLocaleString() : 'Unverified';
  return <section aria-label="Operational health"><h2>Operational health</h2>
    <button onClick={() => void refresh()}>Refresh operational health</button>
    {error && <p role="alert">Operational health temporarily unavailable.</p>}
    {status && <>
      <p role={status.backup_state === 'stale' || status.backup_stale ? 'alert' : 'status'}>Backup: {status.backup_state}. Last success: {when(status.backup_last_success)}. Failed jobs: {status.backup_failures}.</p>
      <p>Disposable restore: {when(status.restore_last_success)}. Failed restores: {status.restore_failures}.</p>
      <p>Backup watchdog: {when(status.watchdog_last_check)}. Stale backup alerts: {status.backup_alerts}.</p>
      <p>Sign-in requests in 24 hours: {status.sign_in_requests_24h}. Recorded delivery: {status.sign_in_delivered ?? 'Unverified'}. Delivery failures: {status.sign_in_failed ?? 'Unverified'}.</p>
      <p>Private API in 24 hours: {status.api_requests_24h} requests, {status.api_failures_24h} failures, {status.authorization_denials_24h} authorization denials. Recorded gateway denials: {status.gateway_authorization_denials}. Mean response: {status.api_mean_ms_24h === null ? 'Unverified' : `${Math.round(status.api_mean_ms_24h)} ms`}.</p>
      <p>Catalog failures: {status.catalog_failures}. Pending catalog reviews: {status.catalog_pending_reviews}.</p>
      <p>Public projection failures: {status.projection_failures}. Pending projections: {status.projection_pending}. Release failures: {status.release_failures}.</p>
      <p>Provider allowances: {status.provider_quotas === 'unverified' ? 'Unverified' : 'Recorded measurements'}.</p>
      {status.quotas.map(quota => <p key={quota.resource} role={quota.warning && quota.verified ? 'alert' : 'status'}>{quota.resource}: {quota.verified ? `${quota.used} / ${quota.allowance}${quota.warning ? ' — 70% warning' : ''}` : 'Unverified: measurement is stale'}</p>)}
    </>}
  </section>;
}
