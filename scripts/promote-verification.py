#!/usr/bin/env python3
"""Promote only the original successful PR proof for the identical merged tree."""
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

WORKFLOW = ".github/workflows/repository-checks.yml"
COMMANDS = ["node scripts/check-installed-deps.mjs", *[f"npm run {name}" for name in
            ("format:check", "lint", "typecheck", "test:unit")],
            "node scripts/gate-probes.mjs", *[f"npm run {name}" for name in
            ("build", "test:integration", "test:e2e", "test:e2e:cross-browser", "test:e2e:provisional")],
            "npm audit --omit=dev --audit-level=high"]


def require(value):
    if not value:
        raise ValueError("Original PR verification does not match the merged source")


def same_repository(value, expected):
    return isinstance(value, dict) and value.get("id") == expected["id"] and value.get("full_name") == expected["full_name"]


def validate_promotion(main, pr, run, tested, repository_report, application, repository, workflow_id):
    require(pr.get("merged") is True and pr.get("merge_commit_sha") == main["sha"] and
            pr["base"]["ref"] == "main" and same_repository(pr["base"]["repo"], repository) and
            same_repository(pr["head"]["repo"], repository))
    require(run.get("status") == "completed" and run.get("conclusion") == "success" and
            run.get("event") == "pull_request" and run.get("workflow_id") == workflow_id and
            run.get("path") in (WORKFLOW, WORKFLOW + "@refs/pull/" + str(pr["number"]) + "/merge") and
            run.get("head_sha") == pr["head"]["sha"] and run.get("head_branch") == pr["head"]["ref"] and
            same_repository(run.get("repository"), repository) and same_repository(run.get("head_repository"), repository) and
            (not run.get("pull_requests") or any(item.get("number") == pr["number"] for item in run["pull_requests"])))
    parents = [value["sha"] for value in main["parents"]]
    require(len(parents) == 2 and parents[1] == pr["head"]["sha"] and
            [value["sha"] for value in tested["parents"]] == parents and tested["tree"]["sha"] == main["tree"]["sha"])
    revision = {"commit": tested["sha"], "tree": main["tree"]["sha"], "dirty": False}
    require(all(repository_report.get(key) == value for key, value in revision.items()) and
            application.get("revision") == revision)
    require(repository_report.get("scope") == "repository-and-initial-learning-v36" and
            repository_report.get("exit_status") == 0 and repository_report.get("tests_run", 0) > 0 and
            all(repository_report.get(key) == 0 for key in ("skipped", "failures", "errors", "expected_failures")))
    require(application.get("scope") == "initial-learning-v36" and application.get("exitStatus") == 0 and
            [row.get("command") for row in application.get("commands", [])] == COMMANDS and
            all(row.get("exitStatus") == 0 for row in application["commands"]))
    for name in ("unitTests", "integrationTests"):
        counts = application.get(name, {})
        require(counts.get("total", 0) > 0 and counts.get("passed") == counts["total"])
    for metric in ("statements", "branches", "functions", "lines"):
        counts = application.get("unitCoverage", {}).get(metric, {})
        require(counts.get("total", 0) > 0 and counts.get("skipped") == 0 and
                counts.get("covered", -1) / counts["total"] >= 0.99)
    for name in ("journeys", "crossBrowserKeyboardJourney", "provisionalFullMvpEvidence"):
        counts = application.get(name, {})
        require(counts.get("total", 0) > 0 and counts.get("passed") == counts["total"] and
                counts.get("criticalPassed") == counts.get("criticalTotal") and counts.get("uncovered") == [] and
                counts.get("executions", 0) > 0)
    require(repository_report.get("artifact_scan", {}).get("status") == "passed" and
            all(value > 0 for value in repository_report.get("local_learning", {}).get("cases", {}).values()) and
            len(repository_report.get("local_learning", {}).get("cases", {})) == 4)


