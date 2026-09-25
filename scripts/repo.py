#!/usr/bin/env python3
"""Shared repository and initial learning application verification gate."""

import hashlib
import json
import os
import platform
import re
import stat
import struct
import subprocess
import sys
import tomllib
import unittest
import zipfile
from contextlib import contextmanager, redirect_stderr, redirect_stdout
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
    "playwright.config.ts", "playwright.provisional.config.ts", "playwright.full.config.ts", "tsconfig.json", "tsconfig.build.json", "vitest.config.ts",
    "vitest.integration.config.ts", "scripts/quality-gates.mjs", "scripts/gate-probes.mjs",
    "scripts/verify-app.mjs", "scripts/check-installed-deps.mjs", "scripts/verify-full-release.mjs", "scripts/full-release-evidence.mjs", "tests/e2e/scenarios.json", "tests/e2e/full-mvp-approval.json", "src/main.ts", "migrations/001-learning.sql",
    "assets/docs/content/circles/preview-circles.json",
}

# Bounded, high-confidence source scan. These signatures are intentionally
# narrower than a production secret-scanning service and never print matches.
SECRET_MARKERS = {
    "github-token": re.compile(rb"(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,})(?![A-Za-z0-9_])"),
    "openai-key": re.compile(rb"(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])"),
    "aws-access-key": re.compile(rb"(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])"),
    "private-key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"),
}
MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
MAX_ZIP_MEMBERS = 2048
MAX_ZIP_CENTRAL_BYTES = 2 * 1024 * 1024
MAX_ZIP_MEMBER_BYTES = 32 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 128 * 1024 * 1024
ZIP_SIGNATURES = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")
UNSUPPORTED_ARCHIVE_SIGNATURES = (b"\x1f\x8b", b"BZh", b"\xfd7zXZ\x00",
                                  b"7z\xbc\xaf\x27\x1c", b"Rar!\x1a\x07")
NESTED_ARCHIVE_SUFFIXES = (".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z", ".rar")


class GateError(Exception):
    """A reviewable gate failure, not a successful empty result."""

    def __init__(self, message, *, public_message=None):
        super().__init__(message)
        self.public_message = public_message


def require(condition, message):
    # Callers supply code-owned text and opaque references, never raw input.
    if not condition:
        raise GateError(message, public_message=message)


def diagnostic_ref(value):
    """Identify an input locally without publishing its path, ID or contents."""
    return "ref-sha256:" + hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()[:12]


def failure_message(error, fallback):
    # Unexpected exceptions may contain private values, including in __str__.
    if type(error) is GateError and error.public_message is not None:
        return error.public_message
    return fallback


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True, stderr=subprocess.PIPE).strip()


def repository_files(root):
    raw = subprocess.check_output([
        "git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"
    ], stderr=subprocess.PIPE)
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
            or (any(p.is_relative_to(Path("tests") / group) for group in ("unit", "integration", "e2e", "full-e2e", "support")) and p.suffix in (".ts", ".mjs"))
            or p.is_relative_to(ARCHIVE)
            or (p.is_relative_to(Path("assets/docs")) and p.suffix == ".md")
            or p == PLAN_WORKBOOK
            or (p.parent == CONTEXT and p.suffix == ".json")
            or (p.parent == Path(".codex/agents") and p.stem in ROLES and p.suffix == ".toml")
            or name in {f".agents/skills/{s}/{f}" for s in SKILLS for f in ("SKILL.md", "agents/openai.yaml")}
        )
        require(allowed, f"Outside verified repository/application scope: {diagnostic_ref(name)}. Extend the reviewed gate before adding a new executable source type.")
        require((root / p).is_file() and not (root / p).is_symlink(), f"Missing file or unsupported symlink: {diagnostic_ref(name)}")
        require((root / p).resolve().is_relative_to(root.resolve()), f"Path escapes repository: {diagnostic_ref(name)}")


def validate_secret_markers(root, files):
    """Reject recognizable credential bytes in every nonignored repository file."""
    for name in files:
        content = (root / name).read_bytes()
        for rule, pattern in SECRET_MARKERS.items():
            match = pattern.search(content)
            if match:
                line = content.count(b"\n", 0, match.start()) + 1
                require(False,
                    f"High-confidence credential candidate at {diagnostic_ref(name)}:{line} ({rule}); "
                    "value suppressed. Remove it from source and rotate it if real."
                )
    return len(files)


