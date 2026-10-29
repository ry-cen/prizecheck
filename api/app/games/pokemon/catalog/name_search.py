"""Close spellings for Catalog's name search (``catalog_browse``, migration 048).

A name search lists the Card Editions whose name contains q, comparing letters and digits only. When no listed
Edition's name does, the browse route lists the names spelled close to q instead: each word of q is at most a few edits
from the start of some word of the name, or of the whole name run together. An edit adds, drops or changes one
character, or swaps two neighbours. A word under 5 characters allows none, a word of 5 to 8 one, a longer word two, and
q needs ``FUZZY_MIN_LENGTH`` letters and digits before any close spelling counts, so a short query such as "char" never
reaches names it doesn't contain ("Chatot"). Names arrive normalized by the database (``search_words``, from
``catalog_search_words``), and so does q; nothing here normalizes text.
"""
from collections.abc import Iterable

FUZZY_MIN_LENGTH = 5


def edits_allowed(word: str) -> int:
    """How many edits one word of q may be from a word of the name: none under 5 characters, one up to 8, two after."""
    size = len(word)
    return 0 if size < 5 else 1 if size < 9 else 2


def near_prefix(word: str, target: str, allowed: int) -> bool:
    """Whether ``word`` is at most ``allowed`` edits from some prefix of ``target`` (optimal string alignment distance:
    insert, delete, substitute, or swap two neighbouring characters)."""
    if allowed == 0:
        return target.startswith(word)
    if len(target) < len(word) - allowed:
        return False
    # previous[j] is the distance from word[:i-1] to target[:j]; before is the row above it.
    before: list[int] = []
    previous = list(range(len(target) + 1))
    for i in range(1, len(word) + 1):
        current = [i] + [0] * len(target)
        for j in range(1, len(target) + 1):
            best = min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (word[i - 1] != target[j - 1]))
            if i > 1 and j > 1 and word[i - 1] == target[j - 2] and word[i - 2] == target[j - 1]:
                best = min(best, before[j - 2] + 1)
            current[j] = best
        if min(current) > allowed:  # every later row is at least this far
            return False
        before, previous = previous, current
    return min(previous) <= allowed


def close_names(query_words: str, names: Iterable[str]) -> list[str]:
    """The names spelled close to q, in the order given. ``query_words`` is ``catalog_search_words(q)``; each name is a
    ``search_words`` value. Empty when q has fewer than FUZZY_MIN_LENGTH letters and digits."""
    words = query_words.split()
    if len("".join(words)) < FUZZY_MIN_LENGTH:
        return []
    allowed = {word: edits_allowed(word) for word in words}
    known: dict[tuple[str, str], bool] = {}

    def near(word: str, target: str) -> bool:
        if (word, target) not in known:
            known[word, target] = near_prefix(word, target, allowed[word])
        return known[word, target]

    found = []
    for name in names:
        parts = name.split()
        targets = [*parts, "".join(parts)] if len(parts) > 1 else parts
        if all(any(near(word, target) for target in targets) for word in words):
            found.append(name)
    return found
