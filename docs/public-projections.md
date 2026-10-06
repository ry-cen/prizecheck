# Local public Deck object projection

Anonymous Deck reads open only the sanitized projection in `PUBLIC_PROJECTION_DIR` (default `.local/public-projections`). They never connect to PostgreSQL or look up a session. The JSON response allowlist is defined by `PublicSnapshot`; nested models reject extra fields. React renders source metadata and titles as text. Unlisted snapshots use `noindex, nofollow`, and all snapshot responses use `Cache-Control: no-store`.

Before starting a NEW local environment, initialize its empty object store:

```sh
PUBLIC_PROJECTION_DIR=/absolute/path/public-projections .venv/bin/python scripts/init_public_projection.py
```

Keep that path in the API environment and outside any static-file web root. All API processes must share the same writable filesystem. The local adapter uses a process lock, fsync, and atomic file replacement to switch the complete public snapshot/discovery manifest. No public snapshot history is retained. The adapter assumes macOS/Linux filesystem semantics and is a development boundary; deployment provider selection must supply shared storage with equivalent serialization and atomic updates. Public snapshots and their visibility are the only content in this projection; owner linkage, command records, and token tombstones remain private PostgreSQL data.

A publication command commits its token linkage and a sanitized projection operation to a durable private outbox, then applies the public operation. It returns success only after the complete object switch. An interrupted or failed object write returns `503 PUBLICATION_UNAVAILABLE`; the prior complete object remains available when replacement did not occur. Retry with the same idempotency key. Any subsequent authorized publication command first drains pending operations in order, so it cannot overwrite a newer result with an older retry. A crash after the object switch repeats that same operation safely. No scheduler or polling worker is required. Revocation removes the public token object and permanently records the burned token privately; publishing again generates a fresh 192-bit token.

Missing or corrupt object storage returns `503 PUBLIC_PROJECTION_UNAVAILABLE`, rather than pretending the Deck was deleted. Do not initialize an empty manifest to recover lost storage. Restore the public store from its backup, or rebuild it from the private publication command history with revoked-token and visibility state preserved. Back up this private command history together with publication linkage. Never expose those private tables or records through an anonymous route. A public store failure does not report successful publication or revocation.

CI must use a disposable database and a fresh `PUBLIC_PROJECTION_DIR`, initialize the store before browser tests, and remove it afterward. Individual HTTP tests isolate their object stores. Hosting and object-storage vendors remain unselected under ADR 0002.