def scan_zip_artifact(path, name):
    """Inspect one ZIP without extraction or disclosing untrusted archive metadata."""
    members_scanned = 0
    total_bytes = 0
    seen = set()
    try:
        # ZipFile parses the central directory on open, so cap it first.
        with path.open("rb") as source:
            source.seek(-min(path.stat().st_size, 22 + 65535), os.SEEK_END)
            trailer = source.read()
        end = trailer.rfind(b"PK\x05\x06")
        require(end >= 0 and len(trailer) - end >= 22,
                f"Unreadable ZIP artifact at {diagnostic_ref(name)}")
        _, disk, start_disk, disk_entries, entries, central_size, _, comment_size = struct.unpack_from(
            "<4s4H2LH", trailer, end)
        require(disk == 0 and start_disk == 0 and disk_entries == entries
                and entries <= MAX_ZIP_MEMBERS and central_size <= MAX_ZIP_CENTRAL_BYTES
                and len(trailer) - end - 22 == comment_size,
                f"ZIP central directory exceeds supported bounds at {diagnostic_ref(name)}")
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            require(len(members) <= MAX_ZIP_MEMBERS,
                    f"ZIP artifact exceeds entry limit at {diagnostic_ref(name)}")
            for member in members:
                member_ref = diagnostic_ref(name + ":" + member.filename)
                parts = member.filename.rstrip("/").split("/")
                unsafe_name = (not member.filename or member.filename.startswith(("/", "\\"))
                               or "\\" in member.filename or "\x00" in member.filename
                               or any(part in ("", ".", "..") for part in parts)
                               or (parts and re.match(r"^[A-Za-z]:", parts[0]))
                               or member.filename in seen)
                require(not unsafe_name, f"Unsafe ZIP entry path at {member_ref}")
                seen.add(member.filename)
                mode = member.external_attr >> 16
                require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR),
                        f"Unsafe ZIP entry type at {member_ref}")
                require(not member.flag_bits & 1, f"Encrypted ZIP entry at {member_ref}")
                require(member.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                        f"Unsupported ZIP compression at {member_ref}")
                encoded_name = os.fsencode(member.filename)
                for rule, pattern in SECRET_MARKERS.items():
                    require(not pattern.search(encoded_name),
                            f"High-confidence credential candidate at {member_ref} ({rule}); value suppressed.")
                if member.is_dir():
                    require(member.file_size == 0, f"Unsafe ZIP directory at {member_ref}")
                    continue
                require(not member.filename.lower().endswith(NESTED_ARCHIVE_SUFFIXES),
                        f"Nested archive is unsupported at {member_ref}")
                require(member.file_size <= MAX_ZIP_MEMBER_BYTES,
                        f"ZIP entry exceeds size limit at {member_ref}")
                total_bytes += member.file_size
                require(total_bytes <= MAX_ZIP_TOTAL_BYTES,
                        f"ZIP artifact exceeds expanded size limit at {diagnostic_ref(name)}")
                observed = 0
                tail = b""
                with archive.open(member) as source:
                    while chunk := source.read(64 * 1024):
                        observed += len(chunk)
                        require(observed <= MAX_ZIP_MEMBER_BYTES,
                                f"ZIP entry exceeds size limit at {member_ref}")
                        require(total_bytes - member.file_size + observed <= MAX_ZIP_TOTAL_BYTES,
                                f"ZIP artifact exceeds expanded size limit at {diagnostic_ref(name)}")
                        if observed == len(chunk):
                            require(not chunk.startswith(ZIP_SIGNATURES)
                                    and not chunk.startswith(UNSUPPORTED_ARCHIVE_SIGNATURES)
                                    and chunk[257:262] != b"ustar",
                                    f"Nested archive is unsupported at {member_ref}")
                        window = tail + chunk
                        for rule, pattern in SECRET_MARKERS.items():
                            require(not pattern.search(window),
                                    f"High-confidence credential candidate at {member_ref} ({rule}); value suppressed.")
                        tail = window[-256:]
                require(observed == member.file_size, f"ZIP entry size mismatch at {member_ref}")
                members_scanned += 1
    except GateError:
        raise
    except Exception:
        raise GateError(f"Unreadable ZIP artifact at {diagnostic_ref(name)}") from None
    return members_scanned


