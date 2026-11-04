"""Behavioral tests for per-stage gate and deploy timing records (#630)."""

import hashlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("pipeline_timings", SOURCE / "scripts/pipeline_timings.py")
timings = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(timings)


def write(directory, name, value):
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


def gate_artifacts(directory, *, finished=True, failed=False):
    """Invented artifacts shaped like a real gate run."""
    write(directory, "repository-verification.json", {
        "commit": "a" * 40, "tree": "b" * 40, "dirty": False,
        "timestamp_utc": "2026-11-03T16:00:00+00:00",
        "exit_status": 1 if failed else 0,
        **({"error": "Repository verification failed during application verification."} if failed else {}),
        "stage_timings": [
            {"stage": "repository assets", "started": "2026-11-03T16:00:00+00:00", "finished": "2026-11-03T16:00:05+00:00"},
            {"stage": "repository tests", "started": "2026-11-03T16:00:05+00:00", "finished": "2026-11-03T16:00:45+00:00"},
            {"stage": "application verification", "started": "2026-11-03T16:00:45+00:00", "finished": "2026-11-03T16:20:45+00:00"},
        ] + ([] if failed else [
            {"stage": "local learning verification", "started": "2026-11-03T16:20:45+00:00", "finished": "2026-11-03T16:21:45+00:00"},
            {"stage": "artifact scan", "started": "2026-11-03T16:21:45+00:00", "finished": "2026-11-03T16:21:50+00:00"},
        ]),
    })
    commands = [
        ("npm run test:unit", "2026-11-03T16:01:00.000Z", "2026-11-03T16:02:00.000Z"),
        ("npm run test:integration", "2026-11-03T16:03:00.000Z", "2026-11-03T16:11:00.000Z"),
        ("npm run test:e2e", "2026-11-03T16:11:30.000Z", "2026-11-03T16:18:30.000Z"),
    ]
    write(directory, "application-verification.json", {
        "startedAt": "2026-11-03T16:00:46.000Z", "finishedAt": "2026-11-03T16:20:40.000Z",
        "exitStatus": 1 if failed else 0,
        "commands": [{"command": c, "start": s, **({"finished": f} if finished else {}), "exitStatus": 0}
                     for c, s, f in commands],
    })
    write(directory, "integration-shards.json", {"lanes": [
        {"index": 1, "started": "2026-11-03T16:03:01.000Z", "finished": "2026-11-03T16:06:01.000Z"},
        {"index": 2, "started": "2026-11-03T16:03:01.000Z", "finished": "2026-11-03T16:10:59.000Z"},
    ]})
    write(directory, "browser-shards.json", {"started": "2026-11-03T16:11:30.000Z", "finished": "2026-11-03T16:18:30.000Z", "lanes": [
        {"exitStatus": 0, "started": "2026-11-03T16:11:40.000Z", "finished": "2026-11-03T16:14:40.000Z"},
        {"exitStatus": 0, "started": "2026-11-03T16:11:40.000Z", "finished": "2026-11-03T16:17:40.000Z"},
    ]})


DEPLOY_RUN = {
    "databaseId": 41674463237, "headSha": "d70e5b1" + "0" * 33, "event": "workflow_dispatch",
    "conclusion": "success", "createdAt": "2026-11-03T16:27:55Z", "updatedAt": "2026-11-03T16:30:49Z",
    "jobs": [{"name": "deploy", "startedAt": "2026-11-03T16:28:01Z", "completedAt": "2026-11-03T16:30:48Z", "steps": [
        {"name": "Set up job", "startedAt": "2026-11-03T16:28:02Z", "completedAt": "2026-11-03T16:28:03Z", "conclusion": "success"},
        {"name": "Build and push the app and proxy images", "startedAt": "2026-11-03T16:28:13Z", "completedAt": "2026-11-03T16:29:33Z", "conclusion": "success"},
        {"name": "Wait for the revision and public availability", "startedAt": "2026-11-03T16:29:36Z", "completedAt": "2026-11-03T16:30:38Z", "conclusion": "success"},
    ]}],
}


class Fixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.artifacts = self.root / "artifacts"

    def stages(self, record):
        return {row["stage"]: row for row in record["stages"]}


class GateTimings(Fixture):
    def test_time01_lists_every_stage_with_duration_and_lane_spread(self):
        gate_artifacts(self.artifacts)
        record = timings.gate_record(self.artifacts)
        stages = self.stages(record)
        self.assertEqual(record["kind"], "gate")
        self.assertEqual(record["revision"], "a" * 40)
        self.assertEqual(record["status"], "passed")
        self.assertEqual(record["seconds"], 1310)
        self.assertEqual(stages["repository tests"]["seconds"], 40)
        self.assertEqual(stages["npm run test:integration"], {
            "stage": "npm run test:integration", "parent": "application verification",
            "seconds": 480, "approximate": False})
        self.assertEqual(record["lanes"]["integration"], [180, 478])
        self.assertEqual(record["lanes"]["browser"], [180, 360])
        text = timings.format_record(record)
        self.assertIn("npm run test:e2e", text)
        self.assertIn("8m00s", text)
        self.assertIn("integration lanes (2): fastest 3m00s, slowest 7m58s (lane 2)", text)
        slowest = text[text.index("Slowest:"):]
        self.assertLess(slowest.index("npm run test:integration"), slowest.index("npm run test:e2e"))

    def test_time02_derives_old_command_times_from_the_next_start_and_marks_them(self):
        gate_artifacts(self.artifacts, finished=False)
        stages = self.stages(timings.gate_record(self.artifacts))
        self.assertEqual(stages["npm run test:unit"]["seconds"], 120)
        self.assertTrue(stages["npm run test:unit"]["approximate"])
        self.assertEqual(stages["npm run test:e2e"]["seconds"], 550)
        self.assertIn("~", timings.format_record(timings.gate_record(self.artifacts)))

    def test_time04_failed_gate_keeps_timings_up_to_the_failed_stage(self):
        gate_artifacts(self.artifacts, failed=True)
        record = timings.gate_record(self.artifacts)
        self.assertEqual(record["status"], "failed")
        self.assertEqual(record["failed_stage"], "application verification")
        self.assertEqual(self.stages(record)["application verification"]["seconds"], 1200)
        self.assertNotIn("artifact scan", self.stages(record))

    def test_missing_artifacts_produce_a_partial_record_not_a_crash(self):
        self.artifacts.mkdir()
        record = timings.gate_record(self.artifacts)
        self.assertEqual(record["stages"], [])
        self.assertEqual(record["status"], "unknown")


