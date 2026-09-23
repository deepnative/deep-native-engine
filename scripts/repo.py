#!/usr/bin/env python3
"""Shared repository and initial learning application verification gate."""

import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tomllib
import unittest
import zipfile
from xml.etree import ElementTree
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = Path("assets/docs/context")
ARCHIVE = CONTEXT / "source-2026-09-15"
PLAN_WORKBOOK = Path("assets/docs/PLAN-003-CAPACITY-MODEL.xlsx")
ROLES = {
    "dne-planner": ("gpt-6-astra", "read-only"),
    "dne-builder": ("gpt-6-sol", "workspace-write"),
    "dne-critical-builder": ("gpt-6-astra", "workspace-write"),
    "dne-reviewer": ("gpt-6-astra", "read-only"),
    "dne-verifier": ("gpt-6-sol", "workspace-write"),
}
SKILLS = {"dne-plan-issue", "dne-deliver-issue", "dne-review-change", "dne-handoff"}
SETUP_FILES = {
    "AGENTS.md", "README.md", "CONTRIBUTING.md", ".gitignore", "Makefile",
    ".githooks/pre-push", ".github/pull_request_template.md",
    ".github/ISSUE_TEMPLATE/delivery.md", ".github/workflows/repository-checks.yml",
    "docs/planning/README.md", "scripts/repo.py", "tests/repository/test_repo.py",
}

APP_FILES = {
    ".env.example", ".nvmrc", "compose.yaml", "eslint.config.mjs", "package.json", "package-lock.json",
    "playwright.config.ts", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts",
    "vitest.integration.config.ts", "scripts/quality-gates.mjs", "scripts/gate-probes.mjs",
    "scripts/verify-app.mjs", "tests/e2e/scenarios.json", "src/main.ts", "migrations/001-learning.sql",
}


class GateError(Exception):
    """A reviewable gate failure, not a successful empty result."""


def require(condition, message):
    if not condition:
        raise GateError(message)


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def repository_files(root):
    raw = subprocess.check_output([
        "git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"
    ])
    return sorted({os.fsdecode(name) for name in raw.split(b"\0") if name})


def validate_scope(root, files):
    require(SETUP_FILES <= set(files), "Required setup files missing: " + str(sorted(SETUP_FILES - set(files))))
    require(APP_FILES <= set(files), "Required application gate files missing: " + str(sorted(APP_FILES - set(files))))
    for name in files:
        p = Path(name)
        allowed = (
            name in SETUP_FILES or name in APP_FILES
            or (p.is_relative_to(Path("src")) and p.suffix == ".ts")
            or (p.is_relative_to(Path("public")) and p.suffix == ".css")
            or (p.parent == Path("migrations") and p.suffix == ".sql")
            or (any(p.is_relative_to(Path("tests") / group) for group in ("unit", "integration", "e2e", "support")) and p.suffix in (".ts", ".mjs"))
            or p.is_relative_to(ARCHIVE)
            or (p.is_relative_to(Path("assets/docs")) and p.suffix == ".md")
            or p == PLAN_WORKBOOK
            or (p.parent == CONTEXT and p.suffix == ".json")
            or (p.parent == Path(".codex/agents") and p.stem in ROLES and p.suffix == ".toml")
            or name in {f".agents/skills/{s}/{f}" for s in SKILLS for f in ("SKILL.md", "agents/openai.yaml")}
        )
        require(allowed, f"Outside verified repository/application scope: {name}. Extend the reviewed gate before adding a new executable source type.")
        require((root / p).is_file() and not (root / p).is_symlink(), f"Missing file or unsupported symlink: {name}")
        require((root / p).resolve().is_relative_to(root.resolve()), f"Path escapes repository: {name}")


def validate_archive(root):
    archive = root / ARCHIVE
    require(archive.is_dir() and not archive.is_symlink(), "Missing or symlinked source archive")
    entries = json.loads((root / CONTEXT / "source-manifest.json").read_text())["files"]
    require(len(entries) == 25, "Historical source inventory must contain all 25 files")
    seen = set()
    for entry in entries:
        relative = Path(entry["path"])
        require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe archive manifest path")
        require(entry["path"] not in seen, "Duplicate archive manifest path")
        seen.add(entry["path"])
        target = archive / relative
        require(target.resolve().is_relative_to(archive.resolve()), "Archive path escapes source directory")
        require(target.is_file() and not target.is_symlink(), f"Missing source file: {relative}")
        data = target.read_bytes()
        require(len(data) == entry["bytes"] and hashlib.sha256(data).hexdigest() == entry["sha256"],
                f"Source checksum mismatch: {relative}")
    inventory = {p.relative_to(archive).as_posix() for p in archive.rglob("*") if p.is_file() or p.is_symlink()}
    require(inventory == seen, f"Archive inventory mismatch: {sorted(inventory ^ seen)}")


