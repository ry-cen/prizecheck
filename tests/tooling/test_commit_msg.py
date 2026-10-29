"""scripts/check_commit_msg.py, the commit-msg hook's subject check."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import check_commit_msg  # noqa: E402


class CommitSubjectTest(unittest.TestCase):
    def test_accepts_each_type_with_and_without_a_scope(self):
        for kind in check_commit_msg.TYPES:
            for subject in (f'{kind}: Show the price', f'{kind}(scanner): Show the price'):
                with self.subTest(subject=subject):
                    self.assertIsNone(check_commit_msg.problem(subject))

    def test_accepts_subjects_git_writes(self):
        for subject in ('fixup! feat: Show the price', 'squash! anything', 'amend! fix: x',
                        'Revert "feat: Show the price"'):
            with self.subTest(subject=subject):
                self.assertIsNone(check_commit_msg.problem(subject))

    def test_rejects_a_missing_or_unknown_or_malformed_prefix(self):
        for subject in ('Show the price', 'feature: Show the price', 'Feat: Show the price', 'feat:Show the price',
                        'feat : Show the price', 'feat(): Show the price', 'feat(Scanner): Show the price',
                        'feat: ', 'Merge branch dev'):
            with self.subTest(subject=subject):
                self.assertIn('needs a type prefix', check_commit_msg.problem(subject))

    def test_subject_skips_comments_and_leading_blank_lines(self):
        message = '# Please enter the commit message\n\nfix: Keep the scroll\n\nBody line\n'
        self.assertEqual(check_commit_msg.subject_of(message), 'fix: Keep the scroll')

    def test_comment_only_message_is_its_own_subject(self):
        # `git commit -m '# x'` keeps the line, so it is the subject and is rejected.
        self.assertEqual(check_commit_msg.subject_of('# Missing the prefix\n'), '# Missing the prefix')
        self.assertIn('needs a type prefix', check_commit_msg.problem('# Missing the prefix'))

    def test_subject_uses_the_configured_comment_string(self):
        message = '; comment\n\nfix: Keep the scroll\n# not a comment here\n'
        self.assertEqual(check_commit_msg.subject_of(message, ';'), 'fix: Keep the scroll')
        self.assertEqual(check_commit_msg.subject_of('# Keep the scroll\n', ';'), '# Keep the scroll')

    def test_empty_message_is_rejected(self):
        self.assertEqual(check_commit_msg.problem(check_commit_msg.subject_of('\n\n')), 'Commit message is empty.')

    def test_hook_exit_codes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'COMMIT_EDITMSG'
            for message, code in (('docs: Add the flow\n', 0), ('Add the flow\n', 1), ('# Add the flow\n', 1)):
                with self.subTest(message=message):
                    path.write_text(message, encoding='utf-8')
                    result = subprocess.run([sys.executable, str(ROOT / 'scripts/check_commit_msg.py'), str(path)],
                                            capture_output=True, text=True, timeout=30)
                    self.assertEqual(result.returncode, code, result.stderr)


class PullRequestTitleWorkflowTest(unittest.TestCase):
    def test_title_reaches_the_check_through_the_environment(self):
        workflow = (ROOT / '.github/workflows/pr-title.yml').read_text()
        self.assertIn('TITLE: ${{ github.event.pull_request.title }}', workflow)
        self.assertIn('python3 scripts/check_commit_msg.py "$RUNNER_TEMP/title"', workflow)
        run = workflow.split('run: |', 1)[1]
        self.assertNotIn('${{', run)


if __name__ == '__main__':
    unittest.main()
