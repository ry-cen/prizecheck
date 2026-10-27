"""The inbox (social network #259), through signed HTTP against PostgreSQL.

What waits on a collector is worked out from Loan, return and Write-off state on every read: one line per Loan, with
the step it waits for, and the Loans tab's badge counts the same Loans. Steps store an update for the other side (a
request or offer accepted, partly accepted or declined, a Loan cancelled, the return-by date changed) naming who took
it and never why. Overdue and the 14-day nudge are worked out on read and listed until cleared. The inbox marks what it
showed read, Clear dismisses it, and updates read more than 90 days ago are deleted lazily. Each update says when it
happened, and a request or offer withdrawn reads as withdrawn, not cancelled (owner's decisions, 2026-10-16).

Trades (Trading #273) have two lists of their own beside the Loans': ``trade_waiting``, one line per Trade waiting on
the reader (a proposal to answer, an accepted Trade with an out-of-date pick, a swap the other side confirmed), and
``trade_updates``, what Trade steps told them, read and cleared through the same routes and pruned the same way. With
no Trades the inbox answers today's bytes, checked against ``inbox_fixtures/loan_inbox.json``, which was recorded from
the inbox before Trading #273.
"""
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest

from app.main import connect  # noqa: F401
from app.social import trades
from app.social.trades import TradeFacts, TradeView
from test_catalog_targets import isolated_rules  # noqa: F401  (an autouse fixture)
from test_deck_cost import launches, store  # noqa: F401  (autouse fixtures)
from test_deck_counting import hold
from test_for_trade_locations import mark as mark_for_trade
from test_friend_copies import collector, node, ok, place
from test_handover import handover, use_suggested
from test_holdings import call
from test_lend_offers import offer, offering, take
from test_loan_promises import holding
from test_loans import accept, sent, step, view
from test_moves import commit, selected, stage, start
from test_return_by import answer, ask, backdate, change, day, requested, seen
from test_returns import confirm_return, leave, lent_loan, start_return
from test_trade_migrations import PREVIOUS_INBOX_EVENTS
from test_trade_swap import confirm, picks, use_suggested as use_suggested_picks
from test_trades import accept_trade, move_one, proposed, read, row_of, trade_step, trading
from test_write_off import choose, write_off


def inbox(user):
    return ok(call('GET', '/api/social/inbox', user))


def waiting(user):
    """The inbox's waiting lines as (Loan id, step). The Loans tab's badge always counts the same Loans."""
    lines = [(loan['id'], loan['waiting']) for loan in inbox(user)['waiting']]
    assert ok(call('GET', '/api/social/loans', user))['needs_you'] == len(lines)
    return lines


def updates(user):
    return [(update['kind'], update['loan_id'], update['other_name'], update['read'])
            for update in inbox(user)['updates']]


def ids(user):
    return [update['id'] for update in inbox(user)['updates']]


def mark(user, action, names):
    return ok(call('POST', f'/api/social/inbox/{action}', user, {'ids': names}))


def test_waiting_on_you_follows_the_loan_through_its_steps_one_line_per_loan(store):
    iono, ash, misty, loan, more = requested(day(10), held=4)
    assert waiting(misty) == [(loan['id'], 'answer')] and waiting(ash) == []
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    assert waiting(misty) == [] and waiting(ash) == []
    # Misty moves her copies out of the Binder: her pick is out of date, which waits on her until she fixes it.
    binder, box = node(misty, 'Binder')['id'], place(misty, 'Box')
    manifest = start(misty, binder)
    stage(misty, manifest, [selected(iono, 4, holding(misty, binder, iono)['version'])])
    assert commit(misty, manifest, box).status_code == 200
    assert waiting(misty) == [(loan['id'], 'fix_picks')] and view(misty, loan)['section'] == 'needs_you'
    assert waiting(ash) == []
    ok(use_suggested(misty, loan))
    assert waiting(misty) == []
    # Each side's handover waits on the other.
    ok(handover(misty, loan))
    assert waiting(ash) == [(loan['id'], 'receive')] and waiting(misty) == []
    second = more(day(10))
    ok(accept(misty, view(misty, second), [(iono, 1)]))
    ok(handover(ash, second))
    assert waiting(misty) == [(second['id'], 'hand_over')]
    ok(handover(misty, second))
    ok(handover(ash, loan))
    assert waiting(misty) == [] and waiting(ash) == []
    # A return one side started, and more time the borrower asked for.
    ok(start_return(ash, loan, [(iono, 1)]))
    assert waiting(misty) == [(loan['id'], 'confirm_return')] and waiting(ash) == []
    ok(confirm_return(misty, loan))
    ok(ask(ash, second, day(20)))
    assert waiting(misty) == [(second['id'], 'more_time')]
    ok(answer(misty, second, 'approve'))
    assert waiting(misty) == [] and waiting(ash) == []


