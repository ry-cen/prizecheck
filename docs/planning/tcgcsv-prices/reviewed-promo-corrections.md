# Reviewed Eevee and Charmander SVP price corrections

Preparation only. Merging or deploying these commands applies no corrections. Live dev and production operations each need separate owner authorization, an authorized operator, and read-only preflight against that environment. This plan does not authorize SSH retries, sign-in, new credentials, deployment, or data writes.

## Reviewed identities and evidence limits

| Printing | Exact Edition descriptor (ignoring thirdParty) | Correct product | Exact imported name | Number |
| --- | --- | --- | --- | --- |
| `tcgdex` / `svp-173` | `{"type":"holo","size":"standard"}` | 610758 | Eevee - 173 | 173 |
| `tcgdex` / `svp-173` | `{"type":"holo","size":"standard","stamp":["pokemon-center"]}` | 610757 | Eevee - 173 (Pokemon Center Exclusive) | 173 |
| `tcgdex` / `svp-044` | `{"type":"holo","size":"standard"}` | 512035 | Charmander - 044 | 044 |
| `tcgdex` / `svp-044` | `{"type":"holo","size":"standard","stamp":["pokemon-center"]}` | 512036 | Charmander - 044 (Pokemon Center Exclusive) | 044 |

All four products belong to TCGCSV group **22872**. The [products response](https://tcgcsv.com/tcgplayer/3/22872/products) fetched **2026-11-04 01:59:48 UTC** contained 280 products. Its cached comparison confirms Eevee's two source IDs are reversed; regular Charmander's source ID **477182** identifies **Fuecoco - 002**, not Charmander. Charmander's PC ID already aligns. The 226-card TCGdex audit ran 01:59–02:02 UTC Nov 4; the bounded comparison covered 19 regular/PC pairs, with 35 aligned and 3 incorrect IDs among 38. This does not establish live impact or justify changing the other 17 pairs.

The research report is `/home/t3/.t3/worktrees/prizecheck/research-eevee-svp173-20261104/.scratch/eevee-research/report.md`. The full response is its sibling `upstream/products-20261104T015948.json`, SHA-256 **`a5c5a62d3a001a15a9a8de6567fcfca97fd9f69e143b93b5a32a516bd7d19d58`**. Preserve both with the operator receipt. Committed product subsets are [Eevee](../../../api/tests/fixtures/svp173/products.json) (Oct 31 evidence) and [Charmander](../../../api/tests/fixtures/svp044/products.json) (Nov 4 evidence). No restricted source needs refetching to review this patch. A later operator must compare imported product evidence with the reviewed identities and stop if it differs. `modifiedOn` is product metadata time, not a quote timestamp.

The commands pin the marketplace-relevant source projection to **variant correspondence, no quote-product IDs or card fallback, and the variant's exact TCGplayer ID**. The reviewed original regular/PC IDs are Eevee **610757/610758** and Charmander **477182/512036**. Each variant may instead already name its correct product from the table above. Variant IDs and Cardmarket identifiers/amounts under `pricing.cardmarket` are ignored enrichment only while the stored descriptor, exact correspondence and reviewed matching inputs remain unchanged. A different marketplace product, new quote-product input, fallback, removed variant or unresolved correspondence stops the command for renewed review. A newly loaded digest is not new review authority. These checks apply to both dry run and apply, including a material change between invocations. Existing quarantines still require owner review even if an upstream change now looks correct.

Legacy Edition descriptors retain `thirdParty` for compatibility. Changing `thirdParty.cardmarket` can therefore break the exact source-variant correspondence even when it does not describe a physical card change. The scripts stop for that unresolved evidence; they do not clean or remap descriptors to bypass it. That requires separate correspondence review under [ADR 0007](../../adr/0007-edition-marketplace-metadata-boundary.md). The harmless-enrichment allowance does not authorize changes to those retained descriptor fields.

**No current USD prices or live mappings were verified.** Oct 31's Eevee $8.90/$72.13 are historical evidence only. EUR Cardmarket amounts cannot validate USD quotes. The research found dev SSH authentication denied and the catalog API returning 401. Do not bypass either denial or interpret it as evidence that a prior correction never ran. #481 merged as `09df264ee277b77239b4005ac8e1ffab886e1713` and was included in recorded Nov 2/3 dev deployments; it supplied code and a runbook, with no automatic application. Production's recorded Oct 30 release excluded #481; manual corrections there remain unknown.

## Read-only preflight in each environment

1. Confirm the environment, running release and available script version independently. Save a receipt containing environment, release SHA, operator, UTC time, command version/hash, approved scope and source-evidence dates/hash, plus the environment's current backup/recovery reference from [release operations](../../operations/release.md). Branch tip, a healthy API and deployment success do not prove current data state.
2. Use an existing authorized read-only database session. Save the following results before any write. Check exactly one regular and one PC Edition per Printing; retain UUIDs, descriptors and public references. Validate the catalog name, set and number as well as the imported product name, group and number. The commands accept normalized collector numbers (e.g. `44` and `044`) but require exact names and physical descriptors. They stop for a missing/duplicate descriptor, different physical facet, missing product, changed identity or duplicate-product conflict.

```sql
BEGIN READ ONLY;
SELECT p.source,p.source_id,p.id AS printing_id,e.id AS edition_id,e.public_ref,e.descriptor,
       d.display_name,d.set_id,d.collector_number,
       m.mapping_state,m.mapping_reason,m.mapping_basis,m.product_id,m.quote_variant,
       m.mapping_revision,m.public_revision,m.mapping_decision_id,m.mapping_candidate,
       m.accepted_fingerprint,m.accepted_projection,pm.source_record
FROM catalog_printing p JOIN catalog_edition e ON e.printing_id=p.id
JOIN catalog_edition_metadata m ON m.edition_id=e.id
JOIN catalog_printing_metadata pm ON pm.printing_id=p.id
LEFT JOIN catalog_printing_display d ON d.printing_id=p.id
WHERE p.source='tcgdex' AND p.source_id IN ('svp-173','svp-044')
ORDER BY p.source_id,e.id;

SELECT product_id,group_id,name,number,seen_at,source_updated_at
FROM tcgplayer_product WHERE product_id IN (610757,610758,477182,512035,512036)
ORDER BY product_id;

SELECT d.* FROM catalog_metadata_decision d
JOIN catalog_printing p ON p.id=d.printing_id
WHERE p.source='tcgdex' AND p.source_id IN ('svp-173','svp-044')
ORDER BY d.clock_revision;

-- Recovery jobs can resume pending release-rule rollouts. Review these and the
-- intended release's registered rule versions before authorizing that wider job.
SELECT a.id,a.kind,a.version,a.source,a.release_commit,r.phase,r.failed_phase,
       r.cursor,r.done,r.total,r.changed,r.error
FROM catalog_rule_state s JOIN catalog_rule_activation a ON a.id=s.activation_id
LEFT JOIN catalog_rule_rollout r ON r.activation_id=a.id
ORDER BY a.kind;

-- Check other holders too: Charmander's wrong source product may already belong to Fuecoco.
SELECT p.source_id,e.id,e.descriptor,m.mapping_state,m.product_id,m.quote_variant
FROM catalog_edition_metadata m JOIN catalog_edition e ON e.id=m.edition_id
JOIN catalog_printing p ON p.id=e.printing_id
WHERE m.product_id IN (610757,610758,477182,512035,512036)
ORDER BY m.product_id,e.id;
COMMIT;
```

3. Inspect bindings, quotes and publication separately with the queries below. A saved audit decision proves a decision committed; the current metadata proves its effective state. Neither proves that price publication succeeded. A regular Charmander mapping may be unverified because the source product belongs to Fuecoco; do not clear Fuecoco or weaken duplicate guards to fix it. If the *correct* target product is held by another Printing, stop for owner review.
4. Run both default commands as read-only preflight after access and release authorization. Save their Edition IDs, revisions, evidence digests and proposed actions. If values already match the accepted source/state policy, the script skips them without adding audit decisions; inspect historical decisions to establish who corrected them. A later owner unmap/rejection, different correction or quarantine stops the whole preflight before any new decision. The only repairable unverified source states are open `no_matching_rule`, `rule_failed` and `duplicate_mapping`, without a prior owner decision, rejection or retained product/quote key. A verified original source mapping must still agree with the pinned source product. Preflight does not run imports, rematches, migrations, rebinds or publication. If imported evidence is missing/stale, arrange an explicitly authorized import separately, then repeat preflight; do not silently add `--force` or fetch restricted sources.

## Authorized dev application, then separately authorized production

The following are **operator instructions, not commands executed by this preparation task**. Use an existing owner user ID. Select exactly one environment for a receipt; do not run a dev result against production.

Dev entry point:

```sh
P=/mnt/cache/appdata/prizecheck-dev/bin/prizecheck-deploy.sh
sudo bash "$P" tool /app/scripts/correct_eevee_svp173.py --owner OWNER_USER_ID
sudo bash "$P" tool /app/scripts/correct_charmander_svp044.py --owner OWNER_USER_ID
```

After reviewing that environment's output and receiving write authorization:

```sh
sudo bash "$P" tool /app/scripts/correct_eevee_svp173.py --owner OWNER_USER_ID --apply
sudo bash "$P" tool /app/scripts/correct_charmander_svp044.py --owner OWNER_USER_ID --apply
```

For production, first complete its own release/access/preflight approval, then use **`P=/opt/prizecheck-prod/bin/prizecheck-deploy.sh`** with the same commands. Do not assume production has these scripts merely because dev deployed them. No production correction is authorized by this document.

`--apply` holds session advisory lock **914714** from before preflight through the final price publication. A concurrent promo command fails before saving decisions; after the first exits, inspect state before retrying. Apply also takes the daily price importer's existing session lock **914712**, without waiting: an active import stops apply, and an importer starting during apply exits as locked. This excludes normal product imports from the identity validation/decision window across processes/hosts on the same database. No network import is triggered. Do not manually edit product rows during maintenance; direct SQL writes do not participate in that importer lock.

The lock connection never takes the catalog correction clock; each owner decision retains its own transaction and locked revision/digest check. Ordinary owner decisions and catalog imports do not take the script lock. Their concurrent metadata changes can produce 409, which is not automatically retried. Run in a quiet catalog maintenance window and inspect any conflict. Changed product identity before a later retry is validated again, even when the mappings were already corrected.

Each correction commits separately through `metadata_reviews.decide`, with null quote variant, owner attribution, evidence URL, reason, source rejection and a new mapping revision. A verified mapping that already names the correct product is left untouched, including its source quote key; regular Charmander normally needs one decision, Eevee two. Descriptors, Edition UUIDs, public references, source records and matching rules stay intact.

The command prints each saved decision ID and catalog delivery status, waits for its spawned rebind work, then explicitly rebinds and publishes prices. **Those binding and price-publication passes cover the entire catalog**, even though only these reviewed mapping decisions are made. They fetch nothing and change no matching rules or art selections. Each decision commits separately, so the intermediate Eevee state can temporarily share one product and withhold prices; the pair is not atomic. A final rebind or price-publication exception fails the command even though decisions may already be committed. Catalog delivery remains best effort and must be checked independently. Empty/withheld prices are valid when no appropriate positive Holofoil quote exists; correction success never promises an amount.

## Verification and recovery receipt

Re-run the read-only metadata/history queries and compare saved Edition identities, audit IDs and revisions. Then inspect these joins:

```sql
BEGIN READ ONLY;
SELECT p.source_id,e.id,e.public_ref,e.descriptor,m.mapping_state,m.product_id,m.mapping_revision,
       b.product_id AS bound_product,b.mapping_revision AS bound_revision,b.sub_type_name,b.reason,
       q.market_price,q.source_updated_at,q.seen_at
FROM catalog_printing p JOIN catalog_edition e ON e.printing_id=p.id
JOIN catalog_edition_metadata m ON m.edition_id=e.id
LEFT JOIN edition_price_binding b ON b.edition_id=e.id
LEFT JOIN tcgplayer_price q ON q.product_id=b.product_id AND q.sub_type_name=b.sub_type_name
WHERE p.source='tcgdex' AND p.source_id IN ('svp-173','svp-044')
ORDER BY p.source_id,e.id;

SELECT o.* FROM catalog_public_outbox o
WHERE o.delivered_at IS NULL AND o.target_id IN (
  SELECT p.id FROM catalog_printing p WHERE p.source='tcgdex' AND p.source_id IN ('svp-173','svp-044')
  UNION SELECT e.id FROM catalog_edition e JOIN catalog_printing p ON p.id=e.printing_id
        WHERE p.source='tcgdex' AND p.source_id IN ('svp-173','svp-044'));
COMMIT;
```

- **Saved decisions:** expected product/state, fresh audit IDs only for changed mappings, unchanged UUIDs/descriptors, and owner evidence/rejection history. On interruption, query first; sequential reruns finish missing decisions without duplicating effective corrections. A later changed source may quarantine a mapping and require a new reviewed decision. This is conditional idempotence, not a permanent exemption from source review.
- **Bound data:** both product and mapping revision must equal current metadata. The reviewed expected subtype is `Holofoil`; a null subtype/reason means no quote should display. Do not borrow Fuecoco's price or guess a missing subtype. Verify imported quote timestamps independently; `--rebind-only` cannot make an old quote fresh, and failed imports retain earlier rows.
- **Published success:** through existing authorized public-record tooling read `price:<public_ref>` and its catalog Edition record. For an available quote require the current product/revision and the exact positive stored amount; otherwise require no stale price record. Confirm no pending catalog outbox row for these targets. Then read the collector price endpoint and an existing Published Deck containing the Edition where available. Record amount/status, identities and verification time in the operator receipt; keep provenance details out of collector UI.

If the command failed after decisions, do not infer rollback. Inspect all three layers first. Once authorized, an ordinary no-op `--apply` retry attempts rebind/price publication again. The existing recovery command is:

```sh
sudo bash "$P" tool /app/scripts/price_import_job.py --rebind-only
```

This recovery command downloads no prices, but its wrapper **resumes release catalog rules before rebinding**. It then rebinds the entire catalog, runs both `refresh_fallbacks` and `refresh_art_products`, attempts catalog delivery, and publishes all public price records. Before authorizing it, inspect the rule-state/rollout query above and the running release's newest registered rule versions. Record the intended activation/version/release, pending or failed rollout phases, and the approved wider data/art/publication scope. If unexpected rules or incomplete rollout effects are not approved, stop; use a separately reviewed narrower recovery through the existing owner service instead. A release SHA alone does not authorize those data effects. Publication and catalog delivery remain separately verifiable, so exit 0 alone is insufficient. Pending catalog publication can be repaired by the existing `scripts/backfill_public_catalog.py` after separate authorization (see [release operations](../../operations/release.md)); recheck outbox and records. Do not rewrite decisions merely to trigger catalog delivery.

Save failures and successful retries together. Stop on changed evidence, name/number/descriptor conflicts, wrong owner, unavailable access or an unknown outcome. A denied live operation is not permission to retry with alternate access. Check uncertain outcomes before any retry; no blind automatic retries are part of these commands.

## Safe rollback

Code rollback does not undo audited data decisions. Never delete audit/rejection rows, decrement revisions or restore the known-bad product IDs. If a correction is disputed, use the existing owner review service to issue an explicit **`unmap`** decision against fresh target revision/digest, with a rollback reason and evidence; then rebind/publish and verify the quote is withheld in private and public reads. This is a new append-only decision, and these scripts refuse to reverse it on an ordinary rerun. Reapply a reviewed correct product only after resolving the evidence conflict through a fresh explicit owner review. Materially changed source inputs also require a separately reviewed update to the pinned script evidence before reuse; there is no bypass flag. A whole-database restore is not an appropriate rollback for these isolated mapping decisions.

Edition-specific images are a separate workstream. Correct price mappings and a successful rebind do not prove stamped image delivery.
