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

    def test_event_fixture_rejects_invalid_dates_duplicate_versions_and_unsafe_metadata(self):
        path = self.root / "assets/docs/content/events/preview-events.json"
        original = json.loads(path.read_text())
        gate.validate_event_previews(self.root)
        mutations = [
            lambda rows: rows.append(dict(rows[0])),
            lambda rows: rows[0].update(startsAt="2030-02-30T05:00:00.000Z"),
            lambda rows: rows[0].update(startsAt="2030-11-03T01:00:00-04:00"),
            lambda rows: rows[0].update(endsAt=rows[0]["startsAt"]),
            lambda rows: rows[0].update(endsAt="2020-01-01T00:00:00.000Z"),
            lambda rows: rows[0].update(version=True),
            lambda rows: rows[0].update(status="current"),
            lambda rows: rows[1].update(status="replaced"),
            lambda rows: rows[0].update(fixtureCapacity=-1),
            lambda rows: rows[0].update(fixtureCapacity=True),
            lambda rows: rows[0].update(seatsRemaining=12),
            lambda rows: rows[0].update(goals=["career-admission"]),
            lambda rows: rows[0].update(domainTags=["invalid"]),
            lambda rows: rows[0].update(itRoles=["invalid"]),
            lambda rows: rows[0].update(agenda=[]),
            lambda rows: rows[0].update(title=" "),
            lambda rows: rows[0].update(id="../../escape"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                rows = json.loads(json.dumps(original))
                mutate(rows)
                path.write_text(json.dumps(rows))
                with self.assertRaises(gate.GateError):
                    gate.validate_event_previews(self.root)
        for invalid in [[], {}, [None]]:
            path.write_text(json.dumps(invalid))
            with self.assertRaises(gate.GateError):
                gate.validate_event_previews(self.root)

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
        for name in ("app/main.py", "src/hidden.js", "public/unreviewed.js", "assets/docs/application.js", "assets/docs/unreviewed.xlsx"):
            with self.subTest(name=name):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("application")
                with self.assertRaisesRegex(gate.GateError, "Outside verified"):
                    gate.validate_scope(self.root, gate.repository_files(self.root))
                path.unlink()

    def test_product_site_accepts_only_the_reviewed_static_assets(self):
        gate.validate(self.root)
        for name in ("site/extra.js", "site/tracker.html", "site/images/remote.svg"):
            with self.subTest(name=name):
                path = self.root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("unexpected site asset")
                with self.assertRaisesRegex(gate.GateError, "Outside verified"):
                    gate.validate(self.root)
                path.unlink()
        for name in (".github/workflows/product-pages.yml", "site/index.html", "site/styles.css", "site/favicon.svg"):
            with self.subTest(missing=name):
                path = self.root / name
                original = path.read_bytes()
                path.unlink()
                try:
                    with self.assertRaisesRegex(gate.GateError, "Missing file or unsupported symlink"):
                        gate.validate(self.root)
                finally:
                    path.write_bytes(original)

    def test_product_site_rejects_executable_html_and_resource_embeds(self):
        page = self.root / "site/index.html"
        original = page.read_text()
        for payload in (
            '<script src="https://example.invalid/track.js"></script>',
            '<a href="#preview" onclick="sendData()">Preview</a>',
            '<img src="https://example.invalid/pixel" alt="">',
            '<form action="https://example.invalid/collect"><input name="email"></form>',
            '<meta http-equiv="refresh" content="0;url=https://example.invalid">',
        ):
            with self.subTest(payload=payload):
                page.write_text(original.replace("</body>", payload + "</body>"))
                with self.assertRaisesRegex(gate.GateError, "Unsafe product site"):
                    gate.validate(self.root)
        page.write_text(original)

    def test_product_site_rejects_svg_script_and_css_remote_resources(self):
        icon = self.root / "site/favicon.svg"
        original_icon = icon.read_text()
        icon.write_text(original_icon.replace("</svg>", '<script>alert(1)</script></svg>'))
        with self.assertRaisesRegex(gate.GateError, "Unsafe product site"):
            gate.validate(self.root)
        icon.write_text(original_icon)
        css = self.root / "site/styles.css"
        original_css = css.read_text()
        css.write_text(original_css + '\n@import "https://example.invalid/track.css";\n')
        with self.assertRaisesRegex(gate.GateError, "Unsafe product site"):
            gate.validate(self.root)
        css.write_text(original_css)

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
        for name in ("package-lock.json", "scripts/verify-app.mjs", "scripts/check-installed-deps.mjs", "scripts/verify-full-release.mjs", "vitest.config.ts", "tests/e2e/scenarios.json", "public/member-export.js"):
            with self.subTest(name=name), self.assertRaisesRegex(gate.GateError, "Required application"):
                gate.validate_scope(self.root, [f for f in files if f != name])

    def test_application_runner_requires_fresh_successful_revision_evidence(self):
        output = self.root / "artifacts/application-verification.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text('{"stale": true}')
        with patch.object(gate, "run_application"), self.assertRaisesRegex(gate.GateError, "report missing"):
            gate.verify_application(self.root)
        metrics = {k: {"total": 100, "covered": 100, "skipped": 0} for k in ("statements", "branches", "functions", "lines")}
        report = {"exitStatus": 0, "scope": "initial-learning-v35", "revision": gate.state(self.root),
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


class PagesRevisionSelection(unittest.TestCase):
    """Execute the real pre-checkout selector; fake only the gh API transport."""

    SHA = "a" * 40
    OTHER_SHA = "b" * 40
    REPO = "deepnative/deep-native-engine"
    PREFIX = f"repos/{REPO}"
    WORKFLOW = ".github/workflows/repository-checks.yml"
    MAIN = f"{PREFIX}/commits/main"
    WORKFLOW_API = f"{PREFIX}/actions/workflows/repository-checks.yml"
    EXACT = f"{PREFIX}/actions/runs/600"
    LIST = f"{WORKFLOW_API}/runs?branch=main&event=push&status=success&head_sha={SHA}&per_page=100"

    def fixtures(self):
        identity = {"id": 7, "full_name": self.REPO}
        run = {"id": 600, "workflow_id": 42, "path": self.WORKFLOW,
               "event": "push", "head_branch": "main", "head_sha": self.SHA,
               "run_attempt": 1, "status": "completed", "conclusion": "success",
               "repository": identity, "head_repository": dict(identity)}
        return {self.MAIN: {"sha": self.SHA},
                self.WORKFLOW_API: {"id": 42, "path": self.WORKFLOW, "state": "active"},
                self.EXACT: run, self.LIST: {"total_count": 0, "workflow_runs": []}}

    def execute(self, fixtures=None, **overrides):
        import textwrap
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            workflow = (SOURCE / ".github/workflows/product-pages.yml").read_text()
            step = workflow.split("      - name: Select the verified current main revision\n", 1)[1]
            body = step.split("        run: |\n", 1)[1].split("      - name: Check out the verified revision\n", 1)[0]
            (root / "selector.sh").write_text(textwrap.dedent(body))
            (root / "fixtures.json").write_text(json.dumps(fixtures or self.fixtures()))
            # No network or real token: endpoint-specific responses, with jq support
            # only for the original selector's fail-first reproduction.
            fake = root / "gh"
            fake.write_text("#!" + sys.executable + "\n" + textwrap.dedent('''\
                import json, os, sys
                from pathlib import Path
                root = Path(os.environ["DNE_FAKE_ROOT"])
                args = sys.argv[1:]
                endpoint = next((v for v in args if v.startswith("repos/")), "unknown")
                with (root / "calls.jsonl").open("a") as out:
                    out.write(json.dumps(args) + "\\n")
                fixtures = json.loads((root / "fixtures.json").read_text())
                state_path = root / "counts.json"
                counts = json.loads(state_path.read_text()) if state_path.exists() else {}
                index = counts.get(endpoint, 0)
                counts[endpoint] = index + 1
                state_path.write_text(json.dumps(counts))
                if endpoint not in fixtures:
                    print("unexpected fake endpoint", file=sys.stderr)
                    sys.exit(9)
                value = fixtures[endpoint]
                if isinstance(value, list):
                    value = value[min(index, len(value) - 1)]
                if isinstance(value, dict) and "__error__" in value:
                    print(value["__error__"], file=sys.stderr)
                    sys.exit(1)
                if "--jq" in args:
                    query = args[args.index("--jq") + 1]
                    if query == ".sha":
                        print(value["sha"])
                    else:
                        print(len([r for r in value["workflow_runs"]
                                   if r.get("head_sha") == "a" * 40 and r.get("conclusion") == "success"]))
                else:
                    print(value if isinstance(value, str) else json.dumps(value))
            '''))
            fake.chmod(0o755)
            env = dict(os.environ)
            for key in ("GH_TOKEN", "GH_AUTH_TOKEN", "GITHUB_TOKEN"):
                env.pop(key, None)
            env.update(PATH=str(root) + os.pathsep + env["PATH"], DNE_FAKE_ROOT=str(root),
                       GH_TOKEN="synthetic-no-real-credential", GITHUB_OUTPUT=str(root / "output"),
                       DNE_REPOSITORY=self.REPO, DNE_REPOSITORY_ID="7", DNE_EVENT_SHA=self.SHA,
                       DNE_EVENT_NAME="workflow_run", DNE_EVENT_RUN_ID="600", DNE_EVENT_ATTEMPT="1")
            env.update(overrides)
            result = subprocess.run(["bash", str(root / "selector.sh")], env=env,
                                    text=True, capture_output=True, timeout=15)
            output = (root / "output").read_text() if (root / "output").exists() else ""
            calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()] if (root / "calls.jsonl").exists() else []
            return result, output, calls

    def assert_denied(self, fixtures=None, **env):
        result, output, calls = self.execute(fixtures, **env)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(output, "")
        self.assertNotIn("synthetic-private-api-response", result.stdout + result.stderr)
        self.assertNotIn("synthetic-no-real-credential", result.stdout + result.stderr)
        return calls

    def test_successful_exact_event_does_not_need_refreshed_run_list(self):
        result, output, calls = self.execute()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(output, f"sha={self.SHA}\neligible=true\n")
        self.assertTrue(any(self.EXACT in call for call in calls))
        self.assertFalse(any(self.LIST in call for call in calls))

    def test_stale_event_skips_without_reading_verification(self):
        result, output, calls = self.execute(DNE_EVENT_SHA=self.OTHER_SHA)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output, "eligible=false\n")
        self.assertEqual(len(calls), 1)

    def test_changed_main_during_verification_skips_without_emitting_sha(self):
        data = self.fixtures()
        data[self.MAIN] = [{"sha": self.SHA}, {"sha": self.OTHER_SHA}]
        result, output, _ = self.execute(data)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output, "eligible=false\n")

    def test_event_run_identity_and_result_must_all_match(self):
        import copy
        for field, value in [("id", 601), ("id", True), ("workflow_id", 43),
                             ("path", ".github/workflows/other.yml"), ("path", self.WORKFLOW + "@other"),
                             ("event", "pull_request"), ("head_branch", "feature"),
                             ("head_sha", self.OTHER_SHA), ("run_attempt", 2), ("run_attempt", True),
                             ("status", "in_progress"), ("conclusion", "failure"),
                             ("conclusion", "cancelled"), ("conclusion", "skipped"),
                             ("conclusion", "neutral"), ("conclusion", None),
                             ("repository", {"id": 8, "full_name": self.REPO}),
                             ("repository", {"id": 7, "full_name": "other/repo"}),
                             ("head_repository", {"id": 8, "full_name": "other/repo"}),
                             ("head_repository", None)]:
            with self.subTest(field=field, value=value):
                data = copy.deepcopy(self.fixtures());data[self.EXACT][field] = value
                self.assert_denied(data)
        for field in self.fixtures()[self.EXACT]:
            with self.subTest(missing=field):
                data = self.fixtures();del data[self.EXACT][field]
                self.assert_denied(data)

    def test_documented_run_path_main_ref_and_later_matching_attempt(self):
        data = self.fixtures();data[self.EXACT]["path"] += "@main"
        data[self.EXACT]["run_attempt"] = 2
        result, output, _ = self.execute(data, DNE_EVENT_ATTEMPT="2")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(output, f"sha={self.SHA}\neligible=true\n")

    def test_workflow_identity_must_resolve_to_active_expected_path(self):
        for value in [{"id": True, "path": self.WORKFLOW, "state": "active"},
                      {"id": 42, "path": ".github/workflows/other.yml", "state": "active"},
                      {"id": 42, "path": self.WORKFLOW, "state": "disabled_manually"}, {}, None]:
            with self.subTest(value=value):
                data = self.fixtures();data[self.WORKFLOW_API] = value
                self.assert_denied(data)

    def test_api_uncertainty_and_malformed_responses_fail_closed_privately(self):
        for endpoint in [self.MAIN, self.WORKFLOW_API, self.EXACT]:
            for value in [{"__error__": "synthetic-private-api-response"},
                          "synthetic-private-api-response", "null", "[]", {}]:
                with self.subTest(endpoint=endpoint, value=value):
                    data = self.fixtures();data[endpoint] = value
                    self.assert_denied(data)
        data = self.fixtures();data[self.MAIN] = [{"sha": self.SHA}, {"__error__": "synthetic-private-api-response"}]
        self.assert_denied(data)

    def test_invalid_event_metadata_never_selects_a_revision(self):
        for field, value in [("DNE_EVENT_NAME", "pull_request"), ("DNE_EVENT_RUN_ID", ""),
                             ("DNE_EVENT_RUN_ID", "600/attempts/1"), ("DNE_EVENT_ATTEMPT", "0"),
                             ("DNE_EVENT_ATTEMPT", ""), ("DNE_REPOSITORY_ID", ""),
                             ("DNE_REPOSITORY_ID", "-1"), ("DNE_REPOSITORY", "../other/repo"),
                             ("DNE_EVENT_SHA", "bad\neligible=true"), ("DNE_EVENT_SHA", "")]:
            with self.subTest(field=field, value=value):
                self.assert_denied(**{field: value})

    def test_manual_dispatch_independently_checks_exact_successful_current_run(self):
        data = self.fixtures();data[self.LIST] = {"total_count": 1, "workflow_runs": [dict(data[self.EXACT])]}
        result, output, calls = self.execute(data, DNE_EVENT_NAME="workflow_dispatch", DNE_EVENT_RUN_ID="", DNE_EVENT_ATTEMPT="")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(output, f"sha={self.SHA}\neligible=true\n")
        self.assertTrue(any(self.LIST in call for call in calls))
        self.assertTrue(any(self.EXACT in call for call in calls))
        data[self.EXACT]["conclusion"] = "failure"
        self.assert_denied(data, DNE_EVENT_NAME="workflow_dispatch")

    def test_manual_dispatch_exact_lookup_cannot_trust_only_the_list(self):
        for field, value in [("id", 601), ("run_attempt", 2), ("workflow_id", 43),
                             ("head_repository", None), ("status", "in_progress")]:
            with self.subTest(field=field):
                data = self.fixtures()
                data[self.LIST] = {"workflow_runs": [dict(data[self.EXACT])]}
                data[self.EXACT] = dict(data[self.EXACT], **{field: value})
                self.assert_denied(data, DNE_EVENT_NAME="workflow_dispatch")

    def test_manual_dispatch_missing_or_wrong_list_evidence_cannot_publish(self):
        for value in [{"total_count": 0, "workflow_runs": []}, {}, None,
                      {"workflow_runs": "wrong"}, {"workflow_runs": [{"id": 600}]},
                      {"workflow_runs": [{"id": 600, "head_sha": self.SHA, "conclusion": "success"}]},
                      {"__error__": "synthetic-private-api-response"}]:
            with self.subTest(value=value):
                data = self.fixtures();data[self.LIST] = value
                self.assert_denied(data, DNE_EVENT_NAME="workflow_dispatch")

    def test_manual_dispatch_stale_list_and_changed_main_cannot_publish(self):
        data = self.fixtures();data[self.LIST] = {"workflow_runs": [dict(data[self.EXACT], head_sha=self.OTHER_SHA)]}
        self.assert_denied(data, DNE_EVENT_NAME="workflow_dispatch")
        data = self.fixtures();data[self.LIST] = {"workflow_runs": [data[self.EXACT]]}
        data[self.MAIN] = [{"sha": self.SHA}, {"sha": self.OTHER_SHA}]
        result, output, _ = self.execute(data, DNE_EVENT_NAME="workflow_dispatch")
        self.assertEqual(result.returncode, 0)
        self.assertEqual(output, "eligible=false\n")


if __name__ == "__main__":
    unittest.main()
