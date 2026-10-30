"""Pokémon publication snapshots and discovery responses."""
from datetime import datetime

from pydantic import Field

from app.core.publications.publish import PublicModel
from app.games.pokemon.decks.line_display import CardKind, TrainerType
from app.games.pokemon.formats.construction_checks import DISCLAIMER
from app.games.pokemon.formats.deck_format_checks import TargetFormat
from app.games.pokemon.formats import format_evaluator as evaluator

class PublicEdition(PublicModel):
    set_id: str
    set_name: str
    collector_number: str
    variant: dict
    image_url: str | None
    quantity: str
    edition_ref: str | None = Field(default=None, pattern=r'^[0-9a-f]{48}$')
    printing_ref: str | None = Field(default=None, pattern=r'^[0-9a-f]{48}$')
    # The row's own Card Printing name, subtitle included ("Professor's Research (Professor Juniper)"). Snapshots
    # published before Deck Lists 09 have none; readers then use the Card Identity name of the row's group.
    printing_name: str | None = None
    # What the Published Deck page groups a row by, as the deck builder groups Deck List lines (app redesign #183):
    # the effective card kind, Trainer Type and evolves from (catalog_card_attribute) and a Pokémon's stored evolution
    # root and stage (migration 043), frozen with the snapshot. They are catalog facts about the row's Card Printing,
    # never ownership. Snapshots published before #183 have none, and every one is null where the catalog has no value.
    card_kind: CardKind | None = None
    trainer_type: TrainerType | None = None
    evolves_from: str | None = None
    evolution_root: str | None = None
    evolution_stage: int | None = None
    # The large picture's direct address, added when the page is read (never stored with the snapshot): the Published
    # Deck page is anonymous, so its card popup cannot use the signed-in art route (ADR 0020).
    large_image_url: str | None = None


class PublicIdentity(PublicModel):
    name: str
    quantity: str
    editions: list[PublicEdition]


class PublicIdentityCheck(PublicModel):
    name: str
    quantity: str
    status: str


class PublicChecks(PublicModel):
    size_status: str
    shortage: str
    excess: str
    identities: list[PublicIdentityCheck]
    disclaimer: str = DISCLAIMER


class PublicSnapshot(PublicModel):
    title: str
    published_at: datetime
    version: int
    # The Deck List's Target Format, frozen with the snapshot (app redesign #178, ADR 0011). A snapshot published before
    # it has none and reads as Standard, the Target Format every Deck had then; its stored object is never rewritten.
    target_format: TargetFormat = 'standard'
    total: str
    identities: list[PublicIdentity]
    checks: PublicChecks


class PublicCheckSummary(PublicModel):
    size_status: str
    shortage: str
    excess: str
    over_limit_groups: int
    unresolved_groups: int


class DiscoverCost(PublicModel):
    """The deck's cost from cached quotes only (base-10 strings, like the Published Deck cost)."""
    amount: str | None          # exact decimal subtotal of the priced copies; None when no copy is priced
    priced_copies: str          # copies with a cached quote, stale ones included
    total_copies: str           # every copy in the snapshot


class PublicDeckSummary(PublicModel):
    url: str
    title: str
    total: str
    published_at: datetime
    checks: PublicCheckSummary
    image_url: str | None       # the featured card's art (``featured``)
    featured_name: str | None   # the featured card's name, for its alt text
    target_format: TargetFormat
    target_format_status: evaluator.Status  # always 'legal': only legal decks are listed
    cost: DiscoverCost


class DiscoveryPage(PublicModel):
    decks: list[PublicDeckSummary]
    revision: int
    next_cursor: str | None
