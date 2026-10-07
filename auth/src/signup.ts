import { readFileSync } from 'node:fs';

/** Opening signup is an operator action bound to independently recorded proof. */
export function signupEnabled(): boolean {
  const mode = process.env.SIGNUP_MODE || 'owner-only';
  if (mode === 'owner-only') return false;
  if (mode === 'local-public' && process.env.NODE_ENV !== 'production') return true;
  if (mode !== 'public') throw new Error('Invalid signup configuration');
  const path = process.env.SIGNUP_READINESS_FILE;
  const commit = process.env.RELEASE_COMMIT;
  if (!path || !commit || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Signup readiness required');
  const proof = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const gates = ['authorizedByOwner', 'senderVerified', 'recipientDeliveryVerified', 'ownerWalkthroughVerified', 'recoveryVerified', 'privacyVerified', 'capacityVerified'];
  if (proof.schemaVersion !== 1 || proof.releaseCommit !== commit ||
      !gates.every(gate => proof[gate] === true) || typeof proof.evidence !== 'string' || !proof.evidence.trim()) {
    throw new Error('Signup readiness incomplete');
  }
  if (process.env.MAIL_MODE !== 'http') throw new Error('Public signup requires real mail delivery');
  return true;
}
