from uuid import UUID
from pydantic import BaseModel, Field
from app.location_tree import TreeNode
from app.settings import WantListCounting
from app.core.decks.store import DeckListLineBase
from app.core.decks.ownership import SurplusHoldingBase, LineOwnership, CompetitionWarning
from app.core.decks.loans import DeckLoanLine
from app.games.pokemon.decks.line_display import CardKind, TrainerType
from app.games.pokemon.formats.deck_format_checks import DeckFormatChecks, TargetFormat
from app.games.pokemon.formats.construction_checks import DISCLAIMER


class DeckIndexCover(BaseModel):
    """The card a Deck's tile is led by (#291): the collector's pick, or else the line with the most copies (ties: a
    Pokémon, then the first name). Display data only; never priced or evaluated."""
    edition_id: UUID
    name: str
    image_url: str | None     # The small artwork (read_line_display), or None.


class DeckIndexEntry(TreeNode):
    """One Deck on the Decks index (app redesign #181): its place in the Location tree plus what its row shows.

    ``deck_list_total`` is the copies on its Deck List, ``in_deck`` how many of those this Deck holds (per line, the
    lesser of the line and the Deck's Holding), and ``target_format`` its Deck List's Target Format. The result in that
    Format and the cost to complete come from the Deck's own format-checks and cost reads, which the page asks for row
    by row, so this read never evaluates a Deck or prices anything while it holds the owner lock. The cover comes from the Deck's
    cover pick and Deck List lines plus catalog display data, so the read still never evaluates or prices."""
    deck_list_total: str
    in_deck: str
    target_format: TargetFormat
    cover: DeckIndexCover | None


class DeckIndex(BaseModel):
    decks: list[DeckIndexEntry]
    owner_revision: int
    next_cursor: str | None


class IdentityCheck(BaseModel):
    identity_id: UUID
    name: str
    quantity: str
    status: str


class DeckChecks(BaseModel):
    total: str
    shortage: str
    excess: str
    size_status: str
    identities: list[IdentityCheck]
    disclaimer: str = DISCLAIMER


class DeckListLine(DeckListLineBase):
    # Display data (app redesign #176, ``deck_list_display``): catalog facts about the line's Card Edition, so a line for
    # a card the collector doesn't own renders without a second lookup.
    name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict          # The Variant Descriptor, as Collection's Holdings carry it.
    image_url: str | None     # The small artwork, or None.
    card_kind: CardKind | None
    trainer_type: TrainerType | None
    evolves_from: str | None
    identity_id: UUID         # The Card Identity.
    identity_name: str
    # A Pokémon's evolution root and its steps from it (migration 043); null for other cards and before the roots are
    # first derived.
    evolution_root: str | None
    evolution_stage: int | None


class DeckList(BaseModel):
    revision: int
    lines: list[DeckListLine]


class SetTargetFormat(BaseModel):
    # Checked by the route, so an unknown name answers UNKNOWN_FORMAT like the format-checks read.
    target_format: str
    revision: int = Field(ge=1)
    idempotency_key: UUID


class DeckListCommandResult(BaseModel):
    deck_id: UUID
    deck_list: DeckList
    # The Deck List's Target Format after the command (app redesign #178). A response stored before migration 045 replays
    # as Standard, the Target Format every Deck List had then (``replayed``).
    target_format: TargetFormat
    # The Deck's result in its Target Format as of today (UTC) after the edit: one entry in ``results``. A replay returns
    # it as computed then; a response stored before format results existed has none, so it replays as null instead of
    # failing validation.
    format_checks: DeckFormatChecks | None = None


class SurplusHolding(SurplusHoldingBase):
    # Display data, as on a Deck List line (``deck_list_display``).
    name: str
    set_id: str
    set_name: str
    collector_number: str
    descriptor: dict
    image_url: str | None
    card_kind: CardKind | None
    trainer_type: TrainerType | None
    evolves_from: str | None
    identity_id: UUID
    identity_name: str
    evolution_root: str | None
    evolution_stage: int | None


class DeckDetail(BaseModel):
    deck: TreeNode
    checks: DeckChecks
    # The same basic checks over the Deck List lines, owned or not; ``checks`` still reads the Deck's Holdings.
    deck_list_checks: DeckChecks
    deck_list: DeckList
    # Ownership states of each Deck List line, Holdings beyond the Deck List, and copies counted elsewhere by more
    # than one Deck. Computed from current Holdings on every read and never stored.
    ownership: list[LineOwnership]
    surplus: list[SurplusHolding]
    competition: list[CompetitionWarning]
    owner_revision: int
    catalog_revision: int
    # The Deck List's Target Format and its result as of today (app redesign #178): one entry in ``format_checks.results``.
    target_format: TargetFormat
    format_checks: DeckFormatChecks
    # Decklist import #208: the copies the Deck List still needs from outside the Collection under the account's Want
    # List counting setting (``copy_allocation``), which Buy missing sends and the cost to complete prices; the setting
    # and the settings revision it was read at. ``ownership`` stays the split Gather uses; its ``not_owned`` is the One
    # Deck at a time reading.
    to_get: str
    want_list_counting: WantListCounting
    settings_revision: int
    # Social network #252 and #253: the Deck's copies that Loans take, for its lines' "reserved for Kim" and "lent to
    # Sam" (``read_deck_loans``).
    loans: list[DeckLoanLine]
    # #291: the collector's picked cover card (always a line on the Deck List), or None while the cover is automatic.
    cover_edition_id: UUID | None
