"""Catalog run vocabulary and the existing lifecycle, without runtime enforcement.

The normal path is queued -> enumerating -> fetching -> validating -> promoting
-> complete. Fetch batches renew fetching; any unfinished phase can fail through
the importer, dispatch recovery or refresh child-exit handling. Terminal writes
pair complete with succeeded and failed with failed. The database checks the two
vocabularies separately; it does not enforce these transitions or their pairing.

The runner's session advisory lock (914703) protects its progress commits and
promotion transaction. Callers retain their outcome guards, locks and clocks.
"""

PHASE_QUEUED = "queued"
PHASE_ENUMERATING = "enumerating"
PHASE_FETCHING = "fetching"
PHASE_VALIDATING = "validating"
PHASE_PROMOTING = "promoting"
PHASE_COMPLETE = "complete"
PHASE_FAILED = "failed"
PHASES = (PHASE_QUEUED, PHASE_ENUMERATING, PHASE_FETCHING, PHASE_VALIDATING,
          PHASE_PROMOTING, PHASE_COMPLETE, PHASE_FAILED)

OUTCOME_SUCCEEDED = "succeeded"
OUTCOME_FAILED = "failed"
OUTCOMES = (OUTCOME_SUCCEEDED, OUTCOME_FAILED)

# Documentation of the normal lifecycle, not a guard on the existing writers.
TRANSITIONS = {
    PHASE_QUEUED: (PHASE_ENUMERATING, PHASE_FAILED),
    PHASE_ENUMERATING: (PHASE_FETCHING, PHASE_FAILED),
    PHASE_FETCHING: (PHASE_FETCHING, PHASE_VALIDATING, PHASE_FAILED),
    PHASE_VALIDATING: (PHASE_PROMOTING, PHASE_FAILED),
    PHASE_PROMOTING: (PHASE_COMPLETE, PHASE_FAILED),
    PHASE_COMPLETE: (),
    PHASE_FAILED: (),
}
TERMINAL_OUTCOMES = {PHASE_COMPLETE: OUTCOME_SUCCEEDED, PHASE_FAILED: OUTCOME_FAILED}

LEASE_INTERVAL_SQL = "interval '2 minutes'"
LEASE_END_SQL = f"coalesce(lease_until,started_at+{LEASE_INTERVAL_SQL})"
QUALIFIED_LEASE_END_SQL = f"coalesce(r.lease_until, r.started_at + {LEASE_INTERVAL_SQL})"
# Deliberately no comparison here: dispatch uses >, refresh <, owner status <=.