def scan_artifacts(root):
    """Fail closed before generated reports or traces can be displayed or uploaded."""
    directory = root / "artifacts"
    require(directory.is_dir() and not directory.is_symlink(), "Verification artifacts missing or unsafe")
    files = []
    for candidate in directory.rglob("*"):
        require(not candidate.is_symlink(), "Verification artifact symlink is unsafe")
        if candidate.is_dir():
            continue
        require(candidate.is_file(), "Verification artifact type is unsafe")
        files.append(candidate.relative_to(root).as_posix())
    require(files, "Verification artifacts missing")
    archive_entries = 0
    for name in files:
        path = root / name
        require(path.stat().st_size <= MAX_ARTIFACT_BYTES,
                f"Verification artifact exceeds size limit at {diagnostic_ref(name)}")
        encoded_name = os.fsencode(name)
        for rule, pattern in SECRET_MARKERS.items():
            if pattern.search(encoded_name):
                require(False,
                    f"High-confidence credential candidate in artifact {diagnostic_ref(name)} "
                    f"({rule}); value suppressed."
                )
        with path.open("rb") as source:
            prefix = source.read(262)
        suffix = path.suffix.lower()
        require(suffix not in NESTED_ARCHIVE_SUFFIXES or suffix == ".zip",
                f"Unsupported compressed artifact at {diagnostic_ref(name)}")
        require(not prefix.startswith(UNSUPPORTED_ARCHIVE_SIGNATURES)
                and prefix[257:262] != b"ustar",
                f"Unsupported compressed artifact at {diagnostic_ref(name)}")
        if suffix == ".zip" or prefix.startswith(ZIP_SIGNATURES) or zipfile.is_zipfile(path):
            archive_entries += scan_zip_artifact(path, name)
    return {"status": "passed", "files_scanned": validate_secret_markers(root, files),
            "archive_entries_scanned": archive_entries, "rules": sorted(SECRET_MARKERS)}


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
        require(target.is_file() and not target.is_symlink(), f"Missing source file: {diagnostic_ref(relative.as_posix())}")
        data = target.read_bytes()
        require(len(data) == entry["bytes"] and hashlib.sha256(data).hexdigest() == entry["sha256"],
                f"Source checksum mismatch: {diagnostic_ref(relative.as_posix())}")
    inventory = {p.relative_to(archive).as_posix() for p in archive.rglob("*") if p.is_file() or p.is_symlink()}
    require(inventory == seen, "Archive inventory mismatch; compare files with the source manifest")


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
        require(key in by_id, f"Unknown dependency: {diagnostic_ref(key)}")
        require(key not in visiting, f"Dependency cycle at {diagnostic_ref(key)}")
        if key in visited:
            return
        visiting.add(key)
        for dep in by_id[key]["deps"]:
            visit(dep)
        visiting.remove(key)
        visited.add(key)

    for item in issues:
        require(item["ac"] and item["owner"] and item["evidence"] and item["non_goals"], f"Incomplete planning criteria: {diagnostic_ref(item['id'])}")
        require(item["milestone"] in plan["milestones"], "Unknown milestone")
        body = (context / "issue-bodies" / f"{item['id']}.md").read_text()
        require("## Acceptance criteria" in body and "## Definition of done" in body, f"Missing AC/DoD in {diagnostic_ref(item['id'])}")
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
            require(resolved.is_relative_to(root.resolve()) and resolved.exists(),
                    f"Broken local link in {diagnostic_ref(name)}: {diagnostic_ref(target)}")


def validate(root):
    files = repository_files(root)
    validate_scope(root, files)
    scanned = validate_secret_markers(root, files)
    validate_archive(root)
    if PLAN_WORKBOOK.as_posix() in files:
        validate_capacity_workbook(root)
    validate_planning(root)
    validate_agents_skills(root)
    circles = json.loads((root / "assets/docs/content/circles/preview-circles.json").read_text())
    require(isinstance(circles, list) and len(circles) == 3, "Local circle topic inventory changed")
    require({item["id"] for item in circles} == {"everyday-ai", "professional-work", "technical-practice"},
            "Local circle topic IDs changed")
    require({item["goal"] for item in circles} == {"everyday", "work", "build"},
            "Local circle goals changed")
    require(all(isinstance(item["title"], str) and item["title"] and
                isinstance(item["description"], str) and len(item["description"]) > 25 and
                type(item["capacity"]) is int and item["capacity"] == 4 for item in circles),
            "Invalid local circle metadata or capacity")
    register = json.loads((root / "tests/e2e/scenarios.json").read_text())
    require(register["fullMvpVersion"] == "full-mvp-v1", "Full-MVP proposal version changed without gate review")
    baseline = {f"ROADMAP-{n:02d}" for n in range(1, 10)} | {f"BUILD-{n:02d}" for n in range(1, 11)} | {f"ECO-{n:02d}" for n in range(1, 9)}
    require(baseline == {row["id"] for row in register["fullMvp"]}, "Full-MVP journey family inventory changed")
    validate_links(root, files)
    return {"status": "passed", "files_scanned": scanned,
            "rules": sorted(SECRET_MARKERS)}


