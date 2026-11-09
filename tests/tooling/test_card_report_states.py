"""Check report status vocabularies against their SQL constraints without importing the API."""
import ast
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
FLOWS = (
    ("catalog/missing_cards.py", "007_missing_card_reports.sql", "missing_card_report"),
    ("prices/metadata_reviews.py", "023_metadata_review.sql", "catalog_metadata_report"),
    ("catalog/attribute_corrections.py", "033_card_attribute_corrections.sql", "catalog_attribute_report"),
)


def constants(path):
    """Read only string/tuple assignments and references to earlier constants."""
    values = {}

    def value(node):
        if isinstance(node, ast.Name):
            return values[node.id]
        if isinstance(node, ast.Tuple):
            return tuple(value(item) for item in node.elts)
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
            return value(node.left) + value(node.right)
        return ast.literal_eval(node)

    for node in ast.parse(path.read_text()).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try:
                values[node.targets[0].id] = value(node.value)
            except (ValueError, KeyError):
                pass
    return values


class CardReportStatesTest(unittest.TestCase):
    def test_each_status_vocabulary_matches_its_migration_check(self):
        for module, migration, table in FLOWS:
            with self.subTest(module=module):
                sql = (ROOT / "migrations" / migration).read_text()
                body = re.search(r"CREATE TABLE " + table + r"\s*\((.*?)\n\);", sql, re.S).group(1)
                check = re.search(r"CHECK\s*\(status IN \(([^)]*)\)\)", body).group(1)
                checked = tuple(re.findall(r"'([^']+)'", check))
                states = constants(ROOT / "api/app/games/pokemon" / module)
                self.assertEqual(states["STATUSES"], checked)
                self.assertEqual(states["OPEN"], (states["PENDING"], states["NEEDS_INFO"]))
                self.assertEqual(set(states["CLOSED"]), set(checked) - set(states["OPEN"]))
                for status in checked:
                    self.assertEqual(states[status.upper()], status)


if __name__ == "__main__":
    unittest.main()
