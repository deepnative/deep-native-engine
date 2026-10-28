# Content workshop

Open [the local workshop](http://localhost:56274/authoring/) to inspect a teaching problem, revise its wording, try the learner preview and save a separate local revision. This checkpoint belongs to [#549](https://github.com/deepnative/deep-native-engine/issues/549), claim `DNE-2026-10-27-549-authoring-workshop-root`, based on local commit `84eded806ca8256f7daa9fed5f9605cf86b71631`.

## Two concrete editorial journeys

| Case                                     | Correction and teaching purpose                                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Budget classification · L3-E-P3 / L3-E-X | Change the deliberately faulty budget and room keys from **Contradicted** to **Not given**. Explain that an undecided amount or unchosen room supplies no incompatible fact. Keep known counts, durations and days; do not invent replacements. |
| Simultaneous staffing · L2-E-P / L2-E-X  | Add staffing needed **at the same time** to the worked request, correct choice, explanation and fresh request. Check peak staffing separately from duration and packet allocation. Arithmetic alone does not establish operational feasibility. |

These are original invented practice drafts. The current [Lesson 2](../lessons/02-write-a-useful-request.md) and [Lesson 3](../lessons/03-check-an-answer.md) already contain the corrections; the workshop does not allege those lessons still have its seeded mistakes. The source and affected question are visible before editing. Original v1 remains inspectable, and the comparison shows every changed field.

1. Read the source, exact question, critique and original practice version.
2. Revise the key or wording, related fresh case and revision reason.
3. Select **Preview this draft** and try the learner question. Its feedback uses the draft's actual key and explanation.
4. Compare before/after text and record an explicit source-and-critique self-check.
5. Select **Check this draft**, then **Save local revision**. Reload to restore it, or download the draft and history.

The fixed budget fixture checks its two keys. Free writing is checked by the author: a nonempty explanation is not an automatic semantic grade. Editing a field or reason invalidates the earlier preview, self-check and save readiness. No additional owner approval is part of this routine editorial flow.

## Actual author rehearsal

On 27 October 2026, Codex completed both cases through the browser, saved revision 2 for each, reloaded and downloaded their actual records. All four editable fields and the reason changed in each case. Budget feedback was tried with both the original misconception and the corrected response; the distinct room case was also tried. Staffing's preview used the revised choice and its explanation.

The budget revision explains why no amount or replacement room can be inferred. The staffing revision distinguishes a twelve-person peak from repeated use of the same volunteers in successive activities, then carries the reasoning into the separate six-helper, forty-packet, one-hour source. Both retain unknown arrangements. The saved records include the original, exact revised fields, reason, timestamp and **Author self-check** label. This was an author rehearsal with knowledge of the sources and intended corrections, not independent learner research or an independent review.

## BDD and focused verification

[AUTHOR-001–008](authoring.feature) added eight browser-local scenarios at the workshop checkpoint, preserving the 65 earlier design/local IDs for 73 at that time. The later reader feedback scenarios bring the current package to 77. They do not alter the application's approved journey register or promote broader CREF requirements to application passes.

| Scenario   | Executable behavior in [checks.mjs](checks.mjs)                                                                                                                                      | Broader connection and limit                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| AUTHOR-001 | Source, exact question, critique and original are inspectable before correction.                                                                                                     | CREF-002/006; supplied critique, not a reviewer service.                                |
| AUTHOR-002 | Corrected budget/fresh keys drive feedback; wrong keys and absent reasons cannot pass; save/reload/export retains v1 and v2.                                                         | CREF-002/005; fixed-source validation only.                                             |
| AUTHOR-003 | Staffing request, choice, explanation and fresh example change together in preview/comparison.                                                                                       | CREF-006; free wording remains author-reviewed.                                         |
| AUTHOR-004 | Edits invalidate checks, HTML-looking writing stays literal, unsaved writing warns on leaving; preview-only activity does not.                                                       | Local editing behavior; no automated teaching-quality score.                            |
| AUTHOR-005 | A rejected storage write retains editable/exportable work and allows a later retry without claiming a save.                                                                          | Local save recovery only.                                                               |
| AUTHOR-006 | Malformed and different-fixture records remain unchanged and downloadable.                                                                                                           | Local version protection; no catalog adoption.                                          |
| AUTHOR-007 | Two tabs compare a changed saved record, explicitly retain the working draft on that base, recheck and append v3 while preserving v2. A known conflict cannot be marked ready again. | Local stale-base recovery related to CREF-011; no atomic native multi-user transaction. |
| AUTHOR-008 | Separate cases retain their drafts; existing reader/prototype storage is unchanged.                                                                                                  | Local isolation only; no member-account authorization claim.                            |

Before implementation, all four complete desktop/narrow journeys failed on the missing workshop. After the initial implementation, usability review reproduced missing question context in those four journeys and misleading readiness after a local conflict in a fifth check. Both gaps were fixed. Final focused Chromium run: **12 passed, zero failures, zero retries**, including both journeys at 1360- and 390-pixel widths. Rendered review inspected the desktop layout and the narrow comparison/save/history views. The temporary browser viewport was reset.

Evidence directory: `/Users/tomwu/Documents/Codex/2026-10-27/dne-content-workflows-bdd/authoring-workshop/`.

- `red/`, `first-run/`, `usability-red/`, `final-run/`: retained failures and subsequent results/screenshots.
- `budget-author-revision.json`, `staffing-author-revision.json`: actual browser exports after save and reload, with substantive corrections.
- `static-checks.json`, `verification.json`: reference/ID/source checks and tested-file hashes matched to the local commit.

Run the focused checks with the checkout's Node runtime:

```sh
node assets/docs/learning-design/authoring/checks.mjs http://127.0.0.1:56274/authoring/ /tmp/dne-authoring-checks
```

## Local saves and restart

The existing content-only preview serves `assets/docs/learning-design` on port 56274. Reuse it while live. If it has stopped and the port is free, run this from the repository root to retain the same browser origin:

```sh
python3 -m http.server 56274 --bind 127.0.0.1 --directory assets/docs/learning-design
```

Open `http://localhost:56274/authoring/`; the same server exposes `/reader/` and `/prototype/`. See the [reader instructions](../reader/README.md) for the earlier learning notebook. No database, AI provider or new dependency is used.

Revisions use browser storage under `dne-content-workshop-1:` and fixture version `2026-10-27.1`. Unsaved drafts survive switching cases in the same tab, but only explicitly saved revisions survive reload. Download retains a portable copy; clearing browser data can remove local saves. Host and port matter: `localhost` and `127.0.0.1` have separate storage.

A detected newer local record must be compared and deliberately adopted as the base before saving. Both drafts remain available. Unreadable or different-fixture stored bytes are protected; download that copy and the separate working draft rather than overwriting the record. This prototype has no import, catalog publication, staff roles, account persistence, version retirement or native multi-author locking.

## Next bounded action

Lesson 6's feedback workspace and the full reader's [fifteen-item practice refinement](../practice-refinement.md) are complete locally. This workshop keeps its original fixtures and saved revisions. The [three follow-up dialogues](../study-dialogues.md) are now complete locally. Next content action: the [workflow-improvement contribution under #115](../study-dialogues.md#scope-and-next-action), reusing delivered private proposals. Lead Astra/High; author design/self-review High. Coordinate canonical/publication changes with #97/#114. Production remains parked.
