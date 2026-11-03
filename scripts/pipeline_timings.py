#!/usr/bin/env python3
"""Per-stage timings for the local gate and the Azure deploy workflow (#630).

Reads timestamps the gate already writes to artifacts/*.json, or a deploy run
from `gh run view`, prints a table and optionally appends one JSON line to a
history file in the Git common directory. It never writes under artifacts/,
so verification receipts and artifact hashes are unaffected.

    python3 scripts/pipeline_timings.py gate [ARTIFACTS_DIR] [--record]
    python3 scripts/pipeline_timings.py deploy RUN_ID... [--record]
    python3 scripts/pipeline_timings.py history [COUNT]
"""

import json
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

HISTORY_NAME = "dne-timings.jsonl"
RUN_FIELDS = "databaseId,headSha,event,conclusion,createdAt,updatedAt,jobs"


def seconds(start, end):
    return round((datetime.fromisoformat(end) - datetime.fromisoformat(start)).total_seconds())


def duration(value):
    return f"{int(value) // 60}m{int(value) % 60:02d}s"


def load(directory, name):
    try:
        return json.loads((directory / name).read_text())
    except (OSError, ValueError):
        return {}


def lane_seconds(rows):
    return [seconds(row["started"], row["finished"]) for row in rows if row.get("started") and row.get("finished")]


def gate_record(artifacts):
    """One gate run from its artifacts. Missing files give a partial record."""
    artifacts = Path(artifacts)
    repository = load(artifacts, "repository-verification.json")
    application = load(artifacts, "application-verification.json")
    stages = [{"stage": row["stage"], "parent": None, "seconds": seconds(row["started"], row["finished"]),
               "approximate": False}
              for row in repository.get("stage_timings", []) if row.get("finished")]
    commands = application.get("commands", [])
    for index, command in enumerate(commands):
        end = command.get("finished")
        # Older reports only have start times: use the next command's start.
        approximate = end is None
        if approximate:
            end = commands[index + 1]["start"] if index + 1 < len(commands) else application.get("finishedAt")
        if end:
            stages.append({"stage": command["command"], "parent": "application verification",
                           "seconds": seconds(command["start"], end), "approximate": approximate})
    timed = repository.get("stage_timings") or []
    if timed and timed[-1].get("finished"):
        total = seconds(timed[0]["started"], timed[-1]["finished"])
    elif application.get("startedAt") and application.get("finishedAt"):
        total = seconds(application["startedAt"], application["finishedAt"])
    else:
        total = None
    status = {0: "passed", 1: "failed"}.get(repository.get("exit_status", application.get("exitStatus")), "unknown")
    error = repository.get("error") or application.get("error") or ""
    failed = re.search(r"during (.+)\.$", error)
    return {
        "kind": "gate", "revision": repository.get("commit") or application.get("revision", {}).get("commit"),
        "started": timed[0]["started"] if timed else application.get("startedAt"),
        "status": status, "failed_stage": failed.group(1) if failed else None, "seconds": total,
        "stages": stages,
        "lanes": {"integration": lane_seconds(load(artifacts, "integration-shards.json").get("lanes", [])),
                  "browser": lane_seconds(load(artifacts, "browser-shards.json").get("lanes", []))},
    }


def deploy_record(run):
    """One deploy workflow run from `gh run view --json` output."""
    stages = []
    for job in run.get("jobs", []):
        if job.get("startedAt"):
            stages.append({"stage": "queue", "parent": job["name"],
                           "seconds": seconds(run["createdAt"], job["startedAt"]), "approximate": False})
        for step in job.get("steps", []):
            if step.get("startedAt") and step.get("completedAt"):
                stages.append({"stage": step["name"], "parent": job["name"],
                               "seconds": seconds(step["startedAt"], step["completedAt"]), "approximate": False})
    return {"kind": "deploy", "run": run.get("databaseId"), "revision": run.get("headSha"),
            "started": run.get("createdAt"), "status": run.get("conclusion") or "unknown",
            "failed_stage": None, "seconds": seconds(run["createdAt"], run["updatedAt"]), "stages": stages}


def format_record(record):
    total = duration(record["seconds"]) if record["seconds"] is not None else "unknown"
    label = f"run {record['run']} " if record.get("run") else ""
    lines = [f"{record['kind']} {label}{(record.get('revision') or '?')[:7]} {record['status']}"
             f"{' at ' + record['failed_stage'] if record.get('failed_stage') else ''}, total {total}"]
    for row in record["stages"]:
        indent = "    " if row["parent"] and record["kind"] == "gate" else "  "
        lines.append(f"{indent}{row['stage']:<52}{'~' if row['approximate'] else ' '}{duration(row['seconds']):>8}")
    for name, values in record.get("lanes", {}).items():
        if values:
            slowest = max(values)
            lines.append(f"  {name} lanes ({len(values)}): fastest {duration(min(values))}, slowest "
                         f"{duration(slowest)} (lane {values.index(slowest) + 1})")
    ranked = sorted(record["stages"], key=lambda row: -row["seconds"])
    # In a gate, "application verification" contains its commands; rank the parts.
    ranked = [row for row in ranked if not any(other["parent"] == row["stage"] for other in record["stages"])]
    lines.append("Slowest: " + "; ".join(f"{row['stage']} {duration(row['seconds'])}" for row in ranked[:5]))
    if any(row["approximate"] for row in record["stages"]):
        lines.append("~ derived from the next command's start (report has no finish time)")
    return "\n".join(lines)


def history_path(root):
    common = subprocess.run(["git", "-C", str(root), "rev-parse", "--git-common-dir"],
                            check=True, capture_output=True, text=True).stdout.strip()
    common = Path(common)
    return (common if common.is_absolute() else Path(root) / common) / HISTORY_NAME


def append_history(root, record):
    with history_path(root).open("a") as stream:
        stream.write(json.dumps(record) + "\n")


def record_after_gate(root):
    """Called by `repo.py verify` after its report is written. Never fails the gate."""
    try:
        record = gate_record(Path(root) / "artifacts")
        append_history(root, record)
        print(format_record(record))
    except Exception:
        print("Timing summary unavailable; the gate result is unchanged.")


def main(argv, root=Path(__file__).resolve().parents[1]):
    args = [arg for arg in argv if arg != "--record"]
    store = "--record" in argv
    if not args or args[0] not in ("gate", "deploy", "history"):
        print("Usage: pipeline_timings.py gate [ARTIFACTS_DIR] | deploy RUN_ID... | history [COUNT], with optional --record")
        return 2
    if args[0] == "history":
        path = history_path(root)
        rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        for row in rows[-int(args[1]) if len(args) > 1 else -20:]:
            total = duration(row["seconds"]) if row.get("seconds") is not None else "unknown"
            print(f"{row.get('started') or '?':<32} {row['kind']:<7} {(row.get('revision') or '?')[:7]} "
                  f"{row['status']:<8} {total:>8}")
        return 0
    if args[0] == "gate":
        records = [gate_record(Path(args[1]) if len(args) > 1 else Path(root) / "artifacts")]
    else:
        if len(args) < 2 or not all(re.fullmatch(r"\d+", run) for run in args[1:]):
            print("Usage: pipeline_timings.py deploy RUN_ID... (numeric run IDs)")
            return 2
        records = [deploy_record(json.loads(subprocess.run(
            ["gh", "run", "view", run, "--json", RUN_FIELDS],
            check=True, capture_output=True, text=True).stdout)) for run in args[1:]]
    for record in records:
        print(format_record(record))
        if store:
            append_history(root, record)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
