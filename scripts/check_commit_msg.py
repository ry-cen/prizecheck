"""The commit-msg hook: a commit subject must read `<type>: <sentence>` or `<type>(<scope>): <sentence>`.

Run as `.venv/bin/python scripts/check_commit_msg.py <message file>`; the types are those in CLAUDE.md."""
import re
import subprocess
import sys
from pathlib import Path

TYPES = ('feat', 'fix', 'perf', 'refactor', 'test', 'docs', 'ci', 'chore')
SUBJECT = re.compile(rf'^(?:{"|".join(TYPES)})(?:\([a-z0-9][a-z0-9-]*\))?: \S')
# Subjects git writes itself: `git commit --fixup/--squash` and `git revert`.
GENERATED = ('fixup! ', 'squash! ', 'amend! ', 'Revert "')


def comment_prefix():
    """git's comment string: `core.commentString`, then `core.commentChar`, else `#` (also for `auto`)."""
    for key in ('core.commentString', 'core.commentChar'):
        value = subprocess.run(['git', 'config', '--get', key], capture_output=True, text=True).stdout.strip()
        if value and value != 'auto':
            return value
    return '#'


def subject_of(message, comment='#'):
    """The commit's subject: its first non-blank line, or, when that line is a comment, the first line after the
    comments that an editor commit's cleanup keeps. `git commit -m` keeps comment lines, so a comment-only message
    yields the comment, which no type prefix matches."""
    lines = [line.rstrip() for line in message.splitlines() if line.strip()]
    if not lines:
        return ''
    if not lines[0].startswith(comment):
        return lines[0]
    kept = [line for line in lines if not line.startswith(comment)]
    return kept[0] if kept else lines[0]


def problem(subject):
    """None when the subject is acceptable, otherwise the reason it is not."""
    if not subject:
        return 'Commit message is empty.'
    if subject.startswith(GENERATED) or SUBJECT.match(subject):
        return None
    return (f'Commit subject needs a type prefix: {subject!r}\n'
            f'Write it as `<type>: <sentence>` or `<type>(<scope>): <sentence>`, with <type> one of: '
            f'{", ".join(TYPES)}. See "Usual flow" in CLAUDE.md.')


def main(argv):
    if len(argv) != 2:
        print('usage: check_commit_msg.py <commit message file>', file=sys.stderr)
        return 2
    reason = problem(subject_of(Path(argv[1]).read_text(encoding='utf-8'), comment_prefix()))
    if reason:
        print(reason, file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