def test_a_write_off_choice_a_gone_collector_and_an_offer_wait_on_the_right_side(store):
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    ok(write_off(misty, loan, [(iono, 1)]))
    assert waiting(ash) == [(loan['id'], 'choose')] and waiting(misty) == []
    ok(choose(ash, loan, 'remove'))
    assert waiting(ash) == []
    # Ash gives one back, and Misty deletes her account before confirming it: the return waits on Ash to finish, then
    # his copy still out waits on him.
    ok(start_return(ash, loan, [(iono, 1)]))
    assert waiting(ash) == [] and waiting(misty) == [(loan['id'], 'confirm_return')]
    leave(misty)
    assert waiting(ash) == [(loan['id'], 'finish_return')]
    ok(confirm_return(ash, loan))
    assert waiting(ash) == [(loan['id'], 'return')]
    # A Lend Offer waits on the borrower.
    ids_, iono, ash, misty, binders = offering()
    offered = ok(offer(misty, ash, [(binders['Binder A'], iono, 2)]), 201)
    assert waiting(ash) == [(offered['id'], 'answer')] and waiting(misty) == []


def test_steps_store_an_update_for_the_other_side_naming_who_took_it_and_never_why(store):
    iono, ash, misty, loan, more = requested(held=6)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    part = sent(ash, misty, [(iono, 2)])
    ok(accept(misty, view(misty, part), [(iono, 1)]))
    ok(step(misty, view(misty, more()), 'decline'))
    ok(step(ash, more(), 'withdraw'))
    ok(step(misty, view(misty, part), 'cancel'))
    ok(change(misty, loan, day(10)))
    ok(change(misty, loan, day(10)))  # the same date changes nothing, and says nothing
    ok(ask(ash, loan, day(20)))
    ok(answer(misty, loan, 'approve'))
    told = updates(ash)
    assert [(kind, name, read) for kind, _, name, read in told] == [
        ('return_by_changed', 'Misty W.', False), ('return_by_changed', 'Misty W.', False),
        ('cancelled', 'Misty W.', False), ('declined', 'Misty W.', False), ('partly_accepted', 'Misty W.', False),
        ('accepted', 'Misty W.', False)]
    assert [loan_id for _, loan_id, _, _ in told][-2:] == [part['id'], loan['id']]
    assert [(kind, name) for kind, _, name, _ in updates(misty)] == [('withdrawn', 'Ash K.')]
    # A Lend Offer's answers go to the lender.
    ids_, iono, ash, misty, binders = offering()
    taken = ok(offer(misty, ash, [(binders['Binder A'], iono, 2)]), 201)
    ok(take(ash, taken, [(iono, 1)]))
    ok(step(ash, view(ash, ok(offer(misty, ash, [(binders['Binder B'], iono, 1)]), 201)), 'decline'))
    assert [(kind, name) for kind, _, name, _ in updates(misty)] == [
        ('declined', 'Ash K.'), ('partly_accepted', 'Ash K.')]
    assert updates(ash) == []
    first = inbox(misty)['updates'][0]
    assert (first['loan_kind'], first['loan_state'], first['role']) == ('lend_offer', 'closed', 'lender')


def test_the_inbox_marks_what_it_showed_read_clear_dismisses_it_and_old_read_updates_go(store):
    iono, ash, misty, loan, more = requested(held=6)
    for _ in range(3):
        ok(step(misty, view(misty, more()), 'decline'))
    before = inbox(ash)['updates']
    shown = [update['id'] for update in before]
    assert len(shown) == 3 and not any(update['read'] for update in before)
    assert mark(ash, 'read', shown)['updates'] == [{**update, 'read': True} for update in before]
    # An update that arrives after the drawer showed the others is neither marked nor cleared with them.
    ok(step(misty, view(misty, more()), 'decline'))
    cleared = mark(ash, 'clear', shown)
    assert [(update['kind'], update['read']) for update in cleared['updates']] == [('declined', False)]
    # Nobody else's ids, and nothing that isn't an update, are touched.
    (stranger, _) = collector()
    mark(stranger, 'clear', ids(ash) + ['nonsense', f'overdue:{uuid4()}'])
    assert len(ids(ash)) == 1
    # Read updates go 90 days after they were read, when the collector next marks or clears updates.
    with connect() as conn:
        rows = conn.execute('SELECT id FROM inbox_update WHERE recipient_id=%s ORDER BY created_at', (ash,)).fetchall()
        assert len(rows) == 4
        conn.execute("UPDATE inbox_update SET read_at = now() - interval '91 days' WHERE id=%s", (rows[0]['id'],))
        conn.execute("UPDATE inbox_update SET read_at = now() - interval '89 days' WHERE id=%s", (rows[1]['id'],))
        conn.execute("UPDATE inbox_update SET read_at = NULL, created_at = now() - interval '200 days' WHERE id=%s",
                     (rows[2]['id'],))
    mark(ash, 'read', [str(rows[3]['id'])])
    with connect() as conn:
        left = {row['id'] for row in conn.execute('SELECT id FROM inbox_update WHERE recipient_id=%s', (ash,))}
    assert left == {rows[1]['id'], rows[2]['id'], rows[3]['id']}


