# Production launch acceptance — separate from provider-agnostic implementation

Date: 2026-10-06. Owner scope decision: ADR 0004. No production provisioning is authorized by this checklist. Implementation tickets can close on vendor-neutral executable code and local tests; the following remain unverified until performed in the actual launch environment.

- [ ] Select deployment services, configure same-origin TLS/private listeners, independent schedules, quotas and cost allowances.
- [ ] Verify an owner-controlled sending domain and real owner plus non-owner email-code delivery/sign-in.
- [ ] Run the first complete live English catalog import and the agreed representative workload; record browser p95, ordinary actions, 25,000-Edition Move/progress, cold/warm/runtime/database bytes and monthly cost.
- [ ] Prove private remote seven-daily/four-weekly backups, disposable recovery, independent missed-backup detection and eligible notification delivery.
- [ ] Prove authoritative exact-main CI gate, production serialized release, protected/public smoke and compatible rollback.
- [ ] Owner completes desktop/mobile search, Add, Move, Undo, Deck check, publish, anonymous view, republish and revoke journeys.
- [ ] Accept that stored TCGplayer card images are served from our origin without TCGplayer's written permission ([ADR 0024](../../adr/0024-store-tcgplayer-art-copies.md)). To answer a takedown request: set `ART_TCGPLAYER_SOURCE=off` in the host env file, run `prizecheck-deploy.sh compose up -d api` (new TCGplayer copies stop, and public pages stop showing stored ones), then run `prizecheck-deploy.sh tool /app/scripts/art_store.py purge-tcgplayer` to delete the stored TCGplayer objects and their comparison records. TCGplayer art then goes back to links.
- [ ] Record release commit, fresh recovery, privacy/cross-owner/public/email burst/failure/load evidence and accepted nonblocking deviations before enabling production public signup.

Privacy, authorization, atomicity, integrity, recovery or required performance/capacity failures block public launch. Local fixtures and synthetic SMTP acceptance cannot mark these real-world checks complete.
