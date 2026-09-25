"""Behavioral regression tests for source integrity and the push gate."""

import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
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

    def test_untrusted_exceptions_never_reach_console_or_report(self):
        marker = "synthetic-private-exception"

        class UnprintableError(Exception):
            def __str__(self):
                raise AssertionError("Exception must not be inspected")

        errors = [OSError(marker), ValueError(marker), KeyError(marker),
                  subprocess.CalledProcessError(7, [marker]), gate.GateError(marker),
                  RuntimeError(marker), UnprintableError()]
        for error in errors:
            with self.subTest(kind=type(error).__name__):
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(gate, "validate", side_effect=error):
                    self.assertEqual(gate.verify(self.root), 1)
                text = (self.root / "artifacts/repository-verification.json").read_text()
                self.assertNotIn(marker, text + stdout.getvalue() + stderr.getvalue())
                report = json.loads(text)
                self.assertEqual(report["error"], "Repository verification failed during repository assets.")
                self.assertEqual(report["exit_status"], 1)
                self.assertEqual(report["application_status"], "not-verified")
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(gate, "main", side_effect=error):
                    self.assertEqual(gate.run_cli(), 1)
                self.assertNotIn(marker, stdout.getvalue() + stderr.getvalue())
                self.assertIn("Repository command failed", stderr.getvalue())

    def test_untrusted_paths_links_and_metadata_have_safe_diagnostics(self):
        marker = "synthetic-private-value"
        readme = self.root / "README.md"
        original = readme.read_text()
        plan_path = self.root / gate.CONTEXT / "issues.json"
        original_plan = plan_path.read_text()
        unexpected = self.root / f"{marker}.txt"
        for kind, expected in [("path", "Outside verified"), ("link", "Broken local link"),
                               ("dependency", "Unknown dependency")]:
            with self.subTest(kind=kind):
                unexpected.unlink(missing_ok=True)
                readme.write_text(original)
                plan_path.write_text(original_plan)
                if kind == "path":
                    unexpected.write_text("synthetic fixture")
                elif kind == "link":
                    readme.write_text(original + f"\n[broken]({marker})\n")
                else:
                    plan = json.loads(original_plan)
                    plan["issues"][0]["deps"].append(marker)
                    plan_path.write_text(json.dumps(plan))
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    self.assertEqual(gate.verify(self.root), 1)
                text = (self.root / "artifacts/repository-verification.json").read_text()
                self.assertIn(expected, text)
                self.assertIn("ref-sha256:", text)
                self.assertNotIn(marker, text + stdout.getvalue() + stderr.getvalue())
                unexpected.unlink(missing_ok=True)
                readme.write_text(original)
                plan_path.write_text(original_plan)

    def test_source_marker_diagnostic_does_not_expose_private_filename(self):
        private_name = "synthetic-private-filename"
        credential = "ghp_" + "D" * 36
        (self.root / "src" / f"{private_name}.ts").write_text(f"// {credential}\n")
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(gate.verify(self.root), 1)
        text = (self.root / "artifacts/repository-verification.json").read_text()
        for marker in (private_name, credential):
            self.assertNotIn(marker, text + stdout.getvalue() + stderr.getvalue())
        self.assertIn("github-token", text)
        self.assertIn("ref-sha256:", text)

    def test_cli_unknown_command_does_not_echo_untrusted_argument(self):
        marker = "synthetic-private-argument"
        result = subprocess.run([sys.executable, "scripts/repo.py", marker],
                                cwd=self.root, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Unknown command", result.stderr)
        self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertNotIn("Traceback", result.stderr)

    def test_cli_git_failure_does_not_echo_private_path(self):
        marker = "synthetic-private-git-path"
        env = dict(os.environ, GIT_DIR=str(self.root / marker))
        result = subprocess.run([sys.executable, "scripts/repo.py", "verify"],
                                cwd=self.root, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        text = (self.root / "artifacts/repository-verification.json").read_text()
        self.assertNotIn(marker, text + result.stdout + result.stderr)
        self.assertIn("revision identification", text)
        self.assertNotIn("Traceback", result.stderr)

    def test_report_write_failure_is_safe_and_cannot_pass(self):
        marker = "synthetic-private-filesystem-error"
        for earlier_failure in (True, False):
            with self.subTest(earlier_failure=earlier_failure):
                stdout, stderr = io.StringIO(), io.StringIO()
                suite = unittest.TestSuite([unittest.FunctionTestCase(lambda: None)])
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(
                        gate, "validate", side_effect=ValueError(marker) if earlier_failure else None), patch.object(
                        gate.unittest.defaultTestLoader, "discover", return_value=suite), patch.object(
                        gate, "verify_application", return_value={"unitCoverage": {}, "journeys": {}}), patch.object(
                        gate, "scan_artifacts", return_value={"status": "passed"}), patch.object(
                        Path, "write_text", side_effect=OSError(marker)):
                    self.assertEqual(gate.verify(self.root), 1)
                self.assertIn("Repository verification report could not be written.", stderr.getvalue())
                self.assertNotIn(marker, stdout.getvalue() + stderr.getvalue())
                self.assertNotIn("PASS", stdout.getvalue())

    def test_source_credential_marker_fails_without_echoing_value(self):
        marker = "ghp_" + "A" * 36
        source = self.root / "src/session.ts"
        source.write_text(source.read_text() + f"\n// {marker}\n")
        with self.assertRaises(gate.GateError) as caught:
            gate.validate(self.root)
        self.assertIn("github-token", str(caught.exception))
        self.assertIn("ref-sha256:96998a2148aa", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(gate.verify(self.root), 1)
        report = (self.root / "artifacts/repository-verification.json").read_text()
        self.assertIn("github-token", report)
        self.assertNotIn(marker, report + stdout.getvalue() + stderr.getvalue())

    def test_untracked_private_key_marker_fails_without_echoing_value(self):
        marker = "-----BEGIN " + "PRIVATE KEY-----"
        source = self.root / "src/new-adapter.ts"
        source.write_text(f"// {marker}\n")
        with self.assertRaises(gate.GateError) as caught:
            gate.validate(self.root)
        self.assertIn("private-key", str(caught.exception))
        self.assertIn("ref-sha256:", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))

    def test_generated_artifact_marker_blocks_safe_upload(self):
        marker = "ghp_" + "B" * 36
        artifact = self.root / "artifacts/failure-trace.log"
        artifact.parent.mkdir(exist_ok=True)
        artifact.write_text(f"Provider failed: {marker}\n")
        result = subprocess.run(
            [sys.executable, "scripts/repo.py", "scan-artifacts"],
            cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("credential candidate", result.stderr)
        self.assertIn("ref-sha256:", result.stderr)
        self.assertNotIn(marker, result.stdout + result.stderr)

    def test_compressed_trace_marker_blocks_artifact_publication(self):
        marker = "ghp_" + "Z" * 36
        private_entry = "synthetic-private-member-note.txt"
        artifact = self.root / "artifacts/browser-results/trace.zip"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(private_entry, f"Synthetic private note: {marker}\n")
        result = subprocess.run(
            [sys.executable, "scripts/repo.py", "scan-artifacts"],
            cwd=self.root, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("credential candidate", result.stderr)
        self.assertIn("ref-sha256:", result.stderr)
        self.assertNotIn(marker, result.stdout + result.stderr)
        self.assertNotIn(private_entry, result.stdout + result.stderr)
        workflow = (self.root / ".github/workflows/repository-checks.yml").read_text()
        self.assertIn("steps.artifact_scan.outcome == 'success'", workflow)

    def test_zip_scan_accepts_safe_trace_and_catches_boundary_spanning_marker(self):
        artifact = self.root / "artifacts/browser-results/trace.zip"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("trace.events", "Synthetic browser actions only.")
        result = gate.scan_artifacts(self.root)
        self.assertEqual(result["files_scanned"], 1)
        self.assertEqual(result["archive_entries_scanned"], 1)
        marker = "ghp_" + "Y" * 36
        with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("trace.events", b"A" * (64 * 1024 - 2) + b" " + marker.encode())
        with self.assertRaises(gate.GateError) as caught:
            gate.scan_artifacts(self.root)
        self.assertIn("credential candidate", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))

    def test_zip_scan_denies_unsafe_entries_and_nested_archives(self):
        artifact = self.root / "artifacts/browser-results/trace.zip"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        link = zipfile.ZipInfo("private-link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for name, payload, expected in [
            ("../synthetic-private-path.txt", b"safe", "Unsafe ZIP entry path"),
            ("C:/synthetic-private-path.txt", b"safe", "Unsafe ZIP entry path"),
            (link, b"target", "Unsafe ZIP entry type"),
            ("nested.zip", b"safe", "Nested archive is unsupported"),
            ("hidden.txt", b"PK\x03\x04nested", "Nested archive is unsupported"),
            ("hidden.txt", b"\x1f\x8bnested", "Nested archive is unsupported"),
        ]:
            with self.subTest(expected=expected, name=str(name)):
                with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                    archive.writestr(name, payload)
                with self.assertRaises(gate.GateError) as caught:
                    gate.scan_artifacts(self.root)
                self.assertIn(expected, str(caught.exception))
                self.assertNotIn("synthetic-private-path", str(caught.exception))

    def test_zip_scan_denies_malformed_encrypted_and_corrupt_traces(self):
        artifact = self.root / "artifacts/browser-results/trace.zip"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        artifact.write_bytes(b"not a ZIP archive")
        with self.assertRaisesRegex(gate.GateError, "Unreadable ZIP artifact"):
            gate.scan_artifacts(self.root)
        with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.writestr("trace.events", b"ordinary synthetic trace")
        original = artifact.read_bytes()
        encrypted = bytearray(original)
        local = encrypted.index(b"PK\x03\x04")
        central = encrypted.index(b"PK\x01\x02")
        encrypted[local + 6] |= 1
        encrypted[central + 8] |= 1
        artifact.write_bytes(encrypted)
        with self.assertRaisesRegex(gate.GateError, "Encrypted ZIP entry"):
            gate.scan_artifacts(self.root)
        corrupt = original.replace(b"ordinary synthetic trace", b"ordinary synthetic tracE", 1)
        artifact.write_bytes(corrupt)
        with self.assertRaisesRegex(gate.GateError, "Unreadable ZIP artifact"):
            gate.scan_artifacts(self.root)

    def test_zip_scan_denies_unsupported_archive_formats(self):
        artifact = self.root / "artifacts/browser-results/trace.zip"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_BZIP2) as archive:
            archive.writestr("trace.events", b"ordinary synthetic trace")
        with self.assertRaisesRegex(gate.GateError, "Unsupported ZIP compression"):
            gate.scan_artifacts(self.root)
        artifact.unlink()
        nested = self.root / "artifacts/browser-results/trace.gz"
        nested.write_bytes(b"\x1f\x8bsynthetic compressed payload")
        with self.assertRaisesRegex(gate.GateError, "Unsupported compressed artifact"):
            gate.scan_artifacts(self.root)
        nested.unlink()
        disguised = self.root / "artifacts/browser-results/trace.log"
        disguised.write_bytes(b"\x1f\x8bsynthetic compressed payload")
        with self.assertRaisesRegex(gate.GateError, "Unsupported compressed artifact"):
            gate.scan_artifacts(self.root)
        marker = "ghp_" + "Q" * 36
        with zipfile.ZipFile(disguised, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("hidden.events", marker)
        with self.assertRaises(gate.GateError) as caught:
            gate.scan_artifacts(self.root)
        self.assertIn("credential candidate", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))

    def test_zip_scan_enforces_member_total_and_entry_count_limits(self):
        artifact = self.root / "artifacts/browser-results/trace.zip"
        artifact.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(artifact, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("trace-one.events", b"12345")
            archive.writestr("trace-two.events", b"12345")
        for limit, value, expected in [
            ("MAX_ZIP_MEMBER_BYTES", 4, "ZIP entry exceeds size limit"),
            ("MAX_ZIP_TOTAL_BYTES", 9, "ZIP artifact exceeds expanded size limit"),
            ("MAX_ZIP_MEMBERS", 1, "ZIP central directory exceeds supported bounds"),
            ("MAX_ZIP_CENTRAL_BYTES", 1, "ZIP central directory exceeds supported bounds"),
            ("MAX_ARTIFACT_BYTES", 1, "Verification artifact exceeds size limit"),
        ]:
            with self.subTest(limit=limit), patch.object(gate, limit, value):
                with self.assertRaisesRegex(gate.GateError, expected):
                    gate.scan_artifacts(self.root)

    def test_artifact_scan_keeps_safe_failure_traces_and_rejects_unsafe_files(self):
        with self.assertRaisesRegex(gate.GateError, "artifacts missing"):
            gate.scan_artifacts(self.root)
        artifact = self.root / "artifacts/failure-trace.log"
        artifact.parent.mkdir(exist_ok=True)
        artifact.write_text("Synthetic assertion failed; no private value.\n")
        self.assertEqual(gate.scan_artifacts(self.root)["files_scanned"], 1)
        artifact.unlink()
        artifact.symlink_to(self.root / "src/session.ts")
        with self.assertRaisesRegex(gate.GateError, "symlink is unsafe"):
            gate.scan_artifacts(self.root)

    def test_artifact_filename_marker_is_not_disclosed(self):
        marker = "ghp_" + "C" * 36
        artifact = self.root / "artifacts" / f"{marker}.log"
        artifact.parent.mkdir(exist_ok=True)
        artifact.write_text("safe content\n")
        with self.assertRaises(gate.GateError) as caught:
            gate.scan_artifacts(self.root)
        self.assertIn("ref-sha256:", str(caught.exception))
        self.assertNotIn(marker, str(caught.exception))

    def test_ci_artifact_display_and_upload_require_safe_scan(self):
        workflow = (self.root / ".github/workflows/repository-checks.yml").read_text()
        self.assertLess(workflow.index("id: artifact_scan"), workflow.index("name: Show verification evidence"))
        self.assertLess(workflow.index("id: artifact_scan"), workflow.index("name: Preserve verification reports"))
        self.assertEqual(workflow.count("steps.artifact_scan.outcome == 'success'"), 2)

    def test_local_circle_capacity_change_requires_reviewed_gate_update(self):
        path = self.root / "assets/docs/content/circles/preview-circles.json"
        circles = json.loads(path.read_text())
        circles[0]["capacity"] = 16
        path.write_text(json.dumps(circles))
        with self.assertRaisesRegex(gate.GateError, "Invalid local circle metadata or capacity"):
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
        for name in ("package-lock.json", "scripts/verify-app.mjs", "scripts/check-installed-deps.mjs", "scripts/verify-full-release.mjs", "vitest.config.ts", "tests/e2e/scenarios.json"):
            with self.subTest(name=name), self.assertRaisesRegex(gate.GateError, "Required application"):
                gate.validate_scope(self.root, [f for f in files if f != name])

    def test_application_runner_requires_fresh_successful_revision_evidence(self):
        output = self.root / "artifacts/application-verification.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text('{"stale": true}')
        with patch.object(gate, "run_application"), self.assertRaisesRegex(gate.GateError, "report missing"):
            gate.verify_application(self.root)
        metrics = {k: {"total": 100, "covered": 100, "skipped": 0} for k in ("statements", "branches", "functions", "lines")}
        report = {"exitStatus": 0, "scope": "initial-learning-v28", "revision": gate.state(self.root),
                  "commands": [{"command": "node scripts/check-installed-deps.mjs", "exitStatus": 0}],
                  "unitTests": {"passed": 1, "total": 1}, "integrationTests": {"passed": 1, "total": 1},
                  "unitCoverage": metrics, "journeys": {"passed": 1, "total": 1, "criticalPassed": 1, "criticalTotal": 1}}
        def write_report(*args, **kwargs):
            output.write_text(json.dumps(report))
        with patch.object(gate, "run_application", side_effect=write_report):
            report["commands"] = []
            with self.assertRaisesRegex(gate.GateError, "dependency prerequisite"):
                gate.verify_application(self.root)
            report["commands"] = [{"command": "node scripts/check-installed-deps.mjs", "exitStatus": 0}]
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

    def test_repository_test_output_stays_private_on_pass_and_failure(self):
        marker = "synthetic-private-repository-test-output"

        def passing_test():
            print(marker)

        def failing_test():
            print(marker)
            raise AssertionError(marker)

        for test, expected_status in ((passing_test, 0), (failing_test, 1)):
            with self.subTest(test=test.__name__):
                suite = unittest.TestSuite([unittest.FunctionTestCase(test)])
                stdout, stderr = io.StringIO(), io.StringIO()
                with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(
                        gate.unittest.defaultTestLoader, "discover", return_value=suite), patch.object(
                        gate, "verify_application", return_value={"unitCoverage": {}, "journeys": {}}), patch.object(
                        gate, "scan_artifacts", return_value={"status": "passed"}):
                    self.assertEqual(gate.verify(self.root), expected_status)
                report = (self.root / "artifacts/repository-verification.json").read_text()
                self.assertNotIn(marker, report + stdout.getvalue() + stderr.getvalue())
                self.assertIn("Repository tests:", stdout.getvalue())
                if expected_status:
                    self.assertIn("Repository tests failed", report)

    def test_application_launcher_does_not_inherit_child_output(self):
        marker = "synthetic-private-application-child-output"
        bin_dir = self.root / "fake-bin"
        bin_dir.mkdir()
        npm = bin_dir / "npm"
        npm.write_text(f"#!/bin/sh\nprintf '{marker}\\n'\nprintf '{marker}\\n' >&2\nexit 7\n")
        npm.chmod(0o755)
        env = dict(os.environ, PATH=str(bin_dir) + os.pathsep + os.environ["PATH"])
        probe = subprocess.run(
            [sys.executable, "-c", "from pathlib import Path; import subprocess; "
             "from scripts.repo import run_application; "
             "\ntry: run_application(Path.cwd())\nexcept subprocess.CalledProcessError: print('failed')"],
            cwd=self.root, env=env, capture_output=True, text=True,
        )
        self.assertEqual(probe.returncode, 0)
        self.assertIn("failed", probe.stdout)
        self.assertNotIn(marker, probe.stdout + probe.stderr)

    def test_repository_output_boundary_contains_native_child_and_restores_console(self):
        marker = "synthetic-private-native-child-output"
        with tempfile.TemporaryFile(mode="w+") as captured:
            stdout_fd, stderr_fd = os.dup(1), os.dup(2)
            try:
                os.dup2(captured.fileno(), 1)
                os.dup2(captured.fileno(), 2)
                with gate.private_test_output():
                    subprocess.run([sys.executable, "-c", f"print('{marker}')"], check=True)
                os.write(1, b"console-restored\n")
            finally:
                os.dup2(stdout_fd, 1)
                os.dup2(stderr_fd, 2)
                os.close(stdout_fd)
                os.close(stderr_fd)
            captured.seek(0)
            result = captured.read()
        self.assertNotIn(marker, result)
        self.assertIn("console-restored", result)


if __name__ == "__main__":
    unittest.main()