def test_overdue_and_the_nudge_are_listed_until_cleared_and_the_loan_screen_marks_them_read(store):
    iono, ash, misty, loan, more = requested(day(10), held=4)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    ok(handover(misty, loan))
    backdate(loan, return_by=day(-1))
    assert [(kind, read) for kind, _, _, read in updates(misty)] == [('overdue', False)]
    # Newest first: the acceptance happened just now, the overdue day began at midnight.
    assert [(kind, name) for kind, _, name, _ in updates(ash)] == [('accepted', 'Misty W.'), ('overdue', 'Misty W.')]
    assert inbox(ash)['updates'][1]['return_by'] == day(-1)
    # Misty opens the Loan: the notice is read, and stays listed until she clears it.
    assert seen(misty, loan, ['overdue'])['notices'] == []
    assert [(kind, read) for kind, _, _, read in updates(misty)] == [('overdue', True)]
    # Ash's inbox showing it counts as seen on the Loan screen too.
    mark(ash, 'read', ids(ash))
    assert view(ash, loan)['notices'] == []
    mark(misty, 'clear', ids(misty))
    assert updates(misty) == [] and [kind for kind, _, _, _ in updates(ash)] == ['accepted', 'overdue']
    # A notice not showing yet can't be cleared ahead of time.
    second = more()
    ok(accept(misty, view(misty, second), [(iono, 1)]))
    mark(misty, 'clear', [f'nudge_handover:{second["id"]}'])
    with connect() as conn:
        conn.execute("UPDATE loan SET accepted_at = now() - interval '14 days' WHERE id=%s", (second['id'],))
    assert [(kind, loan_id) for kind, loan_id, _, _ in updates(misty)] == [('nudge_handover', second['id'])]
    mark(misty, 'clear', ids(misty))
    assert updates(misty) == []


def test_a_step_storing_an_update_never_waits_on_the_other_collectors_owner_row(store):
    # Ash's owner row is held FOR UPDATE, as his own inventory commands hold it. Misty's steps that tell him something
    # still run: the update names him with no key check on his row.
    iono, ash, misty, loan, more = requested(day(10), held=4)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    second = view(misty, more())
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, ThreadPoolExecutor(max_workers=1) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (ash,))
        assert executor.submit(change, misty, loan, day(12)).result(timeout=20).status_code == 200
        assert executor.submit(step, misty, second, 'decline').result(timeout=20).status_code == 200
        assert executor.submit(step, misty, view(misty, loan), 'cancel').result(timeout=20).status_code == 200
        holder.rollback()
    assert [kind for kind, _, _, _ in updates(ash)] == ['cancelled', 'declined', 'return_by_changed', 'accepted']


