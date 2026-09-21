# Verification contract

## Reproduce the repository check

Use Git, GNU Make, and Python 3.11+ (CI uses 3.12). All verifier dependencies are in the Python standard library. On Windows use a POSIX checkout such as WSL; native Windows hook behavior is not tested.

```sh
make bootstrap
make verify
```

Bootstrap configures `core.hooksPath=.githooks` in the local repository only and makes `pre-push` executable. It refuses a different configured hook path or an existing active `.git/hooks/pre-push`; integrate the checks into the existing team policy deliberately instead of overwriting it. Repeating bootstrap is safe. In Git worktrees, repository-local Git config may be shared; the relative path resolves within each worktree, which must contain this setup before pushing.

`make verify` runs the complete setup gate:

1. Validate allowed planning/tooling file scope, source archive hashes/size/inventory, planning IDs/dependencies/model mapping, local Markdown link targets, skill metadata and named agent TOML.
2. Run repository regression tests, including negative fixtures for corrupt archives, incomplete metadata, unexpected application code, and incorrect pre-push revisions.
3. Write `artifacts/repository-verification.json` with revision/tree, dirty state, Python/platform, exact command, exit status, and scope. The report is ignored by Git. The gate needs no network or GitHub credentials.

A local check may pass on uncommitted changes during editing; its report explicitly records that state. Such a report is not evidence for a later commit. Commit first, then rerun the command before pushing. The hook requires a clean checkout, including non-ignored untracked files, and every non-deletion pushed ref to point to HEAD. It rejects pushing another checkout's commit or a tag/object it cannot verify as HEAD. A deletion-only push has no code to validate. GitHub protection should separately control destructive remote operations.

CI runs the same command on Linux and macOS for pull requests and pushes to `main` and `codex/**`. It runs without secrets and with read-only repository permission. PR CI validates GitHub's merge candidate, which may differ from local HEAD. It prints the report in the job log. Local hooks can be removed, so required CI and review remain necessary; bootstrap changes no repository protection settings.

## Current scope and application transition

Passing means planning assets and repository tooling are consistent. Application status is `not-implemented`; unit/E2E metrics are `null`, never 100%. Historical scripts/workbook evidence are archived data and are never executed by verification.

Before the first application push, explicitly authorize implementation and complete the applicable QA-001/002/003 slice. Replace the setup-only file restriction with real application checks in the **same** entry point. Add locked bootstrap dependencies, formatting/lint, type checks, unit/integration tests, production build, relevant security checks, and the approved complete browser matrix. Test bootstrap/harness code with behavioral fixtures before relying on it. Document runtime versions, deterministic provider boundaries, database isolation, and reproducible startup.

Enforce the [quality gates](../context/QUALITY-GATES.md): >=99% unit lines, statements, branches, functions globally and per module including unimported source; >=99% approved E2E journeys; 100% critical journeys and required test passes. Pin the versioned scenario denominator, include unimplemented scenarios for the release, and report slice/full-MVP scope separately. Fail on missing reports, zero collected tests, empty denominators, skips, quarantine, failures, and retry-only success. Review every source exclusion.

## Failure recovery

- Checksum failure: restore preserved source and inspect the diff; do not regenerate the manifest to hide corruption.
- Scope failure: unexpected application/configuration files need the application test gate, or a reviewed setup-tool extension with regression tests. Never merely ignore failing paths.
- Metadata/link failure: fix the maintained file, leaving historical source unchanged.
- Hook conflict: inspect current Git hooks and integrate by review. Do not erase another team's hooks.
- Dirty/wrong-revision push: check out and commit the intended state, rerun verification, then retry. Do not bypass the hook.
- Test/CI failure: reproduce the error, fix it, and regenerate evidence. Missing coverage or provider access is an explicit gap, not a passed check.
