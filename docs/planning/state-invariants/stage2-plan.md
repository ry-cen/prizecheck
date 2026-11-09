# State invariant consolidation after Stage 1

Ryan authorized behavior-preserving Stage 2 on 2026-11-09 after correcting the proposal against [Stage 1, PR #601](https://github.com/ry-cen/prizecheck/pull/601). This plan supersedes the conflicting transition and consolidation recommendations in the 2026-11-08 proposal. It records current behavior and bounded follow-ups; it is not an accepted architecture decision or permission to introduce enforcement.

Stage 3 runtime rejection, post-write assertions and database constraints remain deferred until the design is corrected and the relevant data audit supports it. No merge, deployment, real-source ingestion, credential or security change is authorized by this continuation. The existing merge queue has a separate owner.

## Corrected behavior

| Proposal claim | Current behavior established by Stage 1 | Consequence for Stage 2 |
| --- | --- | --- |
| L2 globally equates `handed_over` with both handover timestamps being set. | For open Loans produced by the characterized lifecycle commands with existing participants, `handed_over` corresponds to both confirmations. This is a lifecycle convention, not a constraint on arbitrary database rows. Settled `closed(returned)` and `closed(written_off)` Loans retain their handover timestamps. A write-off before borrower receipt can close with only the lender timestamp set. | Keep state, confirmation and settlement predicates distinct. Do not infer `handed_over` from timestamps on closed rows, clear timestamps, or add the proposed global equivalence as an assertion or CHECK. |
| The transition table assigns a lender inventory revision increment to every lend-offer acceptance. | Accepting the full offer releases nothing and advances neither participant's inventory revision. Partial acceptance releases copies and advances the lender once; the borrower does not advance. | Preserve the conditional increment. Consolidation must not add a revision write for full acceptance or duplicate one for partial acceptance. |
| S1-D suggests parity between Trade reservation predicates in migration 142 and the Python unconfirmed predicate. | Proposer reservations apply in `proposed` or `accepted` while that side has not swapped. Recipient reservations apply in `accepted` while that side has not swapped. The unconfirmed predicate requires both swap timestamps to be NULL. A half-confirmed Trade can still reserve the other side's copies while it cannot be cancelled. | Give per-side reservations and both-sides-unconfirmed conditions separate names and contracts. Never replace one with the other or combine them into a single generic predicate. |

Evidence is in `api/tests/test_loan_states.py`, `api/tests/test_round_invariants.py`, `api/tests/test_allocation_invariants.py` and `tests/tooling/test_round_predicates.py` in #601. At reviewed head `539f9712da2bf875dde50295b0c63fbcb2939375`, local results were 197 API tests, 10 focused tooling tests and 571 guardrail tests passed, with `npm run check` and normal commit hooks passed. Independent Codex reviews approved the Loan and lifecycle slices; Opus reviewed allocation and predicates and approved the targeted follow-up. Ordinary PR `verify` passed. Full API/browser suites and hosted sharded integration were not run.

The allocation arithmetic identity already existed in the `figures` helper; Stage 1 extends generated input combinations. Its bounded generator does not claim exhaustive branch coverage. The static lock tests pin scoped lock modes and sorted, deduplicated owner locks; they do not prove global transaction lock ordering.

## Ownership and prerequisites

The continuation belongs to the existing state-invariants implementation thread. It does not take over #528's moves, #573's cleanup, #475's UI work or the merge queue.

At the initial continuation check, refreshed `origin/dev` was `d5225bbf95933cbda33a965e4de898634eba92a7`; #601, [#576](https://github.com/ry-cen/prizecheck/pull/576) and [#589](https://github.com/ry-cen/prizecheck/pull/589) were still open. The old implementation branch was clean and is preserved. The plan branch starts at that refreshed dev commit.

- **#528 core owner:** confirm the current landing order and file ownership for #576 caller scans, #589 allocation moves, #597 `edition_needs`, and the Location path work. The prior social-consolidation hold behind #576/#589 remains effective until their landing is verified or the owner explicitly agrees a different sequence. Do not cherry-pick or merge those branches to bypass the hold.
- **#573 owner:** confirm that Loan/Trade predicate and section consolidation remain available to this thread, and identify any new overlapping work. Its catalog, cursor, overflow, resolved-review and UTC work remains outside this continuation.
- **Stage 1:** preserve #601's exact tests and expected behavior. Its merge is handled separately. If not yet on dev when implementation starts, carry its reviewed commit explicitly only with the agreed dependency sequence; do not duplicate the four files independently.
- **Checkouts:** implementation and independent review each get their own host-prepared worktree from the then-current authorized integration base, with required commits explicitly identified and ancestry verified. Never edit another owner's checkout.

The ownership check subsequently cleared the first slice. The core owner confirmed #589 and the Location/Edition-needs moves landed, and approved proceeding before #576 under the conditions below. #573 confirmed no overlap and left ownership here. Stage 1 then landed through the separate merge queue as `c42d6fb142811ede4db9e393b68d6b6543585571`; this plan branch was rebased to that tip without modifying the four characterization files.

For this slice only, #528 permits the single `social-allowed-imports` tuple `('app.social.loans', 'UNCONFIRMED_HANDOVER')` in `scripts/python_architecture_rules.py`. Put the constant in existing `social.loans`; add no social module. Do not edit the boundary checker, its architecture tests or `test_social_contract.py`. The condition must match none of the six guarded SQL families; otherwise stop and coordinate. #576 remains open at reviewed head `35acc36d`; whichever slice lands second must preserve the agreed pin, with the merge queue still handled elsewhere. Receipts and `location_tree.py` remain unscheduled and owned by #528.

## Bounded Stage 2 sequence

### First candidate Loan unconfirmed query reuse

After the ownership and dependency gates above, inspect the current moved files and give the repeated Loan both-confirmations-unset SQL condition one owner. The initial candidate is the condition in `social.loans.end_loans_between` and the Loan arm of `social.reports.unconfirmed_partners`: `state IN ('requested','offered','accepted') AND lender_handover_at IS NULL AND borrower_handover_at IS NULL`. Keep each query's participant restrictions, parameters, ordering, lock mode and projection unchanged. Inventory code must continue calling the established counts boundary rather than importing Loan or Trade step logic.

The implementation brief must confirm these exact owned files and call sites on the refreshed checkout before dispatch. Prefer the existing Loan module over introducing a new shared state module. Do not move files as part of this slice. Keep Python row predicates separate from SQL fragments unless equivalence is demonstrated without widening behavior.

This first slice excludes Trade predicates, display sections, receipts and all revision-write changes. Loan reservation SQL already has an owner in `counts.RESERVING`; the other inspected reservation condition is a Python row check, so sharing the SQL string with it would be inappropriate. If the two Loan query sites no longer duplicate an equivalent condition after #528's moves, report that result rather than manufacture an abstraction.

### Separate Loan and Trade unconfirmed predicates

Inspect cancellations, suspension/report reads and bulk closure queries separately. Reuse a definition only among sites with identical state, timestamp, participant-existence and parameter semantics. Preserve each site's query clauses and error behavior. Loan reservation, Loan lending, Loan cancellation, Trade per-side reservation and Trade both-sides-unconfirmed remain separate concepts.

### Thread section derivation

Inspect `loans.section`, `trades.section`, `threads.py` and inbox readers, including the waiting/unread characterization added by #594. Delegation to a shared derivation is suitable only where the reader has equivalent facts and the current output is unchanged. Preserve the distinction between a waiting action and unread activity. Do not force every reader to have the same section merely because the earlier proposal called them equivalent. Coordinate #475's remaining UI work without taking ownership of it.

### Both swapped readers remain held for audit

The earlier S2-C substitution of timestamp checks with `closed_reason = 'swapped'` depends on a corrected equivalence and clean relevant data audit. Stage 1 fixture coverage is not a production audit. Leave those expressions unchanged until that condition is satisfied; naming an existing expression without changing its meaning may be proposed as a separate bounded slice.

### Receipt helper follows the Location ownership check

Re-evaluate S2-D only after the core owner identifies the current Location writer/helper owner and its settled import boundary. Preserve receipt bytes, digests, replay, timing, retention and every error path. A shared receipt writer does not authorize receipt pruning or a new retention policy. Ryan's numbered decision 6 authorizes this Stage 2 continuation; it is not a new decision about the old proposal's separately numbered D6 retention question.

## Verification and review

For each code slice, first record a baseline on its exact base and preserve existing expectations. Run the affected Stage 1 cases and existing endpoint/SQL tests, plus repository-required `npm run check`, guardrails and normal hooks. Use admitted local verification with private worktree dependencies. No full or hosted sharded run is authorized here; ordinary required PR CI remains permitted. Report unrun or failed checks explicitly.

Any necessary adaptation of a source-ownership test after an agreed move must preserve its semantic assertion and planted-violation checks; do not remove a guard to make a consolidation pass. SQL snapshot or normalization comparisons must retain meaningful literals, NULL checks and operators.

Use one bounded implementer and a distinct independent reviewer, following Ryan's temporary Sonnet implementation and Opus review preference for newly needed delegations. Verify the returned provider/model. Accept only the reviewed version and re-review substantive fixes. Push isolated task branches and open draft PRs; do not merge or deploy.

## Current status

The three Stage 1 proposal mismatches are reconciled above, and both owners cleared the first slice. [Issue #606](https://github.com/ry-cen/prizecheck/issues/606) implements Loan unconfirmed query reuse in `social/loans.py` and `social/reports.py`, the single approved import pin and focused tests, based on `c42d6fb1` with the landed core moves. The clean baseline passed 206 tests; the post-edit selection passed 211. After independent review identified missing positive lender-role cases, the repaired focused file passed all seven cases, running every matrix row in both roles. Production SQL was unchanged by that repair. Check and 579 guardrail tests passed, and targeted independent Opus re-review approved the final code/test artifact. The baseline and broad selection were retained rather than repeated for the session reset or test-only repair.

The earlier general hold is lifted only for this bounded slice under the listed conditions. Later Stage 2 slices still need their own ownership and behavior-equivalence checks. Stage 3, receipt work and the audit-dependent S2-C substitution remain held. Publication and integration are distinct: this implementation lane may publish the reviewed draft but does not merge or deploy it.
