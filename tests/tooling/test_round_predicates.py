"""Static round SQL contracts; no application imports or database required."""
import ast
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'api' / 'app'
# Match the explicit scope of the existing API lock-mode tests, including the owner helper.
STEP_MODULES = (
    'social/owners.py', 'social/loans.py', 'loan_inventory.py', 'borrowed_copies.py',
    'loan_picks.py', 'social/inbox.py', 'social/trades.py',
    'games/pokemon/trading/trade_inventory.py', 'trade_picks.py',
)


def literal_assignment(source, name):
    matches = [node.value for node in ast.parse(source).body if isinstance(node, ast.Assign)
               and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    if len(matches) != 1 or not isinstance(matches[0], ast.Constant) or not isinstance(matches[0].value, str):
        raise AssertionError(f'expected one literal SQL assignment: {name}')
    return matches[0].value


def function_sql(source, name):
    matches = re.findall(r'CREATE OR REPLACE FUNCTION\s+' + re.escape(name)
                         + r'\b.*?\bAS\s+\$\$(.*?)\$\$;', source, re.S | re.I)
    if len(matches) != 1:
        raise AssertionError(f'expected one SQL function: {name}')
    return matches[0]


def check_latest_definitions(migrations):
    """A replacement migration needs an explicit update to the characterized sources."""
    for name in ('reserved_copies', 'reserving_picks', 'trade_reserved_copies'):
        definitions = [path for path, source in sorted(migrations.items()) if re.search(
            r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+' + re.escape(name) + r'\b', source, re.I)]
        if not definitions or definitions[-1] != '142_trade_promises.sql':
            raise AssertionError(f'latest definition of {name} is not in migration 142: {definitions}')


def between(source, start, end):
    matches = re.findall(start + r'(.*?)' + end, source, re.S | re.I)
    if len(matches) != 1:
        raise AssertionError('expected exactly one predicate region')
    return matches[0]


def sql_tokens(source):
    """Ignore whitespace, keyword case and explicit o/t aliases only; retain literals and every operator."""
    tokens = []
    position = 0
    pattern = re.compile(r"\s+|'(?:''|[^'])*'|[A-Za-z_][A-Za-z_0-9]*|<>|!=|<=|>=|[(),.=<>]")
    while position < len(source):
        match = pattern.match(source, position)
        if match is None:
            raise AssertionError(f'unsupported SQL token near {source[position:position + 20]!r}')
        token = match.group()
        if not token.isspace():
            tokens.append(token if token.startswith("'") else token.lower())
        position = match.end()
    return tuple(token for index, token in enumerate(tokens)
                 if not (token in ('o', 't') and tokens[index:index + 2] == [token, '.'])
                 and not (token == '.' and index > 0 and tokens[index - 1] in ('o', 't')))


def loan_parity(counts_source, migration106, migration142):
    python = sql_tokens(literal_assignment(counts_source, 'RESERVING'))
    found = [sql_tokens(between(function_sql(migration, 'reserved_copies'),
                               r'WHERE o\.lender_id = ANY\(owners\) AND\s+', r'\s+AND l\.promised'))
             for migration in (migration106, migration142)]
    found.append(sql_tokens(between(function_sql(migration142, 'reserving_picks'),
                                    r"AND p\.state = 'reserved'\s+AND\s+", r'\s+AND \(editions')))
    if any(predicate != python for predicate in found):
        raise AssertionError('Loan reservation predicate differs between Python and migration')
    if not python:
        raise AssertionError('empty reservation predicate')


def trade_contract(migration_source, python_source):
    # T4 is not parity with migration 142: reserving is per side, unconfirmed requires both sides.
    migration = function_sql(migration_source, 'trade_reserved_copies')
    proposer = between(migration, r'AND t\.proposer_id = ANY\(owners\)\s+AND\s+', r'\s+UNION ALL')
    recipient = between(migration, r'AND t\.recipient_id = ANY\(owners\)\s+AND\s+', r'\s+\) x WHERE')
    unconfirmed = between(literal_assignment(python_source, 'UNCONFIRMED_WITH'),
                          r'AND recipient_id IS NOT NULL\s+AND\s+', r'\s*$')
    expected = (
        "state IN ('proposed','accepted') AND proposer_swap_at IS NULL",
        "state = 'accepted' AND recipient_swap_at IS NULL",
        "state IN ('proposed','accepted') AND proposer_swap_at IS NULL AND recipient_swap_at IS NULL",
    )
    actual = tuple(map(sql_tokens, (proposer, recipient, unconfirmed)))
    if actual != tuple(map(sql_tokens, expected)) or actual[2] in actual[:2]:
        raise AssertionError('Trade predicate contract differs')


def sql_strings(source):
    tree = ast.parse(source)
    docs = {id(node.body[0].value) for node in ast.walk(tree)
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))
            and node.body and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)}
    return [node.value for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs]