def test_each_update_says_when_it_happened_and_a_withdrawn_request_or_offer_reads_as_withdrawn(store):
    iono, ash, misty, loan, more = requested(day(10), held=4)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    withdrawn = more()
    ok(step(ash, withdrawn, 'withdraw'))
    # An event update happened when the step stored it; a withdraw reads as withdrawn, naming who withdrew.
    with connect() as conn:
        stored = {str(row['loan_id']): row['created_at'] for row in conn.execute(
            'SELECT loan_id, created_at FROM inbox_update WHERE recipient_id = ANY(%s)', ([ash, misty],))}
    (told,) = inbox(misty)['updates']
    assert (told['kind'], told['loan_id'], told['other_name']) == ('withdrawn', withdrawn['id'], 'Ash K.')
    assert datetime.fromisoformat(told['at']) == stored[withdrawn['id']]
    (accepted,) = inbox(ash)['updates']
    assert accepted['kind'] == 'accepted' and datetime.fromisoformat(accepted['at']) == stored[loan['id']]
    # A time-based update happened when it began to apply: overdue from the start of the day after the return-by date,
    # by the database's clock; a nudge 14 days after the request was sent or accepted.
    ok(handover(misty, loan))
    backdate(loan, return_by=day(-3))
    unanswered, waiting_handover = more(), more()
    ok(accept(misty, view(misty, waiting_handover), [(iono, 1)]))
    with connect() as conn:
        conn.execute("UPDATE loan SET created_at = now() - interval '15 days' WHERE id=%s", (unanswered['id'],))
        conn.execute("UPDATE loan SET accepted_at = now() - interval '16 days' WHERE id=%s", (waiting_handover['id'],))
        began = conn.execute("""SELECT (%s::date + 1)::timestamptz AS overdue,
            (SELECT created_at + interval '14 days' FROM loan WHERE id=%s) AS answer,
            (SELECT accepted_at + interval '14 days' FROM loan WHERE id=%s) AS handover""",
                             (day(-3), unanswered['id'], waiting_handover['id'])).fetchone()
    # Time-based notices and stored events interleave in time order, newest first.
    listed = [datetime.fromisoformat(update['at']) for update in inbox(misty)['updates']]
    assert len(listed) > 1 and listed == sorted(listed, reverse=True)
    at = {(update['kind'], update['loan_id']): datetime.fromisoformat(update['at']) for update in inbox(misty)['updates']}
    assert at == {('overdue', loan['id']): began['overdue'], ('nudge_answer', unanswered['id']): began['answer'],
                  ('nudge_handover', waiting_handover['id']): began['handover'],
                  ('withdrawn', withdrawn['id']): stored[withdrawn['id']]}
    # A Lend Offer its lender withdraws reads as withdrawn to the borrower; a cancel still reads as cancelled.
    ids_, iono, ash, misty, binders = offering()
    offered = ok(offer(misty, ash, [(binders['Binder A'], iono, 1)]), 201)
    ok(step(misty, view(misty, offered), 'withdraw'))
    kept = ok(offer(misty, ash, [(binders['Binder A'], iono, 1)]), 201)
    ok(take(ash, kept, [(iono, 1)]))
    ok(step(ash, view(ash, kept), 'cancel'))
    assert [(update['kind'], update['loan_kind'], update['other_name']) for update in inbox(ash)['updates']] == [
        ('withdrawn', 'lend_offer', 'Misty W.')]
    assert [(kind, name) for kind, _, name, _ in updates(misty)] == [('cancelled', 'Ash K.'), ('accepted', 'Ash K.')]


def since(user, loan):
    """The time the inbox says ``loan`` has waited on ``user`` since, as a datetime."""
    (found,) = [line for line in inbox(user)['waiting'] if line['id'] == loan['id']]
    return datetime.fromisoformat(found['since'])


def stored(loan, *columns):
    with connect() as conn:
        row = conn.execute(f'SELECT {", ".join(columns)} FROM loan WHERE id=%s', (loan['id'],)).fetchone()
    return tuple(row.values())


def test_each_waiting_line_says_since_when_the_loan_reached_the_step_that_waits_on_the_reader(store):
    iono, ash, misty, loan, more = requested(day(10), held=4)
    # A request waits from when it was sent.
    assert since(misty, loan) == stored(loan, 'created_at')[0]
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    # A handover the other side confirmed waits from that confirmation, for either side.
    ok(handover(misty, loan))
    assert since(ash, loan) == stored(loan, 'lender_handover_at')[0]
    second = more(day(10))
    ok(accept(misty, view(misty, second), [(iono, 1)]))
    ok(handover(ash, second))
    assert since(misty, second) == stored(second, 'borrower_handover_at')[0]
    ok(handover(misty, second))
    ok(handover(ash, loan))
    # A return waits from when it was started.
    ok(start_return(ash, loan, [(iono, 1)]))
    with connect() as conn:
        started = conn.execute('SELECT created_at FROM loan_return WHERE loan_id=%s', (loan['id'],)).fetchone()
    assert since(misty, loan) == started['created_at']
    # More time waits from when it was asked, not from a date: the ask moves nothing else on the Loan.
    ok(ask(ash, second, day(20)))
    assert since(misty, second) == stored(second, 'extension_asked_at')[0] != stored(second, 'accepted_at')[0]
    # Each line carries a time and a Lend Offer waits from when it was sent.
    ids_, iono, ash, misty, binders = offering()
    offered = ok(offer(misty, ash, [(binders['Binder A'], iono, 2)]), 201)
    assert since(ash, offered) == stored(offered, 'created_at')[0]


def test_a_write_off_choice_waits_from_the_write_off_and_a_gone_collectors_loan_from_the_readers_handover(store):
    iono, ash, misty, binders, loan, _ = lent_loan({'Binder': 3}, 3)
    ok(write_off(misty, loan, [(iono, 1)]))
    assert since(ash, loan) == stored(loan, 'written_off_at')[0] is not None
    ok(choose(ash, loan, 'remove'))
    ok(start_return(ash, loan, [(iono, 1)]))
    with connect() as conn:
        started = conn.execute('SELECT created_at FROM loan_return WHERE loan_id=%s', (loan['id'],)).fetchone()
    leave(misty)
    assert since(ash, loan) == started['created_at']
    ok(confirm_return(ash, loan))
    assert since(ash, loan) == stored(loan, 'borrower_handover_at')[0]


# Trades (Trading #273).