def validate_capacity_workbook(root):
    """Keep the one approved planning workbook a local, macro-free OOXML asset."""
    path = root / PLAN_WORKBOOK
    require(path.is_file() and zipfile.is_zipfile(path), "Invalid PLAN-003 capacity workbook")
    with zipfile.ZipFile(path) as workbook:
        names = set(workbook.namelist())
        require({"[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"} <= names,
                "Incomplete PLAN-003 capacity workbook")
        require(not any(name.startswith(("xl/externalLinks/", "xl/embeddings/")) or
                        name.lower().endswith(("vbaproject.bin", "connections.xml")) for name in names),
                "Unsafe external or executable PLAN-003 workbook content")
        require(not any(
            relation.attrib.get("TargetMode", "").lower() == "external"
            for name in names if name.endswith(".rels")
            for relation in ElementTree.fromstring(workbook.read(name))
        ),
                "External relationship in PLAN-003 capacity workbook")


def validate_planning(root):
    context = root / CONTEXT
    plan = json.loads((context / "issues.json").read_text())
    issues = plan["issues"]
    ids = [item["id"] for item in issues]
    require(len(ids) == len(set(ids)) and len(ids) == 55, "Planning snapshot must have 55 unique IDs")
    require({f"CTP-{n:03d}" for n in range(1, 26)} <= set(ids), "Original CTP scope is incomplete")
    by_id = {item["id"]: item for item in issues}
    published = json.loads((context / "github-issues.json").read_text())["issues"]
    require(set(published) == set(ids), "Published issue mapping differs from planning snapshot")
    require(len({item["number"] for item in published.values()}) == len(ids), "Duplicate GitHub issue number")
    visiting, visited = set(), set()

    def visit(key):
        require(key in by_id, f"Unknown dependency: {key}")
        require(key not in visiting, f"Dependency cycle at {key}")
        if key in visited:
            return
        visiting.add(key)
        for dep in by_id[key]["deps"]:
            visit(dep)
        visiting.remove(key)
        visited.add(key)

    for item in issues:
        require(item["ac"] and item["owner"] and item["evidence"] and item["non_goals"], f"Incomplete planning criteria: {item['id']}")
        require(item["milestone"] in plan["milestones"], "Unknown milestone")
        body = (context / "issue-bodies" / f"{item['id']}.md").read_text()
        require("## Acceptance criteria" in body and "## Definition of done" in body, f"Missing AC/DoD in {item['id']}")
        visit(item["id"])
    routes = json.loads((context / "model-recommendations.json").read_text())["issues"]
    require(len(routes) == len(ids) and {r["id"] for r in routes} == set(ids), "Incomplete model routing")
    for row in routes:
        require(row["number"] == published[row["id"]]["number"], "Model route issue mismatch")
        require(row["primary_model"] in {"gpt-6-astra", "gpt-6-sol"}, "Unknown primary model")
        require(row["reasoning"] in {"medium", "high", "xhigh"}, "Unexpected reasoning effort")
        require(bool(row.get("rationale")), "Missing model routing rationale")
        require(not row["escalate_to_xhigh"] or row["reasoning"] == "high", "Redundant XHigh escalation")
        expected = {"model:" + row["primary_model"], "reasoning:" + row["reasoning"]}
        for field, prefix in (("review_model", "review:"), ("design_model", "design:")):
            if row[field]:
                expected.add(prefix + row[field])
        if row["escalate_to_xhigh"]:
            expected.add("escalate:xhigh")
        require(set(row["labels"]) == expected, "Model labels differ from route")


def quoted_fields(text):
    """Read our intentionally narrow JSON-quoted YAML scalar format, without dependencies."""
    result = {}
    for line in text.splitlines():
        key, separator, value = line.strip().partition(": ")
        require(separator and key not in result, "Invalid or duplicate metadata field")
        result[key] = json.loads(value)
        require(isinstance(result[key], str) and result[key].strip(), "Metadata values must be nonempty strings")
    return result


