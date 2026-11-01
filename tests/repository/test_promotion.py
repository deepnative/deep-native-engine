import copy
import hashlib
import io
import json
import os
import tempfile
import zipfile
from unittest.mock import patch
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("promotion", Path(__file__).resolve().parents[2] / "scripts/promote-verification.py")
promotion = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promotion)


class PromotionTests(unittest.TestCase):
    def fixture(self):
        repo = {"id": 1, "full_name": "example/engine"}
        base, head, tree, merged, synthetic = [c * 40 for c in "abcde"]
        parents = [{"sha": base}, {"sha": head}]
        revision = {"commit": synthetic, "tree": tree, "dirty": False}
        return dict(main={"sha": merged, "tree": {"sha": tree}, "parents": parents},
                    pr={"number": 5, "merged": True, "merge_commit_sha": merged,
                        "base": {"ref": "main", "repo": repo}, "head": {"sha": head, "ref": "codex/change", "repo": repo}},
                    run={"id": 10, "run_attempt": 1, "workflow_id": 2,
                         "path": ".github/workflows/repository-checks.yml", "event": "pull_request",
                         "status": "completed", "conclusion": "success", "head_sha": head,
                         "head_branch": "codex/change", "repository": repo, "head_repository": repo,
                         "pull_requests": [{"number": 5}], "run_started_at": "2026-11-01T00:00:00Z"},
                    tested={"sha": synthetic, "tree": {"sha": tree}, "parents": parents},
                    repository_report={**revision, "scope": "repository-and-initial-learning-v36", "exit_status": 0,
                                       "artifact_scan": {"status": "passed"}, "local_learning": {"cases": {"a": 1, "b": 1, "c": 1, "d": 1}}, "tests_run": 90, "skipped": 0, "failures": 0, "errors": 0, "expected_failures": 0},
                    application={"revision": revision, "scope": "initial-learning-v36", "exitStatus": 0,
                                 "commands": [{"command": name, "exitStatus": 0} for name in promotion.COMMANDS],
                                 "unitTests": {"total": 10, "passed": 10}, "integrationTests": {"total": 10, "passed": 10},
                                 "unitCoverage": {name: {"total": 100, "covered": 99, "skipped": 0} for name in ("statements", "branches", "functions", "lines")},
                                 **{name: {"total": 10, "passed": 10, "criticalPassed": 10, "criticalTotal": 10, "uncovered": [], "executions": 20} for name in ("journeys", "crossBrowserKeyboardJourney", "provisionalFullMvpEvidence")}},
                    repository=repo, workflow_id=2)

    def test_exact_pr_source_promotes_actual_merge(self):
        promotion.validate_promotion(**self.fixture())

    def test_github_may_clear_pull_request_list_after_merge(self):
        fixture = self.fixture()
        fixture["run"]["pull_requests"] = []
        promotion.validate_promotion(**fixture)

    def test_untrusted_or_incomplete_proof_fails_closed(self):
        changes = [
            ("main", "tree", {"sha": "f" * 40}),
            ("run", "event", "workflow_dispatch"),
            ("run", "conclusion", "failure"),
            ("run", "head_sha", "f" * 40),
            ("run", "workflow_id", 9),
            ("run", "path", ".github/workflows/other.yml"),
            ("run", "head_repository", {"id": 9, "full_name": "fork/engine"}),
            ("run", "pull_requests", [{"number": 99}]),
            ("pr", "merged", False),
            ("pr", "merge_commit_sha", "f" * 40),
            ("tested", "parents", [{"sha": "f" * 40}, {"sha": "b" * 40}]),
            ("repository_report", "dirty", True),
            ("repository_report", "exit_status", 1),
            ("repository_report", "skipped", 1),
            ("application", "exitStatus", 1),
            ("application", "commands", []),
            ("application", "unitTests", {}),
            ("application", "unitCoverage", {}),
            ("application", "journeys", {}),
            ("repository_report", "artifact_scan", {}),
            ("application", "revision", {"commit": "f" * 40, "tree": "c" * 40, "dirty": False}),
        ]
        for section, field, value in changes:
            with self.subTest(section=section, field=field):
                fixture = copy.deepcopy(self.fixture())
                fixture[section][field] = value
                with self.assertRaises(ValueError):
                    promotion.validate_promotion(**fixture)

    def archive(self, fixture):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as archive:
            for name, section in [("repository-verification.json", "repository_report"), ("application-verification.json", "application")]:
                archive.writestr(name, json.dumps(fixture[section]))
        data = stream.getvalue()
        return data, "sha256:" + hashlib.sha256(data).hexdigest()

    def test_provider_digest_and_exact_report_inventory_required(self):
        archive, digest = self.archive(self.fixture())
        self.assertEqual(promotion.read_proof(archive, digest)[1], self.fixture()["application"])
        with self.assertRaises(ValueError):
            promotion.read_proof(archive + b"altered", digest)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as files:
            files.writestr("../repository-verification.json", "{}")
        data = stream.getvalue()
        with self.assertRaises(ValueError):
            promotion.read_proof(data, "sha256:" + hashlib.sha256(data).hexdigest())

    def test_actual_api_promotion_keeps_original_provenance_and_rechecks_main(self):
        fixture = self.fixture()
        archive, digest = self.archive(fixture)
        prefix = "repos/example/engine"
        sha = fixture["main"]["sha"]
        responses = {
            prefix: fixture["repository"],
            prefix + "/commits/main": {"sha": sha},
            prefix + f"/git/commits/{sha}": fixture["main"],
            prefix + f"/commits/{sha}/pulls?per_page=100": [{**fixture["pr"], "merged_at": "2026-11-01T01:00:00Z"}],
            prefix + "/pulls/5": fixture["pr"],
            prefix + "/actions/workflows/repository-checks.yml": {"id": 2, "path": promotion.WORKFLOW, "state": "active"},
            prefix + f'/actions/workflows/2/runs?event=pull_request&head_sha={fixture["pr"]["head"]["sha"]}&status=success&per_page=100': {"workflow_runs": [fixture["run"]]},
            prefix + "/actions/runs/10": fixture["run"],
            prefix + "/actions/runs/10/artifacts?per_page=100": {"artifacts": [{"id": 20, "name": "verified-source", "expired": False, "size_in_bytes": len(archive), "created_at": "2026-11-01T00:30:00Z", "digest": digest}]},
            prefix + "/actions/artifacts/20/zip": archive,
            prefix + f'/git/commits/{fixture["tested"]["sha"]}': fixture["tested"],
        }
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, GITHUB_REPOSITORY="example/engine", GITHUB_REPOSITORY_ID="1", GITHUB_SHA=sha), patch.object(promotion, "api", side_effect=lambda endpoint, **kwargs: responses[endpoint]) as api, patch.object(promotion, "Path", side_effect=lambda name: Path(root) / name):
            promotion.promote()
            output = json.loads((Path(root) / "artifacts/main-promotion.json").read_text())
            self.assertEqual(output["original_run"], 10)
            self.assertEqual(output["artifact_digest"], digest)
            self.assertEqual(sum(call.args[0] == prefix + "/commits/main" for call in api.call_args_list), 2)
