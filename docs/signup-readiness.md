# Public signup and email adapters

Signup remains owner-only by default. `SIGNUP_MODE=local-public` enables local rehearsal with file or relay mail and is forbidden in production. No configuration was changed on a running production environment. Sender verification, real recipient delivery, owner walkthrough and production recovery/performance acceptance remain independent proofs.

`SIGNUP_MODE=public` requires `MAIL_MODE=http`, `RELEASE_COMMIT` (full forty-character commit), and `SIGNUP_READINESS_FILE` pointing to operator-maintained JSON:

```json
{
  "schemaVersion": 1,
  "releaseCommit": "exact forty-character deployed commit",
  "authorizedByOwner": true,
  "senderVerified": true,
  "recipientDeliveryVerified": true,
  "ownerWalkthroughVerified": true,
  "recoveryVerified": true,
  "privacyVerified": true,
  "capacityVerified": true,
  "evidence": "Location of the dated acceptance proofs"
}
```

This is an explicit operator attestation, not automatic verification of a sender domain or proof that measurements passed. Do not fill it with unverified claims. Missing/invalid attestations or a mismatched release commit prevent gateway startup; changing the release requires renewed acceptance. Keep it private and review changes before restarting the gateway. No ready production attestation is supplied by this repository.

The concrete HTTP mail adapter requires `MAIL_RELAY_URL`, `MAIL_RELAY_TOKEN` and `MAIL_FROM`. It sends an authenticated POST with a JSON `{from,to,subject,text}` envelope. The relay must accept the email for delivery with a 2xx response; failure, redirects and a five-second timeout reject delivery. Production requires HTTPS and URL credentials are refused. Plain HTTP is restricted to loopback local rehearsals. Response bodies are discarded because they may contain personal information. Logs never include relay tokens, recipients or OTPs. A selected provider can be connected through a small translating relay or by replacing this adapter; arbitrary provider APIs do not necessarily accept this envelope. Console/file modes remain local-only.

The PostgreSQL user-insert trigger creates the collector's inventory owner and Unsorted Storage Leaf within the same statement transaction as Better Auth account creation. A failed Storage Leaf creation rolls back the account, with no delivered session cookie. Returning collectors keep their immutable account ID and existing Unsorted. Owner privileges remain bound through `owner_binding`, never the new collector's email. Existing-account onboarding compatibility remains available at the protected inventory API for pre-trigger accounts.

Local HTTP/PostgreSQL tests create fresh disposable databases and cover public signup, repeat signin, collector denial at owner approval boundary, injected onboarding failure, closed readiness gates, relay acceptance/failure/timeout. They do not claim real email recipient delivery, full desktop/mobile walkthrough, or production launch readiness.
