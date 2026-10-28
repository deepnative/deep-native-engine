"""Build this local reader from the authored drafts; no third-party dependency.

This deliberately supports the Markdown forms used by the authored Markdown files. It is
not a general Markdown renderer or a renderer for untrusted/member content.
Run with --check to detect source drift without writing the generated module.
"""

from pathlib import Path
import hashlib
import html
import json
import re
import sys

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
ROUTES = {"everyday": ("Everyday", "E"), "work": ("Work", "W"), "technical": ("Technical", "T")}
FILES = sorted((BASE / "lessons").glob("*.md"))
assert len(FILES) == 6
LINKS = {p.name: f"#lesson={i + 1}" for i, p in enumerate(FILES)}
LINKS.update({"foundation-practice.md": "#lesson=7", "README.md": "#lesson=1"})


def inline(value):
    value = html.escape(value)
    def link(match):
        label, target = match.groups()
        if "prototype/" in target:
            target = "../prototype/"
        else:
            target = LINKS.get(target.split("/")[-1], target)
        assert target.startswith(("#", "../", "https://")), target
        return f'<a href="{target}">{label}</a>'
    value = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", link, value)
    value = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", value)
    return re.sub(r"`([^`]+)`", r"<code>\1</code>", value)


def markdown(text):
    lines = text.strip().splitlines()
    result = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line or line.startswith("<!--"):
            i += 1
            continue
        if line.startswith("<details>"):
            match = re.fullmatch(r"<details><summary>(.*?)</summary>", line)
            assert match, line
            result.append(f"<details><summary>{inline(match[1])}</summary>")
        elif line == "</details>":
            result.append(line)
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            assert len(rows) >= 2 and all(re.fullmatch(r":?-+:?", c) for c in rows[1]), rows
            result.append('<div class="table-wrap"><table><thead><tr>' + "".join(f"<th>{inline(c)}</th>" for c in rows[0]) + "</tr></thead><tbody>")
            result.extend("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in row) + "</tr>" for row in rows[2:])
            result.append("</tbody></table></div>")
            continue
        elif re.match(r"^[-\d]+[.)]? ", line):
            ordered = bool(re.match(r"\d+\.", line))
            tag = "ol" if ordered else "ul"
            result.append(f"<{tag}>")
            while i < len(lines) and re.match(r"^(?:- |\d+\. )", lines[i].strip()):
                result.append("<li>" + inline(re.sub(r"^(?:- |\d+\. )", "", lines[i].strip())) + "</li>")
                i += 1
            result.append(f"</{tag}>")
            continue
        elif line.startswith(">"):
            quoted = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quoted.append(lines[i].strip()[1:].strip())
                i += 1
            result.append("<blockquote>" + markdown("\n".join(quoted)) + "</blockquote>")
            continue
        elif line.startswith("#"):
            match = re.match(r"(#{1,6}) (.*)", line)
            level = min(len(match[1]) + 1, 6)
            result.append(f"<h{level}>{inline(match[2])}</h{level}>")
        else:
            paragraph = [line]
            i += 1
            while i < len(lines) and lines[i].strip() and not re.match(r"^(?:[#|>]|<details>|</details>|- |\d+\. )", lines[i].strip()):
                paragraph.append(lines[i].strip())
                i += 1
            result.append("<p>" + inline(" ".join(paragraph)) + "</p>")
            continue
        i += 1
    return "\n".join(result)


def parts(text):
    sections = re.split(r"(?m)^## (.+)\n", text)
    return sections[0], dict(zip(sections[1::2], sections[2::2]))


def select_route(text, title, letter):
    selected = []
    keep = True
    for line in text.splitlines():
        heading = re.match(r"### (Everyday|Work|Technical)\b", line)
        if heading:
            keep = heading[1] == title
        if not keep:
            continue
        case = re.match(r"\| `L\d-([EWT])-", line)
        if case and case[1] != letter:
            continue
        comparison = re.match(r"- \*\*(Everyday|Work|Technical):\*\*", line)
        if comparison and comparison[1] != title:
            continue
        selected.append(line)
    return "\n".join(selected).strip()


def questions(text, lesson):
    hint = re.search(r"\*\*Hint:\*\* (.+)", text)[1]
    if lesson == 3:
        prompts, feedback = {}, {}
        for case, value in re.findall(r"^\| `(L3-[EWT]-P\d)` \| (.+?) \|$", text, re.M):
            if value.startswith("**"):
                feedback[case] = value
            else:
                prompts[case] = value
        result = []
        for case, prompt in prompts.items():
            answer = re.match(r"\*\*(Supported|Contradicted|Not given)", feedback[case])[1]
            result.append({"id": case, "prompt": prompt, "choices": [{"key": x, "label": x} for x in ["Supported", "Contradicted", "Not given"]], "answer": answer, "feedback": markdown(feedback[case])})
        assert len(result) == 3
        return {"intro": markdown(text.split("| Case")[0]), "hint": hint, "questions": result}
    lead, exercise = text.split("### ", 1)
    case = re.search(r"`(L\d-[EWT]-P)`", exercise)[1]
    choices = [{"key": key, "label": label} for key, label in re.findall(r"^- \*\*([ABC])\.\*\* (.+)$", exercise, re.M)]
    assert len(choices) == 3
    prompt = exercise.split("\n", 1)[1].split("- **A.")[0].strip()
    feedback = re.search(r"<details><summary>.*?</summary>\s*(.*?)\s*</details>", exercise, re.S)[1]
    answer = re.match(r"\*\*([ABC])\b", feedback)[1]
    return {"intro": markdown(lead), "hint": hint, "questions": [{"id": case, "prompt": prompt or "Choose the response that fits the source.", "choices": choices, "answer": answer, "feedback": markdown(feedback)}]}


feedback_path = HERE / "feedback-cases.json"
feedback_cases = json.loads(feedback_path.read_text())
assert set(feedback_cases) == set(ROUTES)
feedback_lesson = FILES[5].read_text()
for case in feedback_cases.values():
    assert case["id"] in feedback_lesson and case["source"] in feedback_lesson
    assert case["comment"].rstrip(".") in feedback_lesson
    assert [v["id"] for v in case["versions"]] == list(range(1, len(case["versions"]) + 1))
    assert case["commentVersion"] == 1
sources = [{"path": str(p.relative_to(BASE)), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in FILES + [BASE / "foundation-practice.md", feedback_path, BASE / "contribution-practice.md"]]
course = {"version": 1, "contentHash": hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest(), "sources": sources, "feedbackCases": feedback_cases, "lessons": [], "capstone": {}}
for number, p in enumerate(FILES, 1):
    intro, sections = parts(p.read_text())
    assert len(sections) == 4, p
    title = re.match(r"# \d\. (.+)", intro)[1]
    lesson = {"title": title, "intro": markdown(intro.split("\n", 1)[1]), "routes": {}}
    for route, (name, letter) in ROUTES.items():
        see, practice, transfer, own = [select_route(s, name, letter) for s in sections.values()]
        source = re.search(r"\*\*Source [EWT]\d:\*\* (.+)", see)[1]
        fresh_source = re.search(r"^\| `L\d-[EWT]-X` \| (.+?) \|", transfer, re.M)[1]
        before, comparison = transfer.split("<details>", 1)
        lesson["routes"][route] = {"source": source, "freshSource": fresh_source, "example": markdown(see), "practice": questions(practice, number), "transfer": markdown(before), "comparison": markdown("<details>" + comparison), "own": markdown(own)}
    course["lessons"].append(lesson)

_, sections = parts((BASE / "foundation-practice.md").read_text())
briefs = {}
for line in sections["Choose a fresh brief"].splitlines():
    match = re.match(r"\| (Everyday|Work|Technical) / `CAP-[EWT]` \| (.+?) \| (.+?) \|", line)
    if match:
        briefs[match[1].lower()] = {"source": match[2], "output": match[3]}
instructions, samples = sections["Build your learning record"].split("**Teaching samples", 1)
for route, (name, _) in ROUTES.items():
    sample = re.search(r"- \*\*" + name + r":\*\* (.+)", samples)[1]
    if route == "everyday":
        comparison = sections["A complete worked record: Everyday"]
    else:
        comparison = re.search(r"<details><summary>" + name + r":.*?</summary>\s*(.*?)</details>", sections["Checks for the other routes"], re.S)[1]
    course["capstone"][route] = {**briefs[route], "instructions": markdown(instructions), "sample": sample, "comparison": markdown(comparison), "criteria": markdown(sections["Decide what you can show"])}

contribution_intro, contribution_sections = parts((BASE / "contribution-practice.md").read_text())
course["contribution"] = {"intro": markdown(contribution_intro.split("\n", 1)[1]), "source": markdown(contribution_sections["Source for this practice"]), "teaching": markdown(contribution_sections["Work through a contribution"]), "prompt": markdown(contribution_sections["Draft your own proposal"])}

output = "// Generated by build.py from authored lesson and contribution drafts plus structured feedback cases. Do not hand-edit.\nexport const course = " + json.dumps(course, ensure_ascii=False, indent=2) + ";\n"
target = HERE / "course.mjs"
if "--check" in sys.argv:
    assert target.exists() and target.read_text() == output, "Reader content is stale; run build.py."
    print(f"Source parity passed: {len(sources)} authored files, 18 lesson-route views and 3 final-practice views.")
else:
    target.write_text(output)
    print(f"Built {target.name} from {len(sources)} authored files.")