def read_proof(archive, digest):
    require("sha256:" + hashlib.sha256(archive).hexdigest() == digest)
    with zipfile.ZipFile(io.BytesIO(archive)) as files:
        require(sorted(files.namelist()) == ["application-verification.json", "repository-verification.json"] and
                sum(info.file_size for info in files.infolist()) < 10_000_000)
        return (json.loads(files.read("repository-verification.json")),
                json.loads(files.read("application-verification.json")))


def api(endpoint, binary=False):
    result = subprocess.run(["gh", "api", "--method", "GET", endpoint], check=True, capture_output=True, timeout=60)
    return result.stdout if binary else json.loads(result.stdout)


def promote():
    repository_name = os.environ["GITHUB_REPOSITORY"]
    sha = os.environ["GITHUB_SHA"]
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository_name) and re.fullmatch(r"[0-9a-f]{40}", sha))
    prefix = f"repos/{repository_name}"
    repository = api(prefix)
    require(str(repository["id"]) == os.environ["GITHUB_REPOSITORY_ID"])
    require(api(prefix + "/commits/main")["sha"] == sha)
    main = api(prefix + f"/git/commits/{sha}")
    prs = api(prefix + f"/commits/{sha}/pulls?per_page=100")
    prs = [pr for pr in prs if pr.get("merged_at") and pr.get("merge_commit_sha") == sha and pr["base"]["ref"] == "main"]
    require(len(prs) == 1)
    pr = api(prefix + f'/pulls/{prs[0]["number"]}')
    workflow = api(prefix + "/actions/workflows/repository-checks.yml")
    require(workflow["path"] == WORKFLOW and workflow["state"] == "active")
    runs = api(prefix + f'/actions/workflows/{workflow["id"]}/runs?event=pull_request&head_sha={pr["head"]["sha"]}&status=success&per_page=100')["workflow_runs"]
    for candidate in runs:
        run = api(prefix + f'/actions/runs/{candidate["id"]}')
        if run.get("event") != "pull_request" or run.get("conclusion") != "success":
            continue
        artifacts = api(prefix + f'/actions/runs/{run["id"]}/artifacts?per_page=100')["artifacts"]
        proofs = [artifact for artifact in artifacts if artifact["name"] == "verified-source" and not artifact["expired"]]
        if len(proofs) != 1:
            continue
        artifact = proofs[0]
        require(0 < artifact["size_in_bytes"] < 10_000_000 and
                artifact["created_at"] >= run["run_started_at"])
        archive = api(prefix + f'/actions/artifacts/{artifact["id"]}/zip', binary=True)
        repo_report, app = read_proof(archive, artifact["digest"])
        tested_sha = app.get("revision", {}).get("commit", "")
        require(re.fullmatch(r"[0-9a-f]{40}", tested_sha))
        tested = api(prefix + f"/git/commits/{tested_sha}")
        validate_promotion(main, pr, run, tested, repo_report, app, repository, workflow["id"])
        # A rerun or a concurrent main update cannot inherit this observation.
        fresh = api(prefix + f'/actions/runs/{run["id"]}')
        require(fresh["run_attempt"] == run["run_attempt"] and fresh["conclusion"] == "success" and
                fresh["status"] == "completed" and api(prefix + "/commits/main")["sha"] == sha)
        output = {"schema": "verified-source-promotion-v1", "commit": sha, "tree": main["tree"]["sha"],
                  "pull_request": pr["number"], "original_run": run["id"], "original_attempt": run["run_attempt"],
                  "tested_commit": tested_sha, "artifact_id": artifact["id"], "artifact_digest": artifact["digest"], "exit_status": 0}
        Path("artifacts").mkdir(exist_ok=True)
        Path("artifacts/main-promotion.json").write_text(json.dumps(output, indent=2) + "\n")
        print("Current main promotes the identical source from original successful PR verification.")
        return
    raise ValueError("No eligible original PR proof")


if __name__ == "__main__":
    try:
        promote()
    except Exception:
        raise SystemExit("Main promotion failed closed; inspect original PR proof and merge identity.")