FIXTURE = Path(__file__).resolve().parent / 'inbox_fixtures' / 'loan_inbox.json'
UUID_TEXT = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
TIME_TEXT = re.compile(r'"\d{4}-\d{2}-\d{2}T[^"]+"')
DAY_TEXT = re.compile(r'"\d{4}-\d{2}-\d{2}"')
HANDLE_TEXT = re.compile(r'"handle":"[^"]+"')


def loan_story():
    """A Loan-only inbox on both sides, as ``FIXTURE`` recorded it: Misty accepted Ash's request and confirmed the
    handover (it waits on Ash to confirm he has the cards, and is overdue for both), declined another, Ash withdrew a
    third and a fourth waits on Misty's answer; Ash was shown his oldest update. Returns (Iono, Ash, Misty)."""
    iono, ash, misty, loan, more = requested(day(10), held=6)
    ok(accept(misty, view(misty, loan), [(iono, 1)]))
    ok(handover(misty, loan))
    ok(step(misty, view(misty, more()), 'decline'))
    ok(step(ash, more(), 'withdraw'))
    more()
    backdate(loan, return_by=day(-1))
    mark(ash, 'read', [ids(ash)[-1]])
    return iono, ash, misty


def snapshot(*bodies: bytes) -> list[str]:
    """Raw inbox bodies with what differs from run to run replaced, so two runs of ``loan_story`` give the same text:
    each id by its order of first appearance across all the bodies (``<id 3>``), each Handle, time and date."""
    numbered: dict[str, str] = {}

    def number(found) -> str:
        return numbered.setdefault(found.group(0), f'<id {len(numbered) + 1}>')

    texts = []
    for body in bodies:
        text = UUID_TEXT.sub(number, HANDLE_TEXT.sub('"handle":"<handle>"', body.decode()))
        texts.append(DAY_TEXT.sub('"<day>"', TIME_TEXT.sub('"<time>"', text)))
    return texts


def raw_inboxes(*users) -> list[bytes]:
    return [call('GET', '/api/social/inbox', user).content for user in users]


def loan_part(body: bytes) -> bytes:
    """The body up to the Trade lists, closed as today's body was: the Loan fields, byte for byte."""
    return body[:body.index(b',"trade_waiting":')] + b'}'


def trade_lines(user):
    """The inbox's Trade lines as (Trade id, step). The Trades list's ``needs_you`` always counts the same Trades."""
    lines = [(line['id'], line['waiting']) for line in inbox(user)['trade_waiting']]
    assert ok(call('GET', '/api/social/trades', user))['needs_you'] == len(lines)
    return lines


def trade_told(user):
    """The reader's Trade updates as (kind, Trade id, other_name, role, trade_state, read), newest first."""
    return [(update['kind'], update['trade_id'], update['other_name'], update['role'], update['trade_state'],
             update['read']) for update in inbox(user)['trade_updates']]


def trade_since(user, trade):
    (found,) = [line for line in inbox(user)['trade_waiting'] if line['id'] == trade['id']]
    return datetime.fromisoformat(found['since'])


def test_with_no_trades_the_inbox_answers_todays_bytes_and_trades_never_change_the_loan_fields(store):
    iono, ash, misty = loan_story()
    recorded = json.loads(FIXTURE.read_text(encoding='utf-8'))
    today_ = [recorded['ash'], recorded['misty']]
    assert snapshot(*raw_inboxes(ash, misty)) == [
        text[:-1] + ',"trade_waiting":[],"trade_updates":[]}' for text in today_]
    # Trades between the same two collectors: one waits on Ash's answer, and Ash declined another, which tells Misty.
    binder = place(misty, 'Trade Binder')
    hold(misty, binder, iono, 2)
    ok(mark_for_trade(misty, binder))
    waiting_ = proposed(misty, ash, give=[(iono, 1)])
    ok(trade_step(ash, proposed(misty, ash, give=[(iono, 1)]), 'decline'))
    bodies = raw_inboxes(ash, misty)
    assert snapshot(*[loan_part(body) for body in bodies]) == today_
    seen_by_ash, seen_by_misty = (json.loads(body) for body in bodies)
    assert [line['id'] for line in seen_by_ash['trade_waiting']] == [waiting_['id']]
    assert [update['kind'] for update in seen_by_misty['trade_updates']] == ['declined']
    # The bell counts both: one Loan and one Trade wait on Ash.
    assert (len(seen_by_ash['waiting']), len(seen_by_ash['trade_waiting'])) == (1, 1)