def validate_agents_skills(root):
    agents = root / ".codex/agents"
    require({p.stem for p in agents.glob("*.toml")} == set(ROLES), "Missing or extra agent role")
    for name, (model, sandbox) in ROLES.items():
        config = tomllib.loads((agents / f"{name}.toml").read_text())
        require(config["name"] == name and config["model"] == model, f"Agent model/name mismatch: {name}")
        require(config["model_reasoning_effort"] == "high" and config["sandbox_mode"] == sandbox, f"Agent boundary mismatch: {name}")
        require(config["description"] and "AGENTS.md" in config["developer_instructions"], f"Missing role instructions: {name}")
    skills = root / ".agents/skills"
    require({p.name for p in skills.iterdir() if p.is_dir()} == SKILLS, "Missing or extra skill")
    for name in SKILLS:
        text = (skills / name / "SKILL.md").read_text()
        match = re.match(r"\A---\n(.*?)\n---\n(.+)\Z", text, re.S)
        require(match is not None, f"Invalid skill frontmatter: {name}")
        meta = quoted_fields(match[1])
        require(set(meta) == {"name", "description"} and meta["name"] == name, f"Invalid skill metadata: {name}")
        require(len(meta["description"]) <= 1024 and not re.search(r"[<>]", meta["description"]), "Invalid skill description")
        require("[TODO:" not in text and "AGENTS.md" in match[2], f"Unfinished skill: {name}")
        ui = (skills / name / "agents/openai.yaml").read_text()
        require(ui.startswith("interface:\n"), "Missing skill interface")
        ui_meta = quoted_fields(ui.removeprefix("interface:\n"))
        require(set(ui_meta) == {"display_name", "short_description", "default_prompt"}, "Invalid skill UI fields")
        require(25 <= len(ui_meta["short_description"]) <= 64, "Skill short description length")
        require("$" + name in ui_meta["default_prompt"], "Skill prompt must invoke its name")


def validate_links(root, files):
    """Check inline local Markdown file targets. External URLs and fragments are not fetched."""
    for name in files:
        p = Path(name)
        if p.suffix != ".md" or p.is_relative_to(ARCHIVE):
            continue
        text = (root / p).read_text()
        text = re.sub(r"```.*?```", "", text, flags=re.S)
        for target in re.findall(r"\[[^\]\n]*\]\(([^)\n]+)\)", text):
            target = target.strip().split(' "', 1)[0].strip("<>")
            url = urlsplit(target)
            if url.scheme or url.netloc or not url.path:
                continue
            decoded = unquote(url.path)
            resolved = ((root if decoded.startswith("/") else (root / p).parent) / decoded.lstrip("/")).resolve()
            require(resolved.is_relative_to(root.resolve()) and resolved.exists(), f"Broken local link in {name}: {target}")


def validate(root):
    files = repository_files(root)
    validate_scope(root, files)
    validate_archive(root)
    if PLAN_WORKBOOK.as_posix() in files:
        validate_capacity_workbook(root)
    validate_planning(root)
    validate_agents_skills(root)
    register = json.loads((root / "tests/e2e/scenarios.json").read_text())
    baseline = {f"ROADMAP-{n:02d}" for n in range(1, 10)} | {f"BUILD-{n:02d}" for n in range(1, 11)} | {f"ECO-{n:02d}" for n in range(1, 9)}
    require(baseline <= {row["id"] for row in register["fullMvp"]}, "Full-MVP journey inventory was reduced")
    validate_links(root, files)


def state(root):
    return {"commit": git(root, "rev-parse", "HEAD"), "tree": git(root, "rev-parse", "HEAD^{tree}"),
            "dirty": bool(git(root, "status", "--porcelain", "--untracked-files=all"))}


def run_application(root):
    subprocess.run(["npm", "run", "verify:app"], cwd=root, check=True)


def verify_application(root):
    output = root / "artifacts/application-verification.json"
    output.unlink(missing_ok=True)
    before = state(root)
    run_application(root)
    require(output.is_file(), "Application verification report missing")
    report = json.loads(output.read_text())
    require(report["exitStatus"] == 0 and report["scope"] == "initial-learning-v4", "Application verification failed or wrong scope")
    require(report["revision"] == before and state(root) == before, "Application verification revision changed")
    require(report["unitTests"]["passed"] == report["unitTests"]["total"] > 0, "Missing application unit evidence")
    require(report["integrationTests"]["passed"] == report["integrationTests"]["total"] > 0, "Missing application integration evidence")
    for metric in ("statements", "branches", "functions", "lines"):
        counts = report["unitCoverage"][metric]
        require(counts["total"] > 0 and counts["covered"] / counts["total"] >= .99 and counts["skipped"] == 0,
                "Application unit threshold failed")
    journeys = report["journeys"]
    require(journeys["total"] > 0 and journeys["passed"] / journeys["total"] >= .99
            and journeys["criticalPassed"] == journeys["criticalTotal"] > 0, "Application journey threshold failed")
    return report


