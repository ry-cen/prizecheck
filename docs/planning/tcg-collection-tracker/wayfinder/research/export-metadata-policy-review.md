# Export metadata policy review

Reviewed: 2026-10-08. Architect review of [Decide export metadata provenance and correction](https://github.com/ry-cen/prizecheck/issues/43). Planning policy only; no implementation, destination or database test.

## Completed architect report

No findings or policy-closure blockers.

Reviewed ticket 24, its resolution, dependent ticket 20, accepted resolutions 19/22/23, and the provenance research.

The resolution preserves the agreed boundaries:

- **Correctness:** Live identifiers are derived from validated Printing metadata and rules; unsupported cases block the complete export. Product identity and quote-finish matching are distinct checks ([resolution:9](../resolutions/24-decide-export-metadata-contract.md#live-derivation), [resolution:17](../resolutions/24-decide-export-metadata-contract.md#marketplace-verification)).
- **Security and ownership:** Reports cannot approve data, create personal export IDs, or grant manual price refresh. Maintainers approve shared corrections ([resolution:23](../resolutions/24-decide-export-metadata-contract.md#correction-responsibility-and-provenance)).
- **Invalidation and independence:** Changed/conflicting product mappings lose cached-quote and product-link eligibility; valid Live derivation remains independent. Reviewed corrections retain provenance and precedence ([resolution:19](../resolutions/24-decide-export-metadata-contract.md#marketplace-verification), [resolution:25](../resolutions/24-decide-export-metadata-contract.md#correction-responsibility-and-provenance)).
- **Public compatibility:** Corrections apply only to the same frozen published cards. Public association, propagation/version correctness, and zero anonymous PostgreSQL wakeups remain explicitly assigned to ticket 20 ([resolution:31](../resolutions/24-decide-export-metadata-contract.md#published-decks)).
- **Performance and concurrency:** Nothing introduces additional refresh authority or supersedes ticket 22's access eligibility, coalescing, backoff, or three-second budget. Concrete propagation and race handling remain deferred, rather than implicitly accepted.

Verification gaps remain accurately disclosed: actual Live imports, complete special-case rule coverage, exact physical-product/finish matching, public invalidation/version tests, workload/race validation, and the required actual-datastore preflight. Fresh formatter retrieval also failed; the document correctly relies on prior inspection without claiming fresh verification ([resolution:39](../resolutions/24-decide-export-metadata-contract.md#active-completion-criteria-and-remaining-evidence), [resolution:45](../resolutions/24-decide-export-metadata-contract.md#evidence)).

These are implementation and evidence obligations, not blockers to closing this planning decision. No files changed by the reviewer.

## Recording and validation

The primary saved the completed report and integrated closure. Laya selected architect for task `df8bc387b0a647b2b2b99fb10049fe4d`; the owner explicitly requested the retry after the original agent failed to execute under a usage limit. Retry attempt `9a92a1d23367495e9d6e8360d27bbda9` completed. The review approves consistency of the accepted planning policy, not the deferred public architecture or application implementation.
