"""Behavioral regression tests for source integrity and the push gate."""

import importlib.util
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("repo_gate", SOURCE / "scripts/repo.py")
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class RepositoryFixture(unittest.TestCase):
    def setUp(self):
        isolated_env = dict(os.environ)
        for key in ("GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG", "GIT_CONFIG_COUNT"):
            isolated_env.pop(key, None)
        isolated_env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
        env_patch = patch.dict(os.environ, isolated_env, clear=True)
        env_patch.start()
        self.addCleanup(env_patch.stop)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for name in gate.repository_files(SOURCE):
            source = SOURCE / name
            if source.is_file():
                target = self.root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)
        # Avoid a user's global hook or signing settings in these isolated fixtures.
        gate.git(self.root, "config", "core.hooksPath", ".githooks")
        gate.git(self.root, "config", "commit.gpgsign", "false")
        # These disposable repositories must not outlive cleanup through detached Git jobs.
        gate.git(self.root, "config", "maintenance.auto", "false")
        gate.git(self.root, "config", "user.name", "Repository Gate Test")
        gate.git(self.root, "config", "user.email", "test@example.invalid")
        gate.git(self.root, "add", ".")
        gate.git(self.root, "commit", "-qm", "fixture")

    def change_json(self, name, mutate):
        path = self.root / gate.CONTEXT / name
        data = json.loads(path.read_text())
        mutate(data)
        path.write_text(json.dumps(data))

    def push_line(self, sha=None):
        return f"refs/heads/test {sha or gate.git(self.root, 'rev-parse', 'HEAD')} refs/heads/test {'0' * 40}\n"

    def test_complete_fixture_validates(self):
        gate.validate(self.root)

    def test_fixture_commits_do_not_start_background_maintenance(self):
        trace = self.root / "artifacts/git-trace.jsonl"
        trace.parent.mkdir(exist_ok=True)
        env = dict(os.environ, GIT_TRACE2_EVENT=str(trace))
        subprocess.run(["git", "-C", str(self.root), "commit", "--allow-empty", "-qm", "probe"],
                       env=env, check=True)
        events = [json.loads(line) for line in trace.read_text().splitlines()]
        children = [event.get("argv", []) for event in events if event.get("event") == "child_start"]
        self.assertFalse(any("maintenance" in argv or "gc" in argv for argv in children), children)

    def test_archive_corruption_is_detected(self):
        path = self.root / gate.ARCHIVE / "outputs/contractor-platform/00-START-HERE.md"
        path.write_text(path.read_text() + "\nchanged")
        with self.assertRaisesRegex(gate.GateError, "checksum"):
            gate.validate_archive(self.root)

    def test_archive_missing_and_extra_files_fail(self):
        path = self.root / gate.ARCHIVE / "extra.txt"
        path.write_text("unexpected")
        with self.assertRaisesRegex(gate.GateError, "inventory"):
            gate.validate_archive(self.root)
        path.unlink()
        (self.root / gate.ARCHIVE / "outputs/contractor-platform/00-START-HERE.md").unlink()
        with self.assertRaisesRegex(gate.GateError, "Missing source"):
            gate.validate_archive(self.root)

    def test_archive_path_traversal_fails(self):
        self.change_json("source-manifest.json", lambda d: d["files"][0].update(path="../../outside"))
        with self.assertRaisesRegex(gate.GateError, "Unsafe"):
            gate.validate_archive(self.root)

    def test_archive_symlink_fails(self):
        path = self.root / gate.ARCHIVE / "outputs/contractor-platform/00-START-HERE.md"
        path.unlink()
        path.symlink_to(self.root / "README.md")
        with self.assertRaises(gate.GateError):
            gate.validate_archive(self.root)

    def test_unmeasured_application_source_fails_scope(self):
        for name in ("app/main.py", "src/hidden.js", "assets/docs/application.js", "assets/docs/unreviewed.xlsx"):
            with self.subTest(name=name):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("application")
                with self.assertRaisesRegex(gate.GateError, "Outside verified"):
                    gate.validate_scope(self.root, gate.repository_files(self.root))
                path.unlink()

    def test_plan_workbook_is_narrowly_allowed_and_rejects_external_relationships(self):
        workbook = self.root / gate.PLAN_WORKBOOK
        self.assertTrue(workbook.is_file())
        gate.validate_scope(self.root, gate.repository_files(self.root))
        gate.validate_capacity_workbook(self.root)
        with zipfile.ZipFile(workbook, "a") as archive:
            archive.writestr("xl/_rels/extra.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" TargetMode="External" Target="https://example.invalid"/></Relationships>')
        with self.assertRaisesRegex(gate.GateError, "External relationship"):
            gate.validate_capacity_workbook(self.root)

    def test_removing_application_gate_files_blocks_verification(self):
        files = gate.repository_files(self.root)
        for name in ("package-lock.json", "scripts/verify-app.mjs", "vitest.config.ts", "tests/e2e/scenarios.json"):
            with self.subTest(name=name), self.assertRaisesRegex(gate.GateError, "Required application"):
                gate.validate_scope(self.root, [f for f in files if f != name])

    def test_application_runner_requires_fresh_successful_revision_evidence(self):
        output = self.root / "artifacts/application-verification.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text('{"stale": true}')
        with patch.object(gate, "run_application"), self.assertRaisesRegex(gate.GateError, "report missing"):
            gate.verify_application(self.root)
        metrics = {k: {"total": 100, "covered": 100, "skipped": 0} for k in ("statements", "branches", "functions", "lines")}
        report = {"exitStatus": 0, "scope": "initial-learning-v4", "revision": gate.state(self.root),
                  "unitTests": {"passed": 1, "total": 1}, "integrationTests": {"passed": 1, "total": 1},
                  "unitCoverage": metrics, "journeys": {"passed": 1, "total": 1, "criticalPassed": 1, "criticalTotal": 1}}
        def write_report(*args, **kwargs):
            output.write_text(json.dumps(report))
        with patch.object(gate, "run_application", side_effect=write_report):
            self.assertEqual(gate.verify_application(self.root), report)
            report["revision"]["commit"] = "a" * 40
            with self.assertRaisesRegex(gate.GateError, "revision changed"):
                gate.verify_application(self.root)
            report["revision"] = gate.state(self.root)
            report["unitCoverage"]["branches"]["covered"] = 98
            with self.assertRaisesRegex(gate.GateError, "threshold failed"):
                gate.verify_application(self.root)

    def test_missing_setup_and_symlink_fail_scope(self):
        files = gate.repository_files(self.root)
        with self.assertRaisesRegex(gate.GateError, "Required setup"):
            gate.validate_scope(self.root, [f for f in files if f != "Makefile"])
        readme = self.root / "README.md"
        readme.unlink()
        readme.symlink_to(self.root / "AGENTS.md")
        with self.assertRaisesRegex(gate.GateError, "symlink"):
            gate.validate_scope(self.root, files)

    def test_unknown_dependency_and_cycle_fail(self):
        path = self.root / gate.CONTEXT / "issues.json"
        original = path.read_text()
        for dependency in ("MISSING-001", "ROADMAP"):
            with self.subTest(dependency=dependency):
                path.write_text(original)
                self.change_json("issues.json", lambda d: d["issues"][0].update(deps=[dependency]))
                with self.assertRaisesRegex(gate.GateError, "dependency|cycle"):
                    gate.validate_planning(self.root)

    def test_duplicate_ids_fail(self):
        self.change_json("issues.json", lambda d: d["issues"][1].update(id=d["issues"][0]["id"]))
        with self.assertRaisesRegex(gate.GateError, "unique"):
            gate.validate_planning(self.root)

    def test_model_label_mismatch_fails(self):
        self.change_json("model-recommendations.json", lambda d: d["issues"][0].update(labels=["model:gpt-5.6-sol"]))
        with self.assertRaisesRegex(gate.GateError, "Model labels"):
            gate.validate_planning(self.root)

    def test_unsupported_model_effort_fails(self):
        self.change_json("model-recommendations.json", lambda d: d["issues"][0].update(reasoning="none"))
        with self.assertRaisesRegex(gate.GateError, "Unexpected reasoning effort"):
            gate.validate_planning(self.root)

    def test_missing_acceptance_definition_fails(self):
        (self.root / gate.CONTEXT / "issue-bodies/ROADMAP.md").write_text("# No criteria")
        with self.assertRaisesRegex(gate.GateError, "AC/DoD"):
            gate.validate_planning(self.root)

    def test_role_permission_expansion_fails(self):
        path = self.root / ".codex/agents/dne-reviewer.toml"
        path.write_text(path.read_text().replace('"read-only"', '"workspace-write"'))
        with self.assertRaisesRegex(gate.GateError, "boundary"):
            gate.validate_agents_skills(self.root)

    def test_skill_discovery_and_invocation_failures(self):
        path = self.root / ".agents/skills/dne-handoff/agents/openai.yaml"
        path.write_text(path.read_text().replace("$dne-handoff", "a generic task"))
        with self.assertRaisesRegex(gate.GateError, "invoke"):
            gate.validate_agents_skills(self.root)

    def test_broken_local_links_fail_but_external_links_are_not_fetched(self):
        path = self.root / "README.md"
        path.write_text("[external](https://example.invalid/test) [anchor](#section)")
        gate.validate_links(self.root, ["README.md"])
        path.write_text("[missing](assets/docs/does-not-exist.md)")
        with self.assertRaisesRegex(gate.GateError, "Broken local link"):
            gate.validate_links(self.root, ["README.md"])

    def test_local_link_cannot_escape_repository(self):
        (self.root / "README.md").write_text("[outside](../)")
        with self.assertRaisesRegex(gate.GateError, "Broken local link"):
            gate.validate_links(self.root, ["README.md"])

    def test_bootstrap_is_idempotent(self):
        gate.bootstrap(self.root)
        gate.bootstrap(self.root)
        self.assertEqual(gate.git(self.root, "config", "--get", "core.hooksPath"), ".githooks")
        self.assertTrue(os.access(self.root / ".githooks/pre-push", os.X_OK))

    def test_bootstrap_preserves_foreign_hook_configuration(self):
        gate.git(self.root, "config", "core.hooksPath", "team-hooks")
        with self.assertRaisesRegex(gate.GateError, "conflicts"):
            gate.bootstrap(self.root)
        self.assertEqual(gate.git(self.root, "config", "--get", "core.hooksPath"), "team-hooks")

    def test_bootstrap_preserves_existing_active_hook(self):
        gate.git(self.root, "config", "--unset", "core.hooksPath")
        old_hook = self.root / ".git/hooks/pre-push"
        old_hook.write_text("#!/bin/sh\nexit 0\n")
        old_hook.chmod(0o755)
        with self.assertRaisesRegex(gate.GateError, "Existing active"):
            gate.bootstrap(self.root)
        self.assertEqual(old_hook.read_text(), "#!/bin/sh\nexit 0\n")

    def test_bootstrap_preserves_explicitly_disabled_hooks(self):
        gate.git(self.root, "config", "core.hooksPath", "")
        with self.assertRaisesRegex(gate.GateError, "conflicts"):
            gate.bootstrap(self.root)

    def test_clean_exact_revision_push_is_eligible(self):
        self.assertTrue(gate.validate_push(self.root, self.push_line()))

    def test_tracked_and_untracked_changes_block_push(self):
        for name in ("README.md", "new-file.txt"):
            with self.subTest(name=name):
                path = self.root / name
                previous = path.read_bytes() if path.exists() else None
                path.write_text("uncommitted")
                with self.assertRaisesRegex(gate.GateError, "clean checkout"):
                    gate.validate_push(self.root, self.push_line())
                if previous is None:
                    path.unlink()
                else:
                    path.write_bytes(previous)

    def test_other_ref_in_same_push_blocks_wrong_revision(self):
        with self.assertRaisesRegex(gate.GateError, "checked-out HEAD"):
            gate.validate_push(self.root, self.push_line() + self.push_line("a" * 40))

    def test_deletion_only_and_empty_push_have_no_code_to_test(self):
        self.assertFalse(gate.validate_push(self.root, self.push_line("0" * 40)))
        self.assertFalse(gate.validate_push(self.root, ""))

    def test_malformed_push_fails(self):
        for line in ("bad", "branch not-a-sha remote zero"):
            with self.subTest(line=line), self.assertRaisesRegex(gate.GateError, "Malformed"):
                gate.validate_push(self.root, line)

    def test_failed_verification_blocks_push(self):
        with patch.object(gate, "verify", return_value=1), self.assertRaisesRegex(gate.GateError, "verification failed"):
            gate.pre_push(self.root, self.push_line())

    def test_change_during_verification_blocks_push(self):
        def modifies_checkout(root):
            (root / "README.md").write_text("changed while testing")
            return 0
        with patch.object(gate, "verify", side_effect=modifies_checkout), self.assertRaisesRegex(gate.GateError, "changed during"):
            gate.pre_push(self.root, self.push_line())

    def test_successful_verification_allows_push(self):
        with patch.object(gate, "verify", return_value=0) as verify:
            self.assertEqual(gate.pre_push(self.root, self.push_line()), 0)
            verify.assert_called_once_with(self.root)

    def test_failed_report_is_explicit_and_does_not_invent_app_coverage(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), patch.object(gate, "validate", side_effect=gate.GateError("fixture failure")):
            self.assertEqual(gate.verify(self.root), 1)
        report = json.loads((self.root / "artifacts/repository-verification.json").read_text())
        self.assertEqual(report["exit_status"], 1)
        self.assertEqual(report["application_status"], "not-verified")
        self.assertIsNone(report["application_unit_coverage"])
        self.assertIsNone(report["application_e2e_journey_coverage"])

    def test_empty_test_collection_cannot_pass(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), patch.object(
                gate.unittest.defaultTestLoader, "discover", return_value=unittest.TestSuite()):
            self.assertEqual(gate.verify(self.root), 1)
        report = json.loads((self.root / "artifacts/repository-verification.json").read_text())
        self.assertIn("No repository tests", report["error"])

    def test_skipped_and_expected_failure_tests_cannot_pass(self):
        class IncompleteTests(unittest.TestCase):
            @unittest.skip("not implemented")
            def test_skipped(self):
                pass

            @unittest.expectedFailure
            def test_expected_failure(self):
                self.fail("known failure")

        for method in ("test_skipped", "test_expected_failure"):
            with self.subTest(method=method):
                suite = unittest.TestSuite([IncompleteTests(method)])
                with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()), patch.object(
                        gate.unittest.defaultTestLoader, "discover", return_value=suite):
                    self.assertEqual(gate.verify(self.root), 1)


if __name__ == "__main__":
    unittest.main()
