# Decide the public Deck snapshot and privacy contract

**Parent:** [Decision-complete Pokémon TCG Collection Tracker MVP](../map.md)

**Label:** wayfinder:grilling

**Status:** closed

**Assignee:** codex

**Blocked by:** [Decide Card Edition and Card Identity](04-decide-card-edition-identity.md); [Decide the core Collection, Location, and Deck interaction contract](08-decide-core-interaction-contract.md).

**Resolution:** [Public Deck snapshot, discovery, and privacy contract](../resolutions/09-decide-public-deck-contract.md)

## Question

What exact private-to-public projection, token lifecycle, snapshot/version semantics, validation wording, metadata allowlist, cache behavior, abuse controls, and revocation guarantees let an owner share a useful Deck without disclosing account or Location information?

## Decisions in progress

- Full Standard-format legality remains a possible post-MVP feature. The MVP evaluates only the 60-card requirement, the name-based four-copy limit, verified Basic Energy exemptions, and explicit unresolved classifications.
- Private and public Deck views must display a neutral scope notice: `Basic deck checks only. Standard format eligibility, rotation, banned cards, and special card rules are not evaluated.` They must not label a Deck tournament-legal.
- The public response is an explicit allowlist containing only the owner-chosen public title, publication timestamp and snapshot version, total card count, cards grouped by Card Identity and quantity, expandable Edition details (set, collector number, variant, and image), and the supported basic-check results and scope notice.
- The public response excludes user identifiers, email, private Deck name and identifier, all Location identifiers/names/paths, Collection totals, non-Deck Holdings, and operational metadata.
- First publish creates a cryptographically random unguessable token and snapshot version. Private Deck edits do not affect it. Republish creates a new immutable version and atomically makes it current at the same active URL.
- Revocation permanently burns the token and makes it indistinguishable from an unknown token. Publishing the Deck again creates a new token; a revoked URL can never be revived.
- Public snapshot JSON is served through the Worker from the sanitized R2 projection with browser and shared-cache storage disabled. The static shell and card images may be cached. A successful republish or revoke is visible on the next snapshot request.
- The interface states that revocation prevents future access through the application but cannot erase screenshots, downloads, or other copies already made by recipients.
- Every Published Deck has `Listed` or `Unlisted` visibility. Listed snapshots appear in public discovery and search; Unlisted snapshots are excluded and reachable only through their unguessable URL. Both expose the same sanitized allowlist and never expose owner or Location information.
- Public endpoints use bounded pagination and edge rate limiting without retaining IP addresses in application data. Invalid and revoked tokens return one uniform not-found response. Publish, republish, visibility changes, and revoke require the authenticated Deck owner.
- Public titles are escaped plain text limited to 120 characters with no markup or links. Every other rendered snapshot field is escaped as untrusted content.
- Listed Published Decks are included in the application's paginated public search and in a sitemap and may be indexed by external search engines. Unlisted Published Decks are omitted from search and sitemaps and emit `noindex, nofollow` metadata.
- New Published Decks default to Unlisted. Listed visibility requires an explicit owner opt-in during publication or a later authenticated visibility change.
- Public discovery searches Listed snapshots by public title and included Card Identity name. Results expose only the public title, total card count, publication date, basic-check summary, and a small card-image preview. Results default to most recently published and use bounded cursor pagination; the MVP has no owner profile, popularity ranking, or public view count.
- Construction issues do not block publication. Incomplete or copy-limit-invalid Decks remain shareable, and their current snapshot prominently displays the exact card count and every supported basic-check issue. Publication never certifies tournament legality.
- A stable URL exposes only the current snapshot. Republish increments the version and atomically switches the pointer; prior versions have no public URL, are removed from active storage after the switch, and cannot be selected or restored through the MVP.
