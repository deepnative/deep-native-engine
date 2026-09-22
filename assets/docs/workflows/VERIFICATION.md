# Verification contract

## Reproduce the complete check

Prerequisites: Git, GNU Make, Python 3.11+ (CI uses 3.12), Node 24 at the version in `.nvmrc`, npm, and Docker with Compose and a running daemon. On macOS Docker Desktop or a running Colima VM works. Linux browser installation may request system-package privileges. Native Windows is not tested; use WSL with Docker.

```sh
make setup
make verify
make dev
```

Open `http://127.0.0.1:3000`. `make setup` installs the local hook, runs `npm ci`, starts the digest-pinned PostgreSQL 18 image on loopback port 54329, installs Chromium and its OS dependencies, and copies `.env.example` only if `.env` is absent. No provider credentials are needed. The published database password is a local disposable fixture. Never reuse it for hosting. Startup applies the idempotent migrations and listens on loopback only. `DNE_DATABASE_URL`, `DNE_PORT`, `DNE_APP_MODE` and optional per-adapter mode variables configure the preview; dotenv is read by the Node start commands. Demo mode requires the local development database; verification starts the compiled server in test mode against its random isolated database.

`make bootstrap` refuses a conflicting hook path or active foreign pre-push hook. Repeating it is safe. In worktrees the local Git config may be shared; the relative `.githooks` path resolves within each worktree. `make db` restarts the local database. `npm run build && npm start` runs compiled output. Stop the app with Ctrl-C; `docker compose stop` preserves data. For an intentional deletion of **all local preview data**, stop the app and run `docker compose down --volumes`; then `make db` creates an empty database. Do not use a reset to conceal a test failure.

## One gate locally, before push and in CI

`make verify` executes:

1. Repository scope, immutable 25-file archive, 55 planning IDs, dependencies, model routing, skill/agent definitions and local links; regression tests include missing application gates and stale/wrong revision evidence.
2. Locked-tool formatting, ESLint and TypeScript checks.
3. Vitest behavioral unit tests and V8 coverage of **all `src/**/*.ts`**, including unimported files, views, adapters and startup. Require >=99% statements, branches, functions and lines globally and per file, checked from raw counts. No executable application exclusions. SQL is declarative and exercised against PostgreSQL; CSS is checked and rendered in browser tests. Tests, tooling and generated `dist/` are outside the application coverage denominator and have separate behavioral checks.
4. Isolated negative probes proving that unimported source and a deliberately broken CSRF comparison fail.
5. Production TypeScript build, PostgreSQL integration tests and the complete desktop/mobile Chromium browser matrix against the compiled server and real database. Each run creates its own random `dne_test_<32-hex>` database and drops only that database in `finally`. Test helpers refuse other database names. Nothing truncates the development database.
6. Exact scenario mapping to [initial-learning-v3](../../../tests/e2e/scenarios.json): >=99% approved slice journeys, 100% critical journeys and executed tests. All projects must pass for a journey to count. Missing/empty reports, skips, expected failures, focused tests, retries, duplicate/unmapped scenarios and reduced preserved full-MVP inventory fail. Twenty-seven outstanding full-MVP requirements remain separate; this gate does not claim the whole MVP.
7. Runtime dependency audit (`npm audit --omit=dev --audit-level=high`). This requires network access; unavailable audit data fails the gate. It does not replace source/security review.

Reports in ignored `artifacts/` include repository/application revision and tree, dirty state, runtime/environment, commands, raw unit counts, unit/integration assertions, browser mapping, failure traces and probe results. Each run replaces previous authoritative reports; repository status becomes verified only after fresh application evidence matches its revision. No report from a failed run constitutes a pass. CI uploads evidence for 14 days using synthetic fixtures only.

A dirty working-tree run is useful during editing but is not evidence for a later commit. Commit first, then rerun `make verify`. The pre-push hook requires a clean checkout and every non-deletion pushed ref to equal HEAD, runs the complete gate again and rejects changes made during verification. No `--no-verify`, threshold reductions, silent exclusions or retry-only passes.

CI runs the same `make verify` on Linux and macOS for PRs and pushes to `main` and `codex/**`. Linux uses the pinned PostgreSQL container; macOS starts an isolated PostgreSQL 18 Homebrew cluster bound to loopback with trust authentication only inside the ephemeral CI runner. Both use Node 24 and Chromium. PR CI verifies GitHub's merge candidate; record its SHA separately from the branch. Local hooks are not repository protection. Required-check rules must refer to real executed job names and require owner authorization to change repository settings.

## Review and merge evidence

Follow [the team workflow](TEAM-WORKFLOW.md). Independent review must inspect the actual diff and reports. Before merging, verify current head/base, required reviews and successful CI; guard the merge with expected head SHA. Then verify the `main` workflow for the resulting merge commit and safely fast-forward local main. A green PR does not prove post-merge main, deployment or commercial readiness.

## Recovery

Fix failures, then regenerate evidence on the changed revision. Preserve archive hashes; never regenerate the manifest to hide corruption. Extend scope validation and coverage together when adding an executable source type. Resolve hook conflicts deliberately. If the database is unavailable, start it with `make db`; do not skip integration/E2E. Failed test-database cleanup is a gate failure and records the problem. Refresh stale browser forms after restarting the app. See the [slice decision record](../INITIAL-LEARNING-SLICE.md) for privacy, retention, migration and release limitations.
