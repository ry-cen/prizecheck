# Resolution — Public Deck snapshot, discovery, and privacy contract

**Deployment amendment:** [ADR 0002](../../../../adr/0002-defer-deployment-provider-selection.md) defers object-storage vendor selection. Public projections and the approved privacy, revocation, and discovery behavior remain required.

## Public projection

A Published Deck is a sanitized snapshot, never a live view of a private Deck or Location. Its response contains only:

- Owner-chosen public title
- Publication timestamp and monotonically increasing snapshot version
- Total card count
- Cards grouped by Card Identity and quantity
- Expandable Card Edition details: set, collector number, variant, and image
- Supported basic construction results and the scope notice

The response excludes every user identifier, email address, private Deck name or identifier, Location identifier/name/path, Collection total, non-Deck Holding, and operational field.

Public titles are escaped plain text limited to 120 characters with no markup or links. All other displayed snapshot fields are escaped as untrusted content.

## Validation wording

Construction issues do not block publication. Incomplete and copy-limit-invalid Decks remain shareable and prominently display their exact count and supported issues.

Private and public views state:

> Basic deck checks only. Standard format eligibility, rotation, banned cards, and special card rules are not evaluated.

The MVP never labels a Deck tournament-legal. Full Standard legality remains post-MVP.

## Token and version lifecycle

- First publish creates a cryptographically random token with at least 192 bits of entropy and snapshot version 1.
- Private Deck edits do not alter the Published Deck.
- Republish creates a new immutable snapshot, increments the version, and atomically switches the stable active URL to it.
- Only the current snapshot is publicly accessible. Superseded versions have no public URL and are removed from active storage after a successful switch; public history and rollback are out of scope.
- Revocation permanently burns the token. Unknown and revoked tokens return the same not-found response.
- Publishing again after revocation creates a new token; a revoked URL can never be revived.
- Revocation prevents future application access but cannot recall screenshots, downloads, or copies already made by recipients.

## Visibility and discovery

- Every Published Deck is **Listed** or **Unlisted**, defaulting to Unlisted.
- Listed Decks appear in the application's public search, are included in a sitemap, and may be indexed by external search engines.
- Unlisted Decks are excluded from app search and sitemaps, emit `noindex, nofollow`, and are reachable only through their unguessable URL. They are not private: anyone with the URL may view them.
- Visibility changes require the authenticated Deck owner. They update discovery atomically without altering snapshot content or version.
- Listed search matches public title and included Card Identity name. Results expose only title, total count, publication date, basic-check summary, and a small image preview. Results default to most recently published and use bounded cursor pagination. There are no owner profiles, popularity rankings, or public view counts in the MVP.

## Cache, authorization, and abuse controls

- Snapshot JSON is served through the application from its sanitized object projection with browser and shared-cache storage disabled. Static application assets and card images may be cached.
- A successful republish, visibility change, or revoke affects the next snapshot/discovery request without a cache-expiry window.
- Publish, republish, visibility changes, and revoke require the authenticated Deck owner.
- Public endpoints use bounded pagination and edge rate limiting without retaining IP addresses in application data.
- There is no token enumeration endpoint. Invalid and revoked tokens use one uniform not-found response.
