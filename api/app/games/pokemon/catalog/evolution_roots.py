"""Evolution roots: the first Pokémon of each Pokémon's evolution line (app redesign #176, owner-approved addendum).

The deck builder groups a Deck List's Pokémon by evolution line. A line's own ``evolves_from`` (migration 041) names only
the stage before it, so a deck that skips a stage (Charmander and Charizard ex with no Charmeleon, a common Rare Candy
build) would split. The root follows ``evolves_from`` through the whole catalog instead, once per Card Identity when the
catalog's card data is derived, and is stored in ``catalog_evolution_root`` (migration 043). A Deck read only joins it.

Rules (``evolution_roots``), per Card Identity key of a Pokémon:

- **Parent by majority.** Each of the identity's Pokémon Printings votes for the identity key of its ``evolves_from``, or
  for "no parent" when it has none. The most-voted choice wins. A tie between choices means no parent, so one bad
  Printing can neither split nor merge lines.
- **Merged identities.** A vote for a Card Identity merged into another by review (migration 037, at most one step)
  counts for the survivor, so a merge never splits a line.
- **Only Pokémon parents.** A parent counts only when its key is a Pokémon's identity key in the catalog. An older fossil
  whose ``evolves_from`` names a Trainer item ("Unidentified Fossil", "Helix Fossil") or a name the catalog lacks is
  therefore the root of its own line, and a Trainer never joins Pokémon.
- **Walk to the root.** From the identity, follow parents for at most ``MAX_HOPS`` steps. The root is the last identity
  reached that has no parent; its stage is the number of steps taken (0 for a root). Siblings share a root (Lucario and
  Mega Lucario ex from Riolu; every Eeveelution from Eevee), and a Basic with no ``evolves_from`` is its own root.
- **Fall back to the card itself.** A walk that revisits an identity (a cycle in bad data) or still has a parent after
  ``MAX_HOPS`` steps gives the identity itself as its root, at stage 0: never a wrong line.

The roots are catalog data derived from ``evolves_from``, which is not a card attribute: writing them never advances the
attribute revision, never re-stamps a public format fact, and never makes a saved format result or a stored Format
Standing stale. This module is outside both ``CODE_SHA256`` digests on purpose.
"""
import logging
import unicodedata
from collections import Counter
from dataclasses import dataclass
from typing import Mapping, Sequence

from .card_identity import card_identity_key

log = logging.getLogger(__name__)

# Basic, Stage 1 and Stage 2 are two steps; BREAK, LEVEL-UP and the like add one. Four allows every printed chain.
MAX_HOPS = 4


@dataclass(frozen=True)
class EvolutionRoot:
    root_name: str   # The root identity's display name.
    stage: int       # Steps from the root: 0 for the root itself.


def name_key(name: str) -> str:
    """The Card Identity key an ``evolves_from`` name points at (migration 028's key)."""
    return card_identity_key(" ".join(unicodedata.normalize("NFC", name).split()))


def evolution_roots(pokemon: Mapping[str, tuple[str, Sequence[str | None]]],
                    merged: Mapping[str, str] | None = None) -> dict[str, EvolutionRoot]:
    """The root of every Pokémon identity. ``pokemon`` maps each identity key to its display name and the
    ``evolves_from`` of each of its Pokémon Printings (None for a Printing with none); ``merged`` maps a merged-away
    identity key to its survivor's. Pure."""
    merged = merged or {}
    parent: dict[str, str | None] = {}
    for key, (_, votes) in pokemon.items():
        ranked = Counter(merged.get(name_key(vote), name_key(vote)) if vote else None for vote in votes).most_common()
        if not ranked or (len(ranked) > 1 and ranked[0][1] == ranked[1][1]):
            parent[key] = None
            continue
        choice = ranked[0][0]
        parent[key] = choice if choice in pokemon and choice != key else None
    roots: dict[str, EvolutionRoot] = {}
    for key, (name, _) in pokemon.items():
        chain = [key]
        for _ in range(MAX_HOPS):
            following = parent[chain[-1]]
            if following is None or following in chain:
                break
            chain.append(following)
        if parent[chain[-1]] is not None:
            # A cycle, or a chain longer than MAX_HOPS: the card is its own line.
            roots[key] = EvolutionRoot(name, 0)
        else:
            roots[key] = EvolutionRoot(pokemon[chain[-1]][0], len(chain) - 1)
    return roots


POKEMON = """SELECT ci.identity_key,ci.display_name,ca.evolves_from
  FROM catalog_card_attribute ca JOIN catalog_printing p ON p.id=ca.printing_id
  JOIN catalog_identity ci ON ci.id=p.identity_id
  WHERE ca.card_kind='pokemon'"""
MERGED = """SELECT m.identity_key,s.identity_key AS survivor FROM catalog_identity m
  JOIN catalog_identity s ON s.id=m.merged_into"""

WRITE = """INSERT INTO catalog_evolution_root AS r(identity_key,root_name,stage)
  SELECT * FROM unnest(%s::text[],%s::text[],%s::smallint[])
  ON CONFLICT (identity_key) DO UPDATE SET root_name=EXCLUDED.root_name,stage=EXCLUDED.stage
  WHERE (r.root_name,r.stage) IS DISTINCT FROM (EXCLUDED.root_name,EXCLUDED.stage)"""


def refresh_evolution_roots(conn, contain: bool = True) -> int:
    """Recompute every Pokémon identity's root from the effective card attributes and store the ones that changed,
    removing identities that are no longer Pokémon. Runs in the caller's transaction, after the card attributes are
    derived (a catalog import and ``scripts/derive_card_attributes.py``). Returns the number of rows written or removed.

    Roots are derived data that the next derivation rebuilds, so a failure here must not abort the caller's
    transaction (a catalog import that already stored its generation): the work runs in a savepoint, a failure rolls
    back only the roots (the stored ones stay as they were), is logged, and returns 0. With ``contain=False`` (the
    derivation script, which exists to rebuild the roots) the savepoint is still rolled back, but the error is raised."""
    try:
        with conn.transaction():
            return _refresh(conn)
    except Exception as error:
        if not contain:
            raise
        log.warning("Evolution roots refresh failed (%s)", type(error).__name__, exc_info=True)
        return 0


def _refresh(conn) -> int:
    pokemon: dict[str, tuple[str, list[str | None]]] = {}
    for row in conn.execute(POKEMON).fetchall():
        entry = pokemon.setdefault(row["identity_key"], (row["display_name"], []))
        entry[1].append(row["evolves_from"])
    merged = {row["identity_key"]: row["survivor"] for row in conn.execute(MERGED).fetchall()}
    roots = evolution_roots(pokemon, merged)
    keys = sorted(roots)
    removed = conn.execute("DELETE FROM catalog_evolution_root WHERE NOT identity_key=ANY(%s)", (keys,)).rowcount
    written = conn.execute(WRITE, (keys, [roots[key].root_name for key in keys],
                                   [roots[key].stage for key in keys])).rowcount
    return removed + written