def verify(root):
    report = {"scope": "repository-and-initial-learning-v4", "application_status": "not-verified",
              "application_unit_coverage": None, "application_e2e_journey_coverage": None,
              "timestamp_utc": datetime.now(timezone.utc).isoformat(),
              "python": platform.python_version(), "platform": platform.platform(),
              "command": f"{sys.executable} scripts/repo.py verify", "exit_status": 1}
    try:
        report.update(state(root))
        validate(root)
        suite = unittest.defaultTestLoader.discover(str(root / "tests/repository"), pattern="test_*.py")
        require(suite.countTestCases() > 0, "No repository tests collected")
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        report.update(tests_run=result.testsRun, skipped=len(result.skipped), failures=len(result.failures),
                      errors=len(result.errors), expected_failures=len(result.expectedFailures))
        require(result.wasSuccessful() and not result.skipped and not result.expectedFailures,
                "Repository tests failed, were skipped, or had expected failures")
        app = verify_application(root)
        report.update(application_status="verified-local-slice", application_unit_coverage=app["unitCoverage"],
                      application_e2e_journey_coverage=app["journeys"])
        report["exit_status"] = 0
    except (GateError, OSError, ValueError, KeyError, subprocess.CalledProcessError) as exc:
        report["error"] = str(exc)
        print(f"FAIL: {exc}", file=sys.stderr)
    finally:
        output = root / "artifacts/repository-verification.json"
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Repository verification {'PASS' if report['exit_status'] == 0 else 'FAIL'}; application status: {report['application_status']}.")
    return report["exit_status"]


def bootstrap(root):
    existing = subprocess.run(["git", "-C", str(root), "config", "--get", "core.hooksPath"], capture_output=True, text=True)
    require(existing.returncode in (0, 1), "Cannot inspect Git hook configuration")
    require(existing.returncode == 1 or existing.stdout.strip() == ".githooks", "Existing core.hooksPath conflicts; integrate deliberately without overwriting it")
    if existing.returncode == 1:
        common_dir = Path(git(root, "rev-parse", "--git-common-dir"))
        if not common_dir.is_absolute():
            common_dir = root / common_dir
        old_hook = common_dir / "hooks/pre-push"
        require(not (old_hook.exists() and os.access(old_hook, os.X_OK)), "Existing active pre-push hook; integrate deliberately")
    hook = root / ".githooks/pre-push"
    require(hook.is_file(), "Repository pre-push hook missing")
    hook.chmod(hook.stat().st_mode | 0o111)
    git(root, "config", "--local", "core.hooksPath", ".githooks")
    print("Repository pre-push hook installed. Run make verify.")


def validate_push(root, lines):
    pushed = []
    for line in lines.splitlines():
        fields = line.split()
        require(len(fields) == 4, "Malformed pre-push input")
        sha = fields[1]
        require(re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", sha), "Malformed pushed object ID")
        if set(sha) != {"0"}:
            pushed.append(sha)
    if not pushed:
        return False
    current = state(root)
    require(not current["dirty"], "Push requires a clean checkout, including untracked files")
    require(all(sha == current["commit"] for sha in pushed), "Pushed refs must point to checked-out HEAD; verify the intended commit")
    return True


def pre_push(root, lines):
    if not validate_push(root, lines):
        return 0
    before = state(root)
    code = verify(root)
    require(code == 0, "Pre-push verification failed")
    require(state(root) == before, "Checkout changed during verification; commit and verify again")
    return 0


def main():
    require(len(sys.argv) == 2, "Usage: python3 scripts/repo.py bootstrap|verify|pre-push")
    command = sys.argv[1]
    if command == "bootstrap":
        bootstrap(ROOT)
        return 0
    if command == "verify":
        return verify(ROOT)
    if command == "pre-push":
        return pre_push(ROOT, sys.stdin.read())
    raise GateError(f"Unknown command: {command}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except GateError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        sys.exit(1)
