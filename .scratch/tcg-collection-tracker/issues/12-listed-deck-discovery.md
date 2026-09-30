# 12 — Listed Deck discovery

**Label:** ready-for-agent

**Blocked by:** 11 — Unlisted Deck publishing

**Status:** ready-for-agent

**What to build:** A Deck owner can opt a Published Deck into Listed discovery and anonymous visitors can find it without seeing private account or Collection information.

- [ ] Unlisted remains the default. Only the Deck owner can switch visibility; Listed-to-Unlisted changes take effect on the next request without changing snapshot version.
- [ ] Bounded public search matches the public title or included Card Identity, sorted by recent publication, and exposes only sanitized summary fields.
- [ ] Discovery uses public projections without waking PostgreSQL for each anonymous view. Private edits do not change the public result until republish.
- [ ] Browser/API/object-storage tests cover discovery entry/removal, cursor paging, noindex behavior, escaped untrusted text, and absence of owner or Location data.