def test_trades_wait_on_the_side_whose_step_it_is_one_line_each(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 3)], get=[(arven, 1)])
    # A proposal waits on its recipient's answer, never on the proposer.
    assert trade_lines(ash) == [(trade['id'], 'answer')] and trade_lines(misty) == []
    ok(accept_trade(ash, trade))
    # Accepted, nobody confirmed and every pick up to date: it waits on neither side.
    assert trade_lines(ash) == [] and trade_lines(misty) == []
    # Misty moves a picked Iono out of the Trade Binder: her pick is out of date, which waits on her until she fixes
    # it, on the Trades list too.
    shelf = place(misty, 'Shelf')
    move_one(misty, binder, iono, shelf)
    assert trade_lines(misty) == [(trade['id'], 'fix_picks')] and trade_lines(ash) == []
    seen = ok(read(misty, trade))
    assert (seen['waiting'], seen['needs_you'], seen['section']) == ('fix_picks', True, 'needs_you')
    assert ok(read(ash, trade))['section'] == 'to_swap'
    # Ash confirms. Misty's Trade now needs two things and is still one line, the out-of-date pick first.
    ok(confirm(ash, trade))
    assert trade_lines(misty) == [(trade['id'], 'fix_picks')] and trade_lines(ash) == []
    # Use suggested picks fixes it: the swap Ash confirmed waits on her.
    ok(use_suggested_picks(misty, trade))
    assert trade_lines(misty) == [(trade['id'], 'confirm_swap')]
    ok(confirm(misty, trade))
    assert trade_lines(misty) == [] and trade_lines(ash) == []
    # A proposer's out-of-date pick while the proposal waits shows on the Trade screen only: the proposal waits on the
    # recipient's answer, not on the proposer.
    hold(misty, binder, iono, 2)
    waiting_ = proposed(misty, ash, give=[(iono, 2)])
    move_one(misty, binder, iono, shelf)
    assert [short for _, _, short in picks(misty, waiting_)] == ['1']
    assert trade_lines(misty) == [] and trade_lines(ash) == [(waiting_['id'], 'answer')]


def test_each_trade_line_says_since_when_the_trade_reached_the_step_that_waits_on_the_reader(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    trade = proposed(misty, ash, give=[(iono, 3)], get=[(arven, 1)])
    newer = proposed(misty, ash, get=[(arven, 1)])
    # A proposal waits from when it was sent; the newest waiting line comes first.
    assert [line['id'] for line in inbox(ash)['trade_waiting']] == [newer['id'], trade['id']]
    assert trade_since(ash, trade) == row_of(trade)['created_at']
    ok(accept_trade(ash, trade))
    # An out-of-date pick has no moment of its own: it waits from the acceptance.
    move_one(misty, binder, iono, place(misty, 'Shelf'))
    row = row_of(trade)
    assert trade_since(misty, trade) == row['accepted_at'] != row['created_at']
    # A swap the other side confirmed waits from that confirmation.
    ok(use_suggested_picks(misty, trade))
    ok(confirm(ash, trade))
    assert trade_since(misty, trade) == row_of(trade)['recipient_swap_at'] is not None


def test_trade_steps_tell_the_other_side_who_took_them_and_a_withdraw_reads_as_withdrawn(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    swapped = proposed(misty, ash, give=[(iono, 1)])
    ok(accept_trade(ash, swapped))
    declined = proposed(misty, ash, give=[(iono, 1)])
    ok(trade_step(ash, declined, 'decline'))
    withdrawn = proposed(misty, ash, give=[(iono, 1)])
    ok(trade_step(misty, withdrawn, 'withdraw'))
    cancelled = ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)])))
    ok(trade_step(misty, ok(read(misty, cancelled)), 'cancel'))
    # Ash confirms first, then Misty: the swap tells Ash, the side that confirmed first.
    ok(confirm(ash, swapped))
    ok(confirm(misty, swapped))
    assert trade_told(misty) == [
        ('accepted', cancelled['id'], 'Ash K.', 'proposer', 'closed', False),
        ('declined', declined['id'], 'Ash K.', 'proposer', 'closed', False),
        ('accepted', swapped['id'], 'Ash K.', 'proposer', 'closed', False)]
    assert trade_told(ash) == [
        ('swapped', swapped['id'], 'Misty W.', 'recipient', 'closed', False),
        ('cancelled', cancelled['id'], 'Misty W.', 'recipient', 'closed', False),
        ('withdrawn', withdrawn['id'], 'Misty W.', 'recipient', 'closed', False)]
    # Each says when its step stored it; none is a Loan update, and no update is time-based.
    with connect() as conn:
        stored_at = {str(row['id']): row['created_at'] for row in conn.execute(
            'SELECT id, created_at FROM inbox_update WHERE recipient_id = ANY(%s)', ([ash, misty],))}
    for user in (ash, misty):
        body = inbox(user)
        assert body['updates'] == [] and body['waiting'] == []
        assert {update['id']: datetime.fromisoformat(update['at']) for update in body['trade_updates']} == {
            update['id']: stored_at[update['id']] for update in body['trade_updates']}
    # An update shows the Trade's state now: an accepted proposal not yet swapped reads as accepted.
    ok(accept_trade(ash, proposed(misty, ash, give=[(iono, 1)])))
    assert trade_told(misty)[0][0::4] == ('accepted', 'accepted')