def check_lock_mode(source):
    # Token matching tolerates line breaks/case. SQL literals/comments aren't executable lock clauses.
    for sql in sql_strings(source):
        sql = re.sub(r"'(?:''|[^'])*'|--[^\n]*|/\*.*?\*/", ' ', sql, flags=re.S)
        if re.search(r'\bFOR\s+UPDATE\b', sql, re.I):
            raise AssertionError('FOR UPDATE in scoped round module')


class RoundPredicates(unittest.TestCase):
    def test_compared_migration_definitions_are_still_current(self):
        migrations = {path.name: path.read_text() for path in (ROOT / 'migrations').glob('*.sql')}
        check_latest_definitions(migrations)
        for name in ('reserved_copies', 'reserving_picks', 'trade_reserved_copies'):
            with self.subTest(function=name):
                changed = {**migrations, '999_planted.sql': f'CREATE OR REPLACE FUNCTION {name}()'}
                with self.assertRaisesRegex(AssertionError, 'latest definition'):
                    check_latest_definitions(changed)

    def test_loan_reservation_parity_in_both_migrations_and_picks(self):
        loan_parity((APP / 'social/counts.py').read_text(),
                    (ROOT / 'migrations/106_loan_promises.sql').read_text(),
                    (ROOT / 'migrations/142_trade_promises.sql').read_text())

    def test_loan_parity_rejects_planted_changes_on_either_side(self):
        original = [(APP / 'social/counts.py').read_text(),
                    (ROOT / 'migrations/106_loan_promises.sql').read_text(),
                    (ROOT / 'migrations/142_trade_promises.sql').read_text()]
        for side in range(3):
            for before, after in [("'offered'", "'requested'"), ('o.lender_handover_at IS NULL', 'o.lender_handover_at IS NOT NULL'),
                                  (' AND o.lender_handover_at', ' OR o.lender_handover_at')]:
                with self.subTest(side=side, mutation=after):
                    changed = original.copy()
                    self.assertIn(before, changed[side])
                    changed[side] = changed[side].replace(before, after, 1)
                    with self.assertRaisesRegex(AssertionError, 'predicate differs'):
                        loan_parity(*changed)
        # Removing a source must fail extraction rather than make an empty comparison pass.
        with self.assertRaisesRegex(AssertionError, 'expected one SQL function'):
            loan_parity(original[0], '', original[2])
        # Mutation must also reach the independent reserving_picks definition in 142.
        picks = function_sql(original[2], 'reserving_picks')
        self.assertIn('o.lender_handover_at IS NULL', picks)
        changed_picks = picks.replace('o.lender_handover_at IS NULL', 'o.lender_handover_at IS NOT NULL', 1)
        changed142 = original[2].replace(picks, changed_picks, 1)
        with self.assertRaisesRegex(AssertionError, 'predicate differs'):
            loan_parity(original[0], original[1], changed142)

    def test_normalization_preserves_semantically_meaningful_tokens(self):
        original = "o.state IN ('offered', 'accepted') AND o.lender_handover_at IS NULL"
        self.assertEqual(sql_tokens(original), sql_tokens(original.replace('o.', '').replace(' AND ', '\n and ')))
        for changed in (original.replace(' AND ', ' OR '), original.replace('o.lender_handover_at IS NULL', 'o.lender_handover_at IS NOT NULL'),
                        original.replace("'offered'", "'requested'"), original.replace(' IN ', ' NOT IN ')):
            with self.subTest(changed=changed):
                self.assertNotEqual(sql_tokens(original), sql_tokens(changed))

    def test_trade_unconfirmed_is_distinct_from_each_sides_reservations(self):
        trade_contract((ROOT / 'migrations/142_trade_promises.sql').read_text(),
                       (APP / 'social/trades.py').read_text())

    def test_trade_contract_rejects_planted_state_null_and_operator_changes(self):
        original = [(ROOT / 'migrations/142_trade_promises.sql').read_text(),
                    (APP / 'social/trades.py').read_text()]
        for side in range(2):
            for before, after in [("'proposed'", "'closed'"),
                                  ('proposer_swap_at IS NULL', 'proposer_swap_at IS NOT NULL'),
                                  ('AND t.proposer_swap_at', 'OR t.proposer_swap_at') if side == 0 else
                                  ('AND proposer_swap_at', 'OR proposer_swap_at')]:
                with self.subTest(side=side, mutation=after):
                    changed = original.copy()
                    # For Python mutate the extracted SQL alone, avoiding unrelated earlier literals.
                    if side == 1:
                        sql = literal_assignment(changed[side], 'UNCONFIRMED_WITH')
                        self.assertIn(before, sql)
                        changed[side] = 'UNCONFIRMED_WITH = ' + repr(sql.replace(before, after, 1))
                    else:
                        self.assertIn(before, changed[side])
                        changed[side] = changed[side].replace(before, after, 1)
                    with self.assertRaisesRegex(AssertionError, 'Trade predicate contract'):
                        trade_contract(*changed)

    def test_scoped_round_modules_use_permitted_lock_modes(self):
        for name in STEP_MODULES:
            with self.subTest(module=name):
                check_lock_mode((APP / name).read_text())

    def test_lock_guard_rejects_planted_violations_in_every_scoped_module(self):
        for name in STEP_MODULES:
            for lock in ('FOR UPDATE', 'for\n update'):
                with self.subTest(module=name, lock=lock):
                    source = (APP / name).read_text() + '\nPLANTED_SQL = ' + repr('SELECT 1 ' + lock) + '\n'
                    with self.assertRaisesRegex(AssertionError, 'FOR UPDATE'):
                        check_lock_mode(source)

    def test_lock_guard_permits_no_key_update_and_ignores_documentation(self):
        check_lock_mode('"""FOR UPDATE is forbidden here."""\nSQL = "SELECT 1 FOR NO KEY UPDATE"')
        check_lock_mode('SQL = "SELECT \'FOR UPDATE\' -- FOR UPDATE\\n FOR NO KEY UPDATE"')

    def test_owner_helper_sorts_and_deduplicates_before_locking(self):
        # This pins this helper's contract only; it cannot prove ordering across round/thread writers.
        tree = ast.parse((APP / 'social/owners.py').read_text())
        helper = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'lock_owners')
        loops = [node for node in helper.body if isinstance(node, ast.For)]
        self.assertEqual(len(loops), 1)
        self.assertEqual(ast.dump(loops[0].iter), ast.dump(ast.parse('sorted(set(user_ids))', mode='eval').body))
        self.assertEqual(ast.dump(loops[0].target), ast.dump(ast.Name(id='user_id', ctx=ast.Store())))
        self.assertEqual(len(loops[0].body), 1)
        call = loops[0].body[0].value
        self.assertIsInstance(call, ast.Call)
        self.assertEqual(ast.unparse(call.func), 'conn.execute')
        self.assertEqual(ast.literal_eval(call.args[0]),
                         'SELECT 1 FROM inventory_owner WHERE user_id=%s FOR NO KEY UPDATE')
        self.assertEqual(ast.unparse(call.args[1]), '(user_id,)')


if __name__ == '__main__':
    unittest.main()
