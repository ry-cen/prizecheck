"""Pure construction checks shared by private Decks and sanitized snapshots.

Inputs and outputs contain quantities/classification only; no private identifiers
can enter public serialization through this evaluator.
"""
from dataclasses import dataclass

DISCLAIMER = 'Basic deck checks only. Standard format eligibility, rotation, banned cards, and special card rules are not evaluated.'


@dataclass(frozen=True)
class IdentityCount:
    quantity: int
    basic_energy_exempt: bool
    basic_energy_unresolved: bool


@dataclass(frozen=True)
class ConstructionChecks:
    total: int
    shortage: int
    excess: int
    size_status: str
    identity_statuses: list[str]


def evaluate_checks(identities: list[IdentityCount]) -> ConstructionChecks:
    total = sum(identity.quantity for identity in identities)
    statuses = ['basic_energy_exempt' if identity.basic_energy_exempt else
                'unresolved' if identity.basic_energy_unresolved else
                'over_limit' if identity.quantity > 4 else 'within_limit' for identity in identities]
    return ConstructionChecks(total=total,shortage=max(0,60-total),excess=max(0,total-60),
        size_status='complete' if total == 60 else 'shortage' if total < 60 else 'excess',identity_statuses=statuses)