def test_trade_updates_are_read_cleared_and_pruned_by_the_loan_routes_and_an_older_build_never_reads_one(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    for _ in range(3):
        ok(trade_step(ash, proposed(misty, ash, give=[(iono, 1)]), 'decline'))
    before = inbox(misty)['trade_updates']
    shown = [update['id'] for update in before]
    assert len(shown) == 3 and not any(update['read'] for update in before)
    assert mark(misty, 'read', shown)['trade_updates'] == [{**update, 'read': True} for update in before]
    # A Loan update and a Trade update that arrive after the drawer showed the others are neither marked nor cleared
    # with them; then one Clear names both kinds.
    loan = sent(ash, misty, [(iono, 1)])
    ok(step(ash, loan, 'withdraw'))
    ok(trade_step(ash, proposed(misty, ash, give=[(iono, 1)]), 'decline'))
    cleared = mark(misty, 'clear', shown)
    assert [(update['kind'], update['read']) for update in cleared['trade_updates']] == [('declined', False)]
    assert [(update['kind'], update['read']) for update in cleared['updates']] == [('withdrawn', False)]
    # The older build's inbox join on loan reads only the Loan update.
    with connect() as conn:
        assert [str(row['loan_id']) for row in conn.execute(PREVIOUS_INBOX_EVENTS, (misty, 50))] == [loan['id']]
    # Nobody else's ids, the other side's included, touch Misty's updates.
    (gary, _) = collector()
    newest = [update['id'] for update in cleared['trade_updates'] + cleared['updates']]
    for user in (gary, ash):
        mark(user, 'read', newest)
        mark(user, 'clear', newest)
    assert [update['read'] for update in inbox(misty)['trade_updates'] + inbox(misty)['updates']] == [False, False]
    assert mark(misty, 'clear', newest)['trade_updates'] == [] and inbox(misty)['updates'] == []
    # Read Trade updates go 90 days after they were read, when the collector next marks or clears updates.
    with connect() as conn:
        rows = conn.execute('SELECT id FROM inbox_update WHERE recipient_id=%s AND trade_id IS NOT NULL '
                            'ORDER BY created_at', (misty,)).fetchall()
        assert len(rows) == 4
        conn.execute("UPDATE inbox_update SET read_at = now() - interval '91 days' WHERE id=%s", (rows[0]['id'],))
        conn.execute("UPDATE inbox_update SET read_at = now() - interval '89 days' WHERE id=%s", (rows[1]['id'],))
        conn.execute("UPDATE inbox_update SET read_at = NULL, created_at = now() - interval '200 days' WHERE id=%s",
                     (rows[2]['id'],))
    mark(misty, 'read', [str(rows[3]['id'])])
    with connect() as conn:
        left = {row['id'] for row in conn.execute(
            'SELECT id FROM inbox_update WHERE recipient_id=%s AND trade_id IS NOT NULL', (misty,))}
    assert left == {rows[1]['id'], rows[2]['id'], rows[3]['id']}


def test_only_the_two_sides_see_a_trades_lines_and_updates_and_none_names_a_location(store):
    ids, ash, misty, binder, box = trading()
    iono, arven = ids['PAL 185'], ids['SVI 166']
    (gary, _) = collector('Gary O.')
    trade = proposed(misty, ash, give=[(iono, 3)], get=[(arven, 1)])
    ok(accept_trade(ash, trade))
    shelf = place(misty, 'Shelf')
    move_one(misty, binder, iono, shelf)
    ok(confirm(ash, trade))
    # Misty's line waits on her out-of-date pick and her update says Ash accepted; Ash's has nothing waiting.
    bodies = dict(zip(('ash', 'misty', 'gary'), (call('GET', '/api/social/inbox', user) for user in (ash, misty, gary))))
    assert [line['waiting'] for line in bodies['misty'].json()['trade_waiting']] == ['fix_picks']
    assert [update['kind'] for update in bodies['misty'].json()['trade_updates']] == ['accepted']
    # Neither side's Locations, by name or id, reach either inbox, the reader's own included.
    for response in bodies.values():
        for secret in ('Trade Binder', 'Box', 'Shelf', binder, box, shelf):
            assert secret not in response.text
    # The shapes: a Trade line is the Trade view both sides read plus since, and an update has no more than it says.
    (line,) = bodies['misty'].json()['trade_waiting']
    assert set(line) == set(TradeView.model_fields) | {'since'}
    (update,) = bodies['misty'].json()['trade_updates']
    assert set(update) == {'id', 'kind', 'trade_id', 'trade_state', 'role', 'other_name', 'read', 'at'}
    # A stranger sees none of it, even an update row naming the Trade that was stored for them.
    assert bodies['gary'].json() == {'waiting': [], 'updates': [], 'trade_waiting': [], 'trade_updates': []}
    with connect() as conn:
        conn.execute("""INSERT INTO inbox_update(id, recipient_id, kind, trade_id, other_name)
          VALUES (%s, %s, 'accepted', %s, 'Misty W.')""", (uuid4(), gary, trade['id']))
    assert inbox(gary)['trade_updates'] == []


def test_the_inbox_reads_trades_without_waiting_on_a_lock_and_a_trade_step_never_waits_on_the_other_side(store):
    ids, ash, misty, binder, box = trading()
    iono = ids['PAL 185']
    trade = proposed(misty, ash, give=[(iono, 2)])
    ok(accept_trade(ash, trade))
    withdrawn = proposed(misty, ash, give=[(iono, 1)])
    shelf = place(misty, 'Shelf')
    move_one(misty, binder, iono, shelf)
    move_one(misty, binder, iono, shelf)
    # Misty's owner row, her Holdings and the Trade row are held as her inventory commands and Trade steps hold them;
    # her inbox still reads the out-of-date pick, and marks and clears.
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, ThreadPoolExecutor(max_workers=1) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (misty,))
        holder.execute('SELECT 1 FROM holding WHERE owner_id=%s FOR UPDATE', (misty,))
        holder.execute('SELECT 1 FROM trade WHERE id=%s FOR UPDATE', (trade['id'],))
        seen = executor.submit(call, 'GET', '/api/social/inbox', misty).result(timeout=20)
        assert [line['waiting'] for line in seen.json()['trade_waiting']] == ['fix_picks']
        names = [update['id'] for update in seen.json()['trade_updates']]
        assert executor.submit(mark, misty, 'clear', names).result(timeout=20)['trade_updates'] == []
        holder.rollback()
    # Ash's owner row is held FOR UPDATE, as his own inventory commands hold it: Misty's steps that lock only her own
    # row still run, and the withdraw's update names him with no key check on his row.
    with psycopg.connect(os.environ['DATABASE_URL']) as holder, ThreadPoolExecutor(max_workers=1) as executor:
        holder.execute('SELECT 1 FROM inventory_owner WHERE user_id=%s FOR UPDATE', (ash,))
        assert executor.submit(trade_step, misty, withdrawn, 'withdraw').result(timeout=20).status_code == 200
        assert executor.submit(use_suggested_picks, misty, trade).result(timeout=20).status_code == 200
        assert executor.submit(confirm, misty, trade).result(timeout=20).status_code == 200
        holder.rollback()
    assert [update['kind'] for update in inbox(ash)['trade_updates']] == ['withdrawn']


