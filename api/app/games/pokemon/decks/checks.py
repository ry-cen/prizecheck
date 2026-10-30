from uuid import UUID
from app.games.pokemon.decks.models import DeckChecks, IdentityCheck
from app.games.pokemon.formats.construction_checks import IdentityCount, evaluate_checks


# Basic checks read one quantity source: the Deck's physical copies (``checks``: its Holdings and its Borrowed Copies,
# #254) or its Deck List (``deck_list_checks``).
CHECK_SOURCES = {
    'deck_list': 'SELECT edition_id,quantity FROM deck_list_line WHERE owner_id=%(owner)s AND deck_id=%(deck)s',
    'holdings': 'SELECT edition_id,quantity FROM holding WHERE owner_id=%(owner)s AND location_id=%(deck)s '
                'UNION ALL SELECT edition_id,quantity FROM borrowed_holding '
                'WHERE borrower_id=%(owner)s AND location_id=%(deck)s',
}


def basic_checks(conn, generation_id, user_id: str, deck_id: UUID, source: str) -> DeckChecks:
    # The Basic Energy exemption reads the effective card attributes (migration 030), not the source energy type:
    # an identity is exempt only when every printing is Basic Energy, and unresolved when any printing's Basic
    # Energy status is unknown. ``generation_id`` is no longer read.
    groups = conn.execute(f"""SELECT ci.id,ci.display_name,sum(c.quantity) AS quantity,
      bool_and(a.basic_energy IS TRUE) AS exempt,
      bool_or(a.basic_energy IS NULL) AS unresolved
      FROM ({CHECK_SOURCES[source]}) c JOIN catalog_edition e ON e.id=c.edition_id
      JOIN catalog_printing p ON p.id=e.printing_id JOIN catalog_identity ci ON ci.id=p.identity_id
      LEFT JOIN catalog_card_attribute a ON a.printing_id=p.id
      GROUP BY ci.id,ci.display_name
      ORDER BY ci.display_name,ci.id""", {'owner': user_id, 'deck': deck_id}).fetchall()
    evaluated = evaluate_checks([IdentityCount(int(g['quantity']),g['exempt'],g['unresolved']) for g in groups])
    identities = [IdentityCheck(identity_id=g['id'],name=g['display_name'],quantity=str(g['quantity']),status=status)
                  for g,status in zip(groups,evaluated.identity_statuses)]
    return DeckChecks(total=str(evaluated.total),shortage=str(evaluated.shortage),excess=str(evaluated.excess),
                      size_status=evaluated.size_status,identities=identities)