class DeployTimings(Fixture):
    def test_time03_lists_queue_time_and_every_step(self):
        record = timings.deploy_record(DEPLOY_RUN)
        self.assertEqual(record["kind"], "deploy")
        self.assertEqual(record["run"], 41674463237)
        self.assertEqual(record["seconds"], 174)
        stages = self.stages(record)
        self.assertEqual(stages["queue"]["seconds"], 6)
        self.assertEqual(stages["Build and push the app and proxy images"]["seconds"], 80)
        self.assertEqual(stages["Wait for the revision and public availability"]["seconds"], 62)
        self.assertIn("Build and push the app and proxy images", timings.format_record(record))

    def test_deploy_command_reads_the_run_through_gh(self):
        completed = subprocess.CompletedProcess([], 0, stdout=json.dumps(DEPLOY_RUN))
        with patch.object(timings.subprocess, "run", return_value=completed) as run, redirect_stdout(io.StringIO()) as out:
            self.assertEqual(timings.main(["deploy", "41674463237"], root=self.root), 0)
        self.assertEqual(run.call_args.args[0][:4], ["gh", "run", "view", "41674463237"])
        self.assertIn("1m20s", out.getvalue())

    def test_deploy_command_rejects_a_non_numeric_run_id(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(timings.main(["deploy", "--repo=x"], root=self.root), 2)


class History(Fixture):
    def init_git(self):
        subprocess.run(["git", "init", "-q", str(self.root)], check=True)

    def test_time05_recording_writes_only_outside_artifacts(self):
        self.init_git()
        gate_artifacts(self.artifacts)
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.artifacts.rglob("*") if p.is_file()}
        with redirect_stdout(io.StringIO()):
            self.assertEqual(timings.main(["gate", "--record"], root=self.root), 0)
        after = {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in self.artifacts.rglob("*") if p.is_file()}
        self.assertEqual(before, after)
        history = self.root / ".git" / timings.HISTORY_NAME
        rows = [json.loads(line) for line in history.read_text().splitlines()]
        self.assertEqual([row["kind"] for row in rows], ["gate"])
        self.assertEqual(rows[0]["revision"], "a" * 40)

    def test_history_lists_recorded_runs_newest_last(self):
        self.init_git()
        gate_artifacts(self.artifacts)
        timings.append_history(self.root, timings.gate_record(self.artifacts))
        timings.append_history(self.root, timings.deploy_record(DEPLOY_RUN))
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(timings.main(["history"], root=self.root), 0)
        lines = out.getvalue().strip().splitlines()
        self.assertIn("gate", lines[-2])
        self.assertIn("21m50s", lines[-2])
        self.assertIn("deploy", lines[-1])
        self.assertIn("2m54s", lines[-1])

    def test_record_after_gate_never_raises(self):
        with redirect_stdout(io.StringIO()) as out:
            timings.record_after_gate(self.root / "missing")
        self.assertIn("Timing summary unavailable", out.getvalue())


class IntegrationDurations(Fixture):
    def results(self, run_root):
        write(self.artifacts, "repository-verification.json", {"commit": "c" * 40})
        write(self.artifacts, "integration-results.json", {"testResults": [
            {"name": f"{run_root}/tests/integration/slow.test.ts", "startTime": 1000, "endTime": 240450},
            {"name": f"{run_root}/tests/integration/fast.test.ts", "startTime": 5000, "endTime": 5040},
        ]})

    def test_lane_bal05_refresh_writes_every_file_with_its_seconds(self):
        # The run may come from another worktree; only the repository-relative path is kept.
        self.results("/elsewhere/tests/integration/../worktree")
        with redirect_stdout(io.StringIO()) as out:
            self.assertEqual(timings.main(["durations", str(self.artifacts)], root=self.root), 0)
        register = json.loads((self.root / "tests/integration/durations.json").read_text())
        self.assertEqual(register, {
            "schema": "integration-durations-v1", "source": "c" * 40,
            "files": {"tests/integration/fast.test.ts": 0.0, "tests/integration/slow.test.ts": 239.4},
        })
        self.assertIn("2 integration files", out.getvalue())

    def test_lane_bal05_refresh_refuses_missing_or_empty_results(self):
        self.artifacts.mkdir()
        with redirect_stdout(io.StringIO()):
            self.assertEqual(timings.main(["durations", str(self.artifacts)], root=self.root), 1)
        self.assertFalse((self.root / "tests/integration/durations.json").exists())


class Formatting(unittest.TestCase):
    def test_durations(self):
        self.assertEqual(timings.duration(5), "0m05s")
        self.assertEqual(timings.duration(3725), "62m05s")

    def test_usage_errors(self):
        with redirect_stdout(io.StringIO()):
            self.assertEqual(timings.main([], root=Path(os.devnull)), 2)
            self.assertEqual(timings.main(["nope"], root=Path(os.devnull)), 2)


if __name__ == "__main__":
    unittest.main()
