"""The Handle and Display Name rules (social network #246, ``app.social.name_rules``). Pure: no database."""
import pytest

from app.social import name_rules
from app.social.name_rules import NameRefused, clean_display_name, clean_handle, offensive


def refusal(rule, value):
    with pytest.raises(NameRefused) as caught:
        rule(value)
    return caught.value.code


@pytest.mark.parametrize('handle', ['Ash_Ketchum', 'abc', 'a' * 20, 'collector', 'Collector_bcdfghjk', 'modern',
                                    'Ishita', 'Cassandra', 'hello_world', '007'])
def test_handles_that_are_allowed(handle):
    assert clean_handle(handle) == handle


def test_a_handle_keeps_its_case_and_loses_surrounding_spaces():
    assert clean_handle('  MistyW  ') == 'MistyW'


@pytest.mark.parametrize('handle', ['ab', 'a' * 21, 'has space', 'dash-ed', 'dot.ted', 'Zoë', '', 'émile'])
def test_handles_with_the_wrong_characters_or_length(handle):
    assert refusal(clean_handle, handle) == 'INVALID_HANDLE'


@pytest.mark.parametrize('handle', ['admin', 'ADMIN', 'Admin_2', 'admin99', 'support_team', 'PrizeCheck',
                                    'the_prizecheck_fan', '4dmin', 'Mod', 'noreply', 'TCGplayer'])
def test_reserved_handles(handle):
    assert refusal(clean_handle, handle) == 'HANDLE_NOT_ALLOWED'


@pytest.mark.parametrize('handle', ['sh1t', 'FUCK', 'x_fuck_x', 'FuckThis', 'b1tch_please'])
def test_offensive_handles(handle):
    assert refusal(clean_handle, handle) == 'HANDLE_NOT_ALLOWED'


@pytest.mark.parametrize('name', ['Ash Ketchum', 'Zoë', '名前', 'Collector', 'x' * 40, 'Ishita', 'Scott Horpe'])
def test_display_names_that_are_allowed(name):
    assert clean_display_name(name) == name


def test_a_display_name_is_nfc_and_trimmed():
    assert clean_display_name('  Zoë  ') == 'Zoë'


@pytest.mark.parametrize('name', ['', '   ', 'x' * 41, 'a‮b', 'Bob​', 'tab\there', 'line break',
                                  'private'])
def test_display_names_that_are_empty_too_long_or_unprintable(name):
    assert refusal(clean_display_name, name) == 'INVALID_DISPLAY_NAME'


@pytest.mark.parametrize('name', ['Support Team', 'Prize Check', 'PRIZECHECK official', 'Admin', 'A.d.m.i.n',
                                  'Shit happens', 'Ash 🖕', 'Blue Waffle fan', 'F u c k'])
def test_reserved_and_offensive_display_names(name):
    assert refusal(clean_display_name, name) == 'DISPLAY_NAME_NOT_ALLOWED'


def test_the_filter_reads_accents_case_and_stand_ins():
    assert offensive('Fück') and offensive('FUCK') and offensive('$h1t')
    assert not offensive('Cassandra') and not offensive('Ishita') and not offensive('Scott Horpe')


def test_inside_entries_match_anywhere_and_words_only_whole():
    # "cunt" is an [inside] entry; "ass" is a whole word only.
    assert offensive('Scunthorpe')
    assert offensive('ass') and not offensive('Cassandra') and not offensive('class_act')


def test_the_lists_load_every_section():
    words, phrases, joined, inside, symbols = name_rules._lists()
    assert 'fuck' in words and ('blue', 'waffle') in phrases and 'bluewaffle' in joined
    assert 'fuck' in inside and '🖕' in symbols and 'shit' not in inside
