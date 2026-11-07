from uuid import UUID

from app.copy_allocation import Allocation


def allocation_needs(allocation: Allocation) -> dict[UUID, int]:
    """The Want List's combined need from an existing allocation, without reading or allocating twice."""
    lines: dict[UUID, list[int]] = {}
    for (_, edition), line in allocation.lines.items():
        if line.need > 0:
            lines.setdefault(edition, []).append(line.need)
    pick = sum if allocation.counting == 'all_at_once' else max
    return {edition: pick(needs) for edition, needs in lines.items()}