def state(root):
    return {"commit": git(root, "rev-parse", "HEAD"), "tree": git(root, "rev-parse", "HEAD^{tree}"),
            "dirty": bool(git(root, "status", "--porcelain", "--untracked-files=all"))}


def run_application(root):
    # The application runner publishes fixed stage diagnostics and a report.
    # Its child output must not bypass this repository-level console boundary.
    subprocess.run(["npm", "run", "verify:app"], cwd=root, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


@contextmanager
def private_test_output():
    """Contain Python and inherited native child output during test discovery/run."""
    with open(os.devnull, "w") as sink:
        stdout_fd, stderr_fd = os.dup(1), os.dup(2)
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(sink.fileno(), 1)
            os.dup2(sink.fileno(), 2)
            with redirect_stdout(sink), redirect_stderr(sink):
                yield sink
        finally:
            try:
                sys.stdout.flush()
                sys.stderr.flush()
            finally:
                os.dup2(stdout_fd, 1)
                os.dup2(stderr_fd, 2)
                os.close(stdout_fd)
                os.close(stderr_fd)


def verify_application(root):
    output = root / "artifacts/application-verification.json"
    output.unlink(missing_ok=True)
    before = state(root)
    run_application(root)
    require(output.is_file(), "Application verification report missing")
    report = json.loads(output.read_text())
    require(report["exitStatus"] == 0 and report["scope"] == "initial-learning-v25", "Application verification failed or wrong scope")
    require(report["revision"] == before and state(root) == before, "Application verification revision changed")
    require(report.get("commands") and report["commands"][0]["command"] == "node scripts/check-installed-deps.mjs"
            and report["commands"][0]["exitStatus"] == 0, "Installed dependency prerequisite missing or failed")
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
    report = {"scope": "repository-and-initial-learning-v25", "application_status": "not-verified",
              "application_unit_coverage": None, "application_e2e_journey_coverage": None,
              "timestamp_utc": datetime.now(timezone.utc).isoformat(),
              "python": platform.python_version(), "platform": platform.platform(),
              "command": "python scripts/repo.py verify", "exit_status": 1}
    stage = "revision identification"
    try:
        report.update(state(root))
        stage = "repository assets"
        report["secret_scan"] = validate(root)
        stage = "repository tests"
        with private_test_output() as sink:
            suite = unittest.defaultTestLoader.discover(str(root / "tests/repository"), pattern="test_*.py")
            require(suite.countTestCases() > 0, "No repository tests collected")
            result = unittest.TextTestRunner(stream=sink, verbosity=0).run(suite)
        report.update(tests_run=result.testsRun, skipped=len(result.skipped), failures=len(result.failures),
                      errors=len(result.errors), expected_failures=len(result.expectedFailures))
        print(f"Repository tests: {result.testsRun} run, {len(result.failures)} failures, "
              f"{len(result.errors)} errors, {len(result.skipped)} skipped, "
              f"{len(result.expectedFailures)} expected failures.")
        require(result.wasSuccessful() and not result.skipped and not result.expectedFailures,
                "Repository tests failed, were skipped, or had expected failures")
        stage = "application verification"
        app = verify_application(root)
        stage = "artifact scan"
        report["artifact_scan"] = scan_artifacts(root)
        report.update(application_status="verified-local-slice", application_unit_coverage=app["unitCoverage"],
                      application_e2e_journey_coverage=app["journeys"])
        report["exit_status"] = 0
    except Exception as exc:
        report["error"] = failure_message(exc, f"Repository verification failed during {stage}.")
        print(f"FAIL: {report['error']}", file=sys.stderr)
    finally:
        try:
            output = root / "artifacts/repository-verification.json"
            output.parent.mkdir(exist_ok=True)
            output.write_text(json.dumps(report, indent=2) + "\n")
        except Exception:
            report["exit_status"] = 1
            print("Repository verification report could not be written.", file=sys.stderr)
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
    require(len(sys.argv) == 2, "Usage: python3 scripts/repo.py bootstrap|verify|pre-push|scan-artifacts")
    command = sys.argv[1]
    if command == "bootstrap":
        bootstrap(ROOT)
        return 0
    if command == "verify":
        return verify(ROOT)
    if command == "pre-push":
        return pre_push(ROOT, sys.stdin.read())
    if command == "scan-artifacts":
        result = scan_artifacts(ROOT)
        print(f"Artifact scan passed: {result['files_scanned']} files.")
        return 0
    require(False, "Unknown command; use bootstrap, verify, pre-push or scan-artifacts")


def run_cli():
    try:
        return main()
    except Exception as exc:
        print("FAIL: " + failure_message(exc, "Repository command failed; check configuration and filesystem access."), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(run_cli())