@pytest.mark.parametrize('state, reader, swaps, stale, waiting, section', [
    ('proposed', 'recipient', (None, None), True, 'answer', 'needs_you'),
    ('proposed', 'proposer', (None, None), True, None, 'pending'),
    ('accepted', 'proposer', (None, None), True, 'fix_picks', 'needs_you'),
    ('accepted', 'proposer', (None, None), False, None, 'to_swap'),
    ('accepted', 'proposer', (None, 'now'), True, 'fix_picks', 'needs_you'),
    ('accepted', 'proposer', (None, 'now'), False, 'confirm_swap', 'needs_you'),
    ('accepted', 'proposer', ('now', None), True, None, 'pending'),
    ('closed', 'recipient', (None, None), True, None, 'history'),
])
def test_an_out_of_date_pick_waits_first_on_an_accepted_trade_the_reader_has_not_confirmed(
        state, reader, swaps, stale, waiting, section):
    row = {'state': state, 'proposer_id': 'misty', 'recipient_id': 'ash', 'proposer_swap_at': swaps[0],
           'recipient_swap_at': swaps[1]}
    user = 'misty' if reader == 'proposer' else 'ash'
    facts = TradeFacts(stale_picks=stale)
    assert (trades.waiting_trade_step(user, row, facts), trades.section(user, row, facts)) == (waiting, section)


def test_since_is_read_from_the_time_the_trade_reached_its_step():
    created = datetime(2026, 10, 1, tzinfo=timezone.utc)
    accepted_, swapped_ = created + timedelta(days=1), created + timedelta(days=2)
    row = {'proposer_id': 'misty', 'recipient_id': 'ash', 'created_at': created, 'accepted_at': accepted_,
           'proposer_swap_at': None, 'recipient_swap_at': swapped_}
    assert trades.trade_waiting_since('ash', row, 'answer') == created
    assert trades.trade_waiting_since('misty', row, 'fix_picks') == accepted_
    assert trades.trade_waiting_since('misty', row, 'confirm_swap') == swapped_
    assert trades.trade_waiting_since('misty', {**row, 'accepted_at': None}, 'fix_picks') == created
