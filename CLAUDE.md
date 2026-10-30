@AGENTS.md

## Usual flow

Work moves ticket → feature branch → pull request to `dev` → release pull request to `main`.

1. **Ticket.** Start from a GitHub Issue on `ry-cen/prizecheck` (`gh issue view <n>`). Read `CONTEXT.md` and any ADR the work touches; use its terms in code, tests and copy.
2. **Branch.** Branch from the `dev` tip as `feature/<slug>`, `fix/<slug>` or `docs/<slug>`. Parallel or isolated work goes in a worktree at `.claude/worktrees/<name>`; it gets its own `node_modules` and `.venv` (`docs/agents/local-testing.md`), never an install through a symlink to this checkout's, which would change them while gates may be running here.
3. **Build and check.** Iterate on the narrow loops in `docs/agents/verification.md`: the API tests and browser specs the change adds or touches, plus `npm run check` and `npm run guardrails`. `TEST_ADMIN_DATABASE_URL` comes from `.claude/settings.local.json`; check it with `[ -n "$TEST_ADMIN_DATABASE_URL" ]` and keep its value out of output. Without it, `npm run verify:local` supplies a disposable per-worktree server; run `python3 scripts/local_test_db.py doctor` first in a new worktree ([docs/agents/local-testing.md](docs/agents/local-testing.md)). Run one full or fast gate at a time per host.
4. **Commit.** Stage named paths only (`git add <file>`), then confirm with `git diff --cached --stat`; other sessions share this checkout and `.scratch/`. The pre-commit hook runs Prettier, the type and generated-client checks and the guardrails. Write the subject as `<type>: <sentence>`, the sentence saying in plain words what changed for the collector and why, with an optional lowercase scope such as `fix(scanner): …`. The commit-msg hook (`scripts/check_commit_msg.py`) rejects any other subject; it lets through the `fixup!`, `squash!`, `amend!` and `Revert "` subjects git writes itself. The type is one of:
   - `feat`: new or changed behaviour a collector or the owner can see
   - `fix`: a bug fix
   - `perf`: faster or lighter, same behaviour
   - `refactor`: restructured code, same behaviour
   - `test`: tests or the verification harness only
   - `docs`: documentation, specs, ADRs and planning only
   - `ci`: GitHub workflows and deploy pipelines
   - `chore`: dependencies, tooling and config

   Commit messages and PR bodies carry no Claude attribution trailer or "Generated with" line.

5. **Pull request to `dev`.** Rebase onto the `dev` tip; history stays linear, with no merge commits. After a rebase, `git push --force-with-lease` the feature branch; `dev` and `main` are never force-pushed. The title follows the commit subject format, since the squash merge makes it the commit on `dev`; the `PR title` workflow checks it with the same script. The body opens with `Fixes #N.` and "The issue stays open until the release to `main`.", then **Cause.** and **Fix.** sections, then the checks run with their counts. The PR is accepted on the green `verify` check plus those narrow runs. Start the full test workflow (`gh workflow run verify.yml --ref <branch> -f integration=sharded`) only when the owner asks for it or the code change is large enough to warrant it, such as a broad refactor or a change across many subsystems. A small or medium change does not warrant it, even when it crosses suites or the narrow runs can't run locally.
6. **Land.** The owner approves commits, pushes, PRs and merges. Feature PRs squash into `dev`, and tickets stay open there.
7. **Release.** When the owner authorizes one, open a "chore: release dev to main: …" PR from `dev` to `main` naming the commit range, what ships and the host steps prod needs; collect the feature PRs' `Fixes #N` lines into its body so the tickets close when `main` moves. Pushing `main` deploys prod (`docs/deployment-oracle.md`, `docs/operations/release.md`).
8. **Clean up.** Remove each worktree you created once its branch is merged or abandoned: `git worktree remove <path>`, delete the branch, `git worktree prune`. Leave worktrees owned by another running agent.
