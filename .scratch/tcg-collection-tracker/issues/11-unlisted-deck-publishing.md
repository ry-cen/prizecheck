# 11 — Unlisted Deck publishing

**Label:** ready-for-agent

**Blocked by:** 10 — Physical Decks and checks

**Status:** ready-for-agent

**What to build:** A Deck owner can publish a sanitized Unlisted snapshot at an unguessable URL, intentionally republish later changes, and revoke the link permanently.

- [ ] First publish asks for a separate escaped plain-text title of at most 120 characters and creates a token with at least 192 bits of entropy. The snapshot includes timestamp/version, total, Card Identity groups, Edition details, images, and supported checks.
- [ ] Public serialization excludes account ID/email, private Deck/Location identifiers, names and paths, Collection totals, non-Deck Holdings, and operational fields. Anonymous reads use a sanitized public object projection without a private database query.
- [ ] Private Deck edits do not alter the snapshot. Republish atomically replaces the active version at the stable URL and removes superseded public versions. Revoke burns the token; a later publish uses a new token.
- [ ] Unlisted pages stay out of public discovery and sitemaps and use `noindex, nofollow`. Unknown and revoked tokens have one not-found response; current changes affect the next request and snapshot JSON is not stored by browsers or shared caches.
- [ ] Browser/API/object-storage tests assert the exact public allowlist, anonymous usefulness, republish and revoke behavior, token resistance, and absence of private fields.
